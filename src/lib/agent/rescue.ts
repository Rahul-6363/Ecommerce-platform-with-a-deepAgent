/**
 * The Proactive Order Rescue Agent.
 *
 * The platform had two lanes: it helped a buyer order, and it adjudicated the
 * complaint when the order went wrong. The gap between them is where the
 * failure actually happens — a parcel going to a tier-3 pincode with no
 * landmark and a COD tag is *visibly* in trouble days before the buyer writes
 * in, and nothing was reaching for it.
 *
 * So this watches live orders and tries to stop the complaint being necessary.
 * It is the second autonomous agent here, and it is deliberately more
 * constrained than the tracker: the tracker escalates *inside* the platform,
 * where being wrong costs nothing, while a rescue touches a courier and
 * sometimes a buyer's phone.
 *
 * Four rules hold it in:
 *
 *  1. **It reuses the engines, it does not re-score.** `assessRescue` composes
 *     `riskScore` and `deliveryForecast`. A second risk implementation that
 *     could disagree with the one on the risk page would make both untrustworthy.
 *  2. **It goes through `callTool`.** Every action, including the reversible
 *     ones, is executed by the registry under the RiskAgent mandate. The gate
 *     and the audit are therefore the same ones every other agent gets, and a
 *     rescue cannot reach a tool the RiskAgent may not hold — which is what
 *     makes "it cannot refund anyone" a property of the code and not a promise.
 *  3. **It is idempotent per action.** `order.rescueActions` records what has
 *     been done, so a second tick never re-asks a buyer a question they are
 *     already looking at. Prevention that repeats itself is harassment.
 *  4. **It stops.** Three attempts, then a person. Risk resolved, then it
 *     stands down and says so.
 *
 * On the courier: there is no courier integration here and this does not
 * pretend otherwise. `reschedule_delivery`, `redirect_to_pickup` and
 * `hold_shipment` write the shipment state change a real courier API would
 * cause, and every event they emit is labelled simulated. The reasoning, the
 * gate and the audit trail are real; the van is not.
 */
import { connectDb } from "@/lib/db/connect";
import { Order, Seller, Shipment, User } from "@/models";
import type { LeanOrder, LeanShipment, LeanUser } from "@/models";
import { riskScore } from "@/lib/engines/risk";
import {
  assessRescue, rescueOutcome, MAX_RESCUE_ATTEMPTS,
  type RescueAssessment,
} from "@/lib/engines/rescue";
import { callTool, type ToolContext } from "@/lib/agent/tools";
import { may } from "@/lib/agent/mandate";
import { emit } from "@/lib/events";
import { now } from "@/lib/clock";
import { sendMail } from "@/lib/mail/mailer";
import { orderStatus } from "@/lib/mail/templates";

/** Orders still in flight — the only ones a rescue can help. */
const RESCUABLE_STATUSES = ["CONFIRMED", "PACKED", "DISPATCHED", "IN_TRANSIT", "OUT_FOR_DELIVERY"];

export type RescueStepResult = {
  action: string;
  /** "executed" for a reversible action, "queued" when it hit the gate. */
  outcome: "executed" | "queued_for_approval" | "refused" | "failed";
  needsApproval: boolean;
  detail: string;
};

export type RescueRun = {
  orderNo: string;
  assessment: RescueAssessment;
  steps: RescueStepResult[];
  /** Risk after the intervention, when one ran and changed anything. */
  after: ReturnType<typeof rescueOutcome> | null;
  /** The order's rescue state after this run. */
  state: string;
  /** True when a person now has to decide. */
  handedOff: boolean;
};

export type RescueSweep = {
  at: string;
  humanPresent: boolean;
  ordersConsidered: number;
  /** Orders the engine judged fine. Reported, because restraint is the feature. */
  declined: number;
  interventions: RescueRun[];
  handoffs: RescueRun[];
};

/**
 * Assess one order and act on it if that is justified.
 *
 * Returns the whole run — assessment, steps, outcome — rather than a boolean,
 * because the operator view and the eval suite both need to see the reasoning
 * and not just the result.
 */
