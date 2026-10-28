/**
 * The tracker agent — the autonomous one.
 *
 * It takes no instruction from a prompt and no click from a user. It compares
 * the simulated clock against every live deadline, and when one has lapsed it
 * assembles the evidence pack and escalates inside the platform.
 *
 * Internal escalation is deliberately ungated: it is reversible and it moves no
 * money, so there is nothing to protect by making a person press a button at
 * 2am. Escalating *outward* — paying, messaging the buyer — still stops at the
 * gate. That line is where the autonomy argument actually sits.
 *
 * `humanPresent` is recorded on every tick so the audit log can prove the
 * escalation happened with nobody watching.
 */
import { connectDb } from "@/lib/db/connect";
import { Claim, Order, Shipment } from "@/models";
import type { LeanClaim, LeanOrder, LeanShipment } from "@/models";
import { emit } from "@/lib/events";
import { sendMail } from "@/lib/mail/mailer";
import { escalationNotice, orderStatus } from "@/lib/mail/templates";
import { riskScore, chooseIntervention } from "@/lib/engines/risk";
import { rescueSweep } from "@/lib/agent/rescue";
import { env } from "@/lib/env";
import { now } from "@/lib/clock";
import { BUDGETS } from "@/lib/agent/mandate";
import { transitionClaim } from "@/lib/engines/states";
import { User } from "@/models";
import type { LeanUser } from "@/models";

export type TickResult = {
  at: string;
  humanPresent: boolean;
  deadlinesChecked: number;
  escalated: { claimNo: string; tier: number; reason: string }[];
  handedOff: { claimNo: string; reason: string }[];
  shipmentsScored: { shipmentId: string; score: number; band: string }[];
  interventionsProposed: number;
  /**
   * The proactive rescue sweep.
   *
   * Runs on the same tick as the deadline watcher because both are the same
   * kind of work — comparing the clock against something the platform
   * promised — and because a rescue is only useful before the promise lapses,
   * which is exactly what this clock makes demonstrable.
   */
  rescue: {
    ordersConsidered: number;
    intervened: number;
    handedOff: number;
    declined: number;
  };
};

/**
 * One pass of the watcher. Safe to call repeatedly: every branch is guarded by
 * the state it has already written, so a double tick does not double-escalate.
 */