export async function rescueOrder(
  orderNo: string,
  opts: { humanPresent: boolean; brokenTool?: string } = { humanPresent: true },
): Promise<RescueRun> {
  await connectDb();
  const nowAt = await now();

  const order = await Order.findOne({ orderNo }).lean<LeanOrder>();
  if (!order) throw new Error(`No order ${orderNo}`);

  const shipment = await Shipment.findOne({ orderId: order._id }).lean<LeanShipment>();
  const seller = await Seller.findOne({ sellerId: order.items[0]?.sellerId }).lean<{
    fulfilmentSlaDays?: number;
  } | null>();

  const riskOrder = {
    orderNo: order.orderNo,
    paymentMode: order.paymentMode,
    category: order.items[0]?.category,
    buyerPriorRto: order.buyerPriorRto,
    address: order.address,
    promisedBy: order.promisedBy,
    sellerSlaDays: seller?.fulfilmentSlaDays ?? 4,
    status: order.status,
    attemptsMade: order.rescueAttempts ?? 0,
    actionsTaken: order.rescueActions ?? [],
  };
  const riskShipment = {
    shipmentId: shipment?.shipmentId,
    attempts: shipment?.attempts,
    phoneReachable: shipment?.phoneReachable,
  };

  // Pure, and the only place the decision is made.
  const assessment = assessRescue(riskOrder, riskShipment, nowAt);

  await emit({
    type: "rescue.assessed",
    // The engines, not a model. `assessRescue` composes `riskScore` and
    // `deliveryForecast`, both pure — crediting an agent here would claim a
    // model weighed the pincode against the promised date.
    actor: "RiskAgent",
    summary:
      `${order.orderNo}: ${assessment.decision.replace(/_/g, " ").toLowerCase()}` +
      (assessment.triggers.length
        ? ` — ${assessment.triggers.join(", ").toLowerCase().replace(/_/g, " ")}`
        : " — nothing warrants acting") +
      ` (risk ${assessment.risk.score}/100` +
      (assessment.runwayDays !== null ? `, ${assessment.runwayDays}d of runway` : "") +
      ")",
    payload: {
      decision: assessment.decision,
      triggers: assessment.triggers,
      risk: assessment.risk,
      forecast: assessment.forecast,
      runwayDays: assessment.runwayDays,
      reasons: assessment.reasons,
      humanPresent: opts.humanPresent,
      simulatedCourier: true,
    },
    orderId: order._id,
    userId: order.userId,
  });

  /* ── Nothing to do ──────────────────────────────────────────────── */

  if (assessment.decision === "NO_ACTION") {
    // Declining is recorded as its own event. An agent that only logs when it
    // acts looks like one that always acts.
    await emit({
      type: "rescue.declined",
      actor: "RiskAgent",
      summary: `${order.orderNo}: no intervention — ${assessment.reasons[0] ?? "nothing warrants acting"}`,
      payload: { risk: assessment.risk, reasons: assessment.reasons, humanPresent: opts.humanPresent },
      orderId: order._id, userId: order.userId,
    });

    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          rescueState: (order.rescueAttempts ?? 0) > 0 ? "RESOLVED" : "WATCHING",
          rescueLastAt: nowAt,
        },
      },
    );

    return {
      orderNo: order.orderNo,
      assessment,
      steps: [],
      after: null,
      state: (order.rescueAttempts ?? 0) > 0 ? "RESOLVED" : "WATCHING",
      handedOff: false,
    };
  }

  /* ── A person has to decide ─────────────────────────────────────── */

  if (assessment.decision === "HANDOFF") {
    await emit({
      type: "rescue.handoff",
      actor: "RiskAgent",
      summary: `${order.orderNo} handed to a person: ${assessment.handoffReason}`,
      payload: {
        handoffReason: assessment.handoffReason,
        triggers: assessment.triggers,
        risk: assessment.risk,
        forecast: assessment.forecast,
        attemptsMade: order.rescueAttempts ?? 0,
        budget: MAX_RESCUE_ATTEMPTS,
        humanPresent: opts.humanPresent,
      },
      orderId: order._id, userId: order.userId,
    });

    await Order.updateOne(
      { _id: order._id },
      { $set: { rescueState: "HANDOFF", rescueLastAt: nowAt } },
    );

    return {
      orderNo: order.orderNo,
      assessment,
      steps: [],
      after: null,
      state: "HANDOFF",
      handedOff: true,
    };
  }

  /* ── Act, through the registry ──────────────────────────────────── */

  const intervention = assessment.intervention!;
  const steps: RescueStepResult[] = [];

  // The RiskAgent mandate, not a widened one. It holds `reversible_courier`
  // and nothing that moves money, so `issue_refund` would be refused here by
  // the registry even if this code asked for it.
  const ctx: ToolContext = {
    userId: String(order.userId),
    agent: "RiskAgent",
    brokenTool: opts.brokenTool,
  };

  const baseline = assessment.risk;

  const args: Record<string, unknown> = {
    ...intervention.args,
    // The registry's handlers take these names; the engine returns the same
    // values under its own, so they are normalised once here.
    order_no: intervention.args.orderNo ?? order.orderNo,
    shipment_id: intervention.args.shipmentId ?? shipment?.shipmentId,
  };

  // An action this agent may not perform is NOT attempted as a tool call.
  //
  // `chooseIntervention` can propose `ask_buyer` or `convert_cod_to_prepaid`,
  // and both need the `draft` capability that the RiskAgent deliberately does
  // not hold — it scores parcels and does reversible courier work, it does not
  // write to buyers. Calling them anyway produces a mandate refusal, which is
  // the registry working correctly but the wrong outcome to record: the
  // proposal is legitimate and belongs in front of an operator, not in the
  // audit log as an agent overreaching.
  //
  // So a gated proposal is queued for approval directly. The authority model
  // is unchanged — this agent still cannot execute it, and widening the
  // RiskAgent's mandate to cover drafting is exactly what would make the
  // mandate meaningless.
  const mayPerform = may(ctx.agent, intervention.action);

  let outcome: RescueStepResult["outcome"];
  let result: Awaited<ReturnType<typeof callTool>>;

  if (!mayPerform || intervention.needsApproval) {
    outcome = "queued_for_approval";
    result = {
      ok: false,
      code: "pending_approval",
      error:
        `${intervention.action} needs an operator: the RiskAgent may not perform it, ` +
        "and it has been queued with the reasoning attached",
    };

    // Recorded on the same stream and with the same event type the registry
    // uses for the gate, so the operator queue is one list however a request
    // arrived at it.
    await emit({
      type: "claim.approval_requested",
      actor: ctx.agent,
      summary:
        `${intervention.action} on ${order.orderNo} requires operator approval and is waiting at the gate`,
      payload: {
        tool: intervention.action,
        args,
        orderNo: order.orderNo,
        expectedEffect: intervention.expectedEffect,
        triggers: assessment.triggers,
        withinMandate: mayPerform,
      },
      orderId: order._id,
      userId: order.userId,
    });
  } else {
    result = await callTool(intervention.action, args, ctx);

    if (result.ok) {
      outcome = "executed";
    } else if (result.code === "pending_approval") {
      outcome = "queued_for_approval";
    } else if (result.code === "refused") {
      outcome = "refused";
    } else {
      outcome = "failed";
    }
  }

  steps.push({
    action: intervention.action,
    outcome,
    needsApproval: intervention.needsApproval,
    detail: result.ok ? intervention.expectedEffect : result.error,
  });

  await emit({
    type: outcome === "executed" ? "rescue.intervened" : "rescue.queued",
    actor: "RiskAgent",
    summary:
      outcome === "executed"
        ? `${order.orderNo}: ${intervention.action} executed (simulated courier) — ${intervention.expectedEffect}`
        : outcome === "queued_for_approval"
          ? `${order.orderNo}: ${intervention.action} queued for operator approval — the agent may not do this alone`
          : `${order.orderNo}: ${intervention.action} ${outcome} — ${result.ok ? "" : result.error}`,
    payload: {
      action: intervention.action,
      outcome,
      needsApproval: intervention.needsApproval,
      expectedEffect: intervention.expectedEffect,
      triggers: assessment.triggers,
      contributingFactors: assessment.contributingFactors.slice(0, 4),
      humanPresent: opts.humanPresent,
      // Stated on every courier action, so no reader can mistake this for a
      // real dispatch instruction having been sent.
      simulatedCourier: true,
    },
    orderId: order._id, userId: order.userId,
  });

  /* ── Re-score: did it help? ─────────────────────────────────────── */

  let after: ReturnType<typeof rescueOutcome> | null = null;

  if (outcome === "executed") {
    // Re-read the shipment: the courier tool just changed it.
    const fresh = await Shipment.findOne({ orderId: order._id }).lean<LeanShipment>();
    const rescored = riskScore(riskOrder, {
      shipmentId: fresh?.shipmentId,
      attempts: fresh?.attempts,
      phoneReachable: fresh?.phoneReachable,
    });

    after = rescueOutcome(baseline, rescored);

    await emit({
      type: "rescue.rescored",
      actor: "RiskAgent",
      summary: `${order.orderNo} after ${intervention.action}: ${after.sentence}`,
      payload: {
        before: baseline, after: rescored, outcome: after,
        humanPresent: opts.humanPresent,
      },
      orderId: order._id, userId: order.userId,
    });

    if (fresh) {
      await Shipment.updateOne(
        { _id: fresh._id },
        { $set: { riskScore: rescored.score, riskBand: rescored.band } },
      );
    }

    // Tell the buyer what changed, but only for something they would notice.
    // A hold or a pickup redirect changes where they must go; a reschedule
    // changes when they must be in. Staying silent about either is how a
    // "helpful" intervention becomes a missed parcel.
    if (intervention.action === "redirect_to_pickup" || intervention.action === "reschedule_delivery") {
      const buyer = await User.findById(order.userId).lean<LeanUser>();
      if (buyer) {
        const mail = orderStatus({
          name: buyer.name,
          orderNo: order.orderNo,
          status: order.status,
          headline:
            intervention.action === "redirect_to_pickup"
              ? "We have moved your parcel to a pickup point"
              : "We have rescheduled your delivery",
          detail:
            `${intervention.expectedEffect}. ` +
            "We did this because the delivery was at risk of failing, and this was the " +
            "reversible option that did not need you to do anything first. Reply if it " +
            "does not suit you and we will change it back.",
          promisedBy: new Date(order.promisedBy),
        });
        await sendMail({
          to: buyer.email, subject: mail.subject, html: mail.html,
          template: "rescue_notice", orderId: String(order._id),
        });
      }
    }
  }

  // A tool that failed or was refused prevented nothing, so the order must not
  // be recorded as rescued. It goes to a person — and a refusal especially,
  // because that means the agent reached for something outside its mandate and
  // the registry stopped it, which is a bug worth a human seeing.
  const actionFailed = outcome === "failed" || outcome === "refused";

  if (actionFailed) {
    await emit({
      type: "rescue.handoff",
      actor: "RiskAgent",
      summary:
        `${order.orderNo} handed to a person: ${intervention.action} ${outcome} ` +
        `(${result.ok ? "" : result.error}) — the parcel is still at risk and no ` +
        "automated action succeeded",
      payload: {
        action: intervention.action,
        outcome,
        error: result.ok ? "" : result.error,
        triggers: assessment.triggers,
        risk: baseline,
        humanPresent: opts.humanPresent,
      },
      orderId: order._id, userId: order.userId,
    });
  }

  const state = actionFailed
    ? "HANDOFF"
    : outcome === "queued_for_approval"
      ? "AWAITING_APPROVAL"
      : after?.resolved
        ? "RESOLVED"
        : "INTERVENED";

  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        rescueState: state,
        rescueLastAt: nowAt,
        ...(order.rescueBaselineScore === null ? { rescueBaselineScore: baseline.score } : {}),
      },
      $inc: { rescueAttempts: 1 },
      // Recorded when it executed or queued: a question waiting at the gate
      // must not be asked again on the next tick either. NOT recorded when the
      // tool failed — that action never happened, and marking it done would
      // stop the agent ever retrying it once the tool recovers.
      ...(actionFailed ? {} : { $addToSet: { rescueActions: intervention.action } }),
    },
  );

  return { orderNo: order.orderNo, assessment, steps, after, state, handedOff: actionFailed };
}

/**
 * One sweep over every order a rescue could help.
 *
 * Called from the watcher tick, so it runs on the same simulated clock that
 * makes the rest of the autonomy demonstrable, and from the desk so an
 * operator can run it on demand.
 */
export async function rescueSweep(
  opts: { humanPresent: boolean; limit?: number; brokenTool?: string } = { humanPresent: true },
): Promise<RescueSweep> {
  await connectDb();
  const nowAt = await now();

  const orders = await Order.find({ status: { $in: RESCUABLE_STATUSES } })
    .sort({ promisedBy: 1 })
    .limit(Math.max(1, Math.trunc(opts.limit ?? 25)))
    .lean<LeanOrder[]>();

  const sweep: RescueSweep = {
    at: nowAt.toISOString(),
    humanPresent: opts.humanPresent,
    ordersConsidered: orders.length,
    declined: 0,
    interventions: [],
    handoffs: [],
  };

  for (const o of orders) {
    // One order failing must not abort the sweep: the next order is somebody
    // else's parcel.
    try {
      const run = await rescueOrder(o.orderNo, {
        humanPresent: opts.humanPresent,
        brokenTool: opts.brokenTool,
      });

      if (run.handedOff) sweep.handoffs.push(run);
      else if (run.steps.length > 0) sweep.interventions.push(run);
      else sweep.declined += 1;
    } catch (err) {
      await emit({
        type: "rescue.handoff",
        actor: "RiskAgent",
        summary: `${o.orderNo}: rescue failed and was abandoned — ${err instanceof Error ? err.message : String(err)}`,
        payload: { orderNo: o.orderNo, error: String(err), humanPresent: opts.humanPresent },
        orderId: o._id, userId: o.userId,
      });
    }
  }

  await emit({
    type: "rescue.swept",
    actor: "RiskAgent",
    summary:
      `Rescue sweep: ${sweep.ordersConsidered} orders considered, ` +
      `${sweep.interventions.length} intervened, ${sweep.handoffs.length} handed off, ` +
      `${sweep.declined} left alone` +
      (opts.humanPresent ? "" : " — with nobody at a keyboard"),
    payload: {
      ordersConsidered: sweep.ordersConsidered,
      intervened: sweep.interventions.length,
      handedOff: sweep.handoffs.length,
      declined: sweep.declined,
      humanPresent: opts.humanPresent,
      simulatedCourier: true,
    },
  });

  return sweep;
}

/** Every order the rescue agent is currently holding open, for the desk. */
export async function rescueQueue(): Promise<
  {
    orderNo: string;
    rescueState: string;
    rescueAttempts: number;
    rescueActions: string[];
    riskScore: number | null;
    riskBand: string | null;
    promisedBy: Date;
    status: string;
  }[]
> {
  await connectDb();

  const orders = await Order.find({
    rescueState: { $in: ["WATCHING", "INTERVENED", "AWAITING_APPROVAL", "HANDOFF"] },
  })
    .sort({ rescueLastAt: -1 })
    .limit(50)
    .lean<LeanOrder[]>();

  const out = [];
  for (const o of orders) {
    const s = await Shipment.findOne({ orderId: o._id }).lean<LeanShipment>();
    out.push({
      orderNo: o.orderNo,
      rescueState: o.rescueState ?? "NONE",
      rescueAttempts: o.rescueAttempts ?? 0,
      rescueActions: o.rescueActions ?? [],
      riskScore: s?.riskScore ?? null,
      riskBand: s?.riskBand ?? null,
      promisedBy: o.promisedBy,
      status: o.status,
    });
  }
  return out;
}