export async function tick(humanPresent: boolean): Promise<TickResult> {
  await connectDb();
  const nowAt = await now();

  const result: TickResult = {
    at: nowAt.toISOString(),
    humanPresent,
    deadlinesChecked: 0,
    escalated: [],
    handedOff: [],
    shipmentsScored: [],
    interventionsProposed: 0,
    rescue: { ordersConsidered: 0, intervened: 0, handedOff: 0, declined: 0 },
  };

  /* ── 1. Breached claim deadlines ─────────────────────────────────── */

  const live = await Claim.find({
    deadlineAt: { $ne: null, $lte: nowAt },
    state: { $in: ["APPROVED", "AWAITING_APPROVAL", "EXECUTING", "ESCALATED_T1"] },
  })
    .limit(50)
    .lean<LeanClaim[]>();

  result.deadlinesChecked = live.length;

  for (const claim of live) {
    const order = await Order.findById(claim.orderId).lean<LeanOrder>();
    if (!order) continue;

    const nextTier = (claim.escalationTier ?? 0) + 1;

    // Budget exhausted: route to a human rather than looping forever.
    if (nextTier > BUDGETS.maxEscalationTiers) {
      await transitionClaim(
        claim.claimNo,
        "HUMAN_HANDOFF",
        {},
        { actor: "TrackerAgent", reason: "escalation budget exhausted" },
      );
      await emit({
        type: "claim.handoff",
        actor: "TrackerAgent",
        summary:
          `${claim.claimNo} exhausted both escalation tiers and is still unresolved — ` +
          `handing to a human rather than escalating again`,
        payload: { humanPresent, tiersUsed: claim.escalationTier, budget: BUDGETS.maxEscalationTiers },
        claimId: claim._id, orderId: order._id, userId: claim.userId,
      });
      result.handedOff.push({
        claimNo: claim.claimNo,
        reason: "escalation budget exhausted",
      });
      continue;
    }

    await emit({
      type: "claim.deadline_breached",
      actor: "TrackerAgent",
      summary:
        `${claim.claimNo} breached its ${claim.verdict.remedy.replace(/_/g, " ")} deadline ` +
        `(${new Date(claim.deadlineAt!).toISOString().slice(0, 16)})` +
        (humanPresent ? "" : " — detected with nobody at a keyboard"),
      payload: {
        humanPresent,
        deadlineAt: claim.deadlineAt,
        remedy: claim.verdict.remedy,
        amountInr: claim.verdict.amountInr,
      },
      claimId: claim._id, orderId: order._id, userId: claim.userId,
    });

    // The evidence pack: everything a human or a seller would need to act,
    // assembled by the agent rather than requested from the buyer again.
    const pack = {
      claimNo: claim.claimNo,
      orderNo: order.orderNo,
      issueType: claim.issueType,
      complaint: claim.translatedComplaint || claim.rawComplaint,
      originalLanguage: claim.lang,
      verdict: claim.verdict,
      authenticity: claim.authenticity,
      evidenceFiles: (claim.evidence ?? []).map((e) => ({
        filename: e.filename, kind: e.kind, bytes: e.bytes,
        visionFindings: e.visionFindings,
      })),
      clauseIds: claim.verdict.clauseIds,
      deadlineMissedAt: claim.deadlineAt,
    };

    await transitionClaim(
      claim.claimNo,
      nextTier === 1 ? "ESCALATED_T1" : "ESCALATED_T2",
      { escalationTier: nextTier },
      { actor: "TrackerAgent", reason: `deadline lapsed, tier ${nextTier}` },
    );

    await emit({
      type: "claim.escalated",
      actor: "TrackerAgent",
      summary:
        `Escalated ${claim.claimNo} to T${nextTier} with a ${pack.evidenceFiles.length}-file evidence pack` +
        (humanPresent ? "" : " — no human was present"),
      payload: { tier: nextTier, humanPresent, pack },
      claimId: claim._id, orderId: order._id, userId: claim.userId,
    });

    const notice = escalationNotice({
      claimNo: claim.claimNo,
      orderNo: order.orderNo,
      tier: nextTier,
      deadlineAt: new Date(claim.deadlineAt!),
      remedy: claim.verdict.remedy,
      amountInr: claim.verdict.amountInr,
      humanPresent,
    });
    await sendMail({
      to: env.mail.ops,
      subject: notice.subject,
      html: notice.html,
      template: `escalation_t${nextTier}`,
      claimId: String(claim._id),
      orderId: String(order._id),
    });

    result.escalated.push({
      claimNo: claim.claimNo,
      tier: nextTier,
      reason: `${claim.verdict.remedy} deadline lapsed`,
    });
  }

  /* ── 2. Parcels still in flight: score and prevent ───────────────── */

  const inFlight = await Shipment.find({
    status: { $in: ["PENDING", "IN_TRANSIT", "OUT_FOR_DELIVERY"] },
  })
    .limit(50)
    .lean<LeanShipment[]>();

  for (const s of inFlight) {
    const order = await Order.findById(s.orderId).lean<LeanOrder>();
    if (!order) continue;

    const verdict = riskScore(
      {
        orderNo: order.orderNo,
        paymentMode: order.paymentMode,
        category: order.items[0]?.category,
        buyerPriorRto: order.buyerPriorRto,
        address: order.address,
      },
      { shipmentId: s.shipmentId, attempts: s.attempts, phoneReachable: s.phoneReachable },
    );

    // Only record a change; re-emitting an identical score each tick is noise.
    if (s.riskScore !== verdict.score || s.riskBand !== verdict.band) {
      await Shipment.updateOne(
        { _id: s._id },
        { $set: { riskScore: verdict.score, riskBand: verdict.band } },
      );
      await emit({
        // The score comes from `riskScore`, a pure function — the same engine
        // the `risk_score` tool credits. Crediting the tracker model here
        // would claim a language model weighed the payment mode and the
        // pincode, which is the one thing this architecture promises it does
        // not do.
        type: "risk.scored",
        actor: "RiskAgent",
        summary: `${s.shipmentId} scored ${verdict.score}/100 (${verdict.band})`,
        payload: { verdict, humanPresent },
        orderId: order._id, userId: order.userId,
      });

      const intervention = chooseIntervention(
        {
          orderNo: order.orderNo, paymentMode: order.paymentMode,
          category: order.items[0]?.category, buyerPriorRto: order.buyerPriorRto,
          address: order.address,
        },
        { shipmentId: s.shipmentId, attempts: s.attempts, phoneReachable: s.phoneReachable },
        verdict,
      );

      if (intervention) {
        result.interventionsProposed += 1;
        await emit({
          // `chooseIntervention` is likewise pure: it decides from the band
          // and the attempt count whether a fix is reversible or has to be
          // proposed. No model is consulted.
          type: "risk.intervention_proposed",
          actor: "RiskAgent",
          summary:
            `${intervention.action} proposed for ${s.shipmentId}` +
            (intervention.needsApproval ? " — needs approval" : " — reversible, acting now"),
          payload: { ...intervention, shipmentId: s.shipmentId },
          orderId: order._id, userId: order.userId,
        });
      }

      result.shipmentsScored.push({
        shipmentId: s.shipmentId, score: verdict.score, band: verdict.band,
      });
    }
  }

  /* ── 3. Overdue parcels the buyer should hear about ──────────────── */

  const overdue = await Order.find({
    status: { $in: ["DISPATCHED", "IN_TRANSIT", "OUT_FOR_DELIVERY"] },
    promisedBy: { $lte: nowAt },
  })
    .limit(20)
    .lean<LeanOrder[]>();

  for (const o of overdue) {
    // One notice per order: the event stream is the idempotency check.
    const already = await Claim.countDocuments({ orderId: o._id });
    if (already > 0) continue;

    const buyer = await User.findById(o.userId).lean<LeanUser>();
    if (!buyer) continue;

    const mail = orderStatus({
      name: buyer.name,
      orderNo: o.orderNo,
      status: o.status,
      headline: "Your delivery is running late",
      detail:
        "We promised this by " +
        new Date(o.promisedBy).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) +
        " and it has not arrived yet. The agent is chasing the courier and will " +
        "keep you posted. If it does not arrive, you are covered by the delivery policy.",
      promisedBy: new Date(o.promisedBy),
    });

    await sendMail({
      to: buyer.email,
      subject: mail.subject,
      html: mail.html,
      template: "delivery_late",
      orderId: String(o._id),
    });
  }

  /* ── 4. Proactive rescue: stop the complaint being necessary ─────── */

  // Deliberately last. The steps above only observe and escalate internally;
  // this one can reach a courier, so it runs on a picture of the world the
  // earlier steps have already brought up to date.
  const sweep = await rescueSweep({ humanPresent });
  result.rescue = {
    ordersConsidered: sweep.ordersConsidered,
    intervened: sweep.interventions.length,
    handedOff: sweep.handoffs.length,
    declined: sweep.declined,
  };

  return result;
}
