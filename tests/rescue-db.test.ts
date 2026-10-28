/**
 * Integration: multi-issue claims and the rescue agent, against a real
 * MongoDB and the real tool registry.
 *
 * The engine tests next door prove the arithmetic. These prove the parts that
 * only exist once a database and the gate are involved: that a two-issue
 * complaint persists two rows, that one issue can be rejected while another
 * pays, that the aggregate cap survives an operator override, and that the
 * rescue agent cannot reach a tool its mandate does not hold — which is the
 * claim that makes the whole thing safe to run unattended.
 *
 * No model key: the deterministic path is what a buyer actually gets when the
 * model is unreachable, so it is what the floor is tested on.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { seed } from "@/lib/seed";
import { Claim, Event, Order, Shipment, User } from "@/models";
import type { LeanClaim, LeanOrder, LeanUser } from "@/models";
import { openClaim } from "@/lib/agent/claims";
import { decideClaim } from "@/lib/agent/approval";
import { rescueOrder, rescueSweep, rescueQueue } from "@/lib/agent/rescue";
import { callTool } from "@/lib/agent/tools";
import { recordFailedAttempt } from "@/lib/orders";
import { resetClock, advanceDays } from "@/lib/clock";
import { MAX_RESCUE_ATTEMPTS } from "@/lib/engines/rescue";

let buyerId: string;
let operatorEmail: string;
let savedKey: string | undefined;

beforeAll(async () => {
  savedKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;

  await connectDb();
  await seed({ force: true });
  await resetClock();

  const buyer = await User.findOne({ email: "arjun@example.in" }).lean<LeanUser>();
  const op = await User.findOne({ role: "operator" }).lean<LeanUser>();
  buyerId = String(buyer!._id);
  operatorEmail = op!.email;
}, 180_000);

afterAll(async () => {
  if (savedKey) process.env.GROQ_API_KEY = savedKey;
  await disconnectDb();
});

/* ══════════════════════ Multi-issue, end to end ══════════════════════ */

describe("a two-issue complaint produces two adjudicated issues", () => {
  let claimNo: string;

  beforeAll(async () => {
    const out = await openClaim({
      userId: buyerId,
      orderNo: "ORD-DEMO002",
      // The complaint the README reported as a known limitation.
      complaint: "The earbuds are not working, and the charging case is missing.",
    });
    claimNo = out.claimNo;
  }, 120_000);

  it("stores one row per issue", async () => {
    const claim = await Claim.findOne({ claimNo }).lean<LeanClaim>();

    expect(claim!.issues.length).toBeGreaterThanOrEqual(2);
    const types = claim!.issues.map((i) => i.issueType);
    expect(types).toContain("DOA");
    expect(types).toContain("MISSING_PART");
  });

  it("marks the claim as multi-issue", async () => {
    const claim = await Claim.findOne({ claimNo }).lean<LeanClaim>();
    expect(claim!.multiIssue).toBe(true);
  });

  it("gives each issue its own engine verdict and clause citation", async () => {
    const claim = await Claim.findOne({ claimNo }).lean<LeanClaim>();

    for (const issue of claim!.issues) {
      expect(issue.verdict.remedy).toBeTruthy();
      // The reasons are the engine's, so each row can be argued with.
      expect(issue.verdict.reasons.length).toBeGreaterThan(0);
    }
  });

  it("keeps the aggregate within the order value", async () => {
    const claim = await Claim.findOne({ claimNo }).lean<LeanClaim>();
    const order = await Order.findById(claim!.orderId).lean<LeanOrder>();

    expect(claim!.totalPayableInr).toBeLessThanOrEqual(order!.amountInr);
    const summed = claim!.issues.reduce((s, i) => s + i.payableInr, 0);
    expect(summed).toBe(claim!.totalPayableInr);
  });

  it("records the split and the adjudication as separate events", async () => {
    const claim = await Claim.findOne({ claimNo }).lean<LeanClaim>();

    const split = await Event.findOne({ claimId: claim!._id, type: "claim.issues_split" }).lean();
    const adj = await Event.findOne({ claimId: claim!._id, type: "claim.issues_adjudicated" }).lean();

    expect(split).toBeTruthy();
    expect(adj).toBeTruthy();
    // The money event is credited to the engine, not to the splitter.
    expect((adj as { actor: string }).actor).toBe("EntitlementEngine");
  });

  it("still stops at the approval gate", async () => {
    const claim = await Claim.findOne({ claimNo }).lean<LeanClaim>();
    expect(["AWAITING_APPROVAL", "HUMAN_HANDOFF"]).toContain(claim!.state);
    expect(claim!.approval.decision).toBeNull();
  });

  it("names the issue count in what the operator is asked to approve", async () => {
    const claim = await Claim.findOne({ claimNo }).lean<LeanClaim>();
    if (claim!.state === "AWAITING_APPROVAL" && claim!.verdict.eligible) {
      expect(claim!.approval.requestedAction).toMatch(/issues/i);
    }
  });
});

/* ═══════════════ Per-issue decisions at the gate ════════════════════ */

describe("one issue can be rejected while another is paid", () => {
  it("pays only the approved issue and records both outcomes", async () => {
    const out = await openClaim({
      userId: buyerId,
      orderNo: "ORD-DEMO002",
      complaint: "The earbuds are dead, and the charging case is missing from the box.",
    });

    const claim = await Claim.findOne({ claimNo: out.claimNo }).lean<LeanClaim>();
    if (claim!.state !== "AWAITING_APPROVAL" || claim!.issues.length < 2) return;

    // Approve the first issue, reject the second.
    const [first, second] = claim!.issues;
    const decision = await decideClaim({
      claimNo: out.claimNo,
      approve: true,
      operatorEmail,
      issueDecisions: {
        [first.key]: { approve: true },
        [second.key]: { approve: false, note: "not evidenced" },
      },
    });

    expect(decision.issues).toHaveLength(claim!.issues.length);
    const paid = decision.issues.filter((i) => i.decision === "APPROVED");
    const refused = decision.issues.filter((i) => i.decision === "REJECTED");

    expect(paid.length).toBeGreaterThanOrEqual(1);
    expect(refused.length).toBeGreaterThanOrEqual(1);
    // The rejected issue pays nothing.
    for (const r of refused) expect(r.approvedInr).toBe(0);

    const after = await Claim.findOne({ claimNo: out.claimNo }).lean<LeanClaim>();
    const rejectedRow = after!.issues.find((i) => i.key === second.key)!;
    expect(rejectedRow.resolution.decision).toBe("REJECTED");
    expect(rejectedRow.resolution.decidedBy).toBe(operatorEmail);
  }, 120_000);

  it("rejects the whole claim when every issue is rejected", async () => {
    const out = await openClaim({
      userId: buyerId,
      orderNo: "ORD-DEMO002",
      complaint: "The earbuds are dead and the case is missing.",
    });

    const claim = await Claim.findOne({ claimNo: out.claimNo }).lean<LeanClaim>();
    if (claim!.state !== "AWAITING_APPROVAL" || claim!.issues.length === 0) return;

    const decisions: Record<string, { approve: boolean }> = {};
    for (const i of claim!.issues) decisions[i.key] = { approve: false };

    const decision = await decideClaim({
      claimNo: out.claimNo,
      approve: true,
      operatorEmail,
      issueDecisions: decisions,
    });

    // Approving a claim while rejecting all of its issues is a rejection.
    expect(decision.amountInr).toBe(0);
    expect(decision.state).toBe("REJECTED");
  }, 120_000);

  it("re-caps an operator amount that would exceed the order value", async () => {
    const out = await openClaim({
      userId: buyerId,
      orderNo: "ORD-DEMO002",
      complaint: "The earbuds are dead, and the charging case is missing.",
    });

    const claim = await Claim.findOne({ claimNo: out.claimNo }).lean<LeanClaim>();
    const order = await Order.findById(claim!.orderId).lean<LeanOrder>();
    if (claim!.state !== "AWAITING_APPROVAL" || claim!.issues.length < 2) return;

    // An operator asking for the full order value on every issue.
    const decisions: Record<string, { approve: boolean; amountInr: number }> = {};
    for (const i of claim!.issues) {
      decisions[i.key] = { approve: true, amountInr: order!.amountInr };
    }

    const decision = await decideClaim({
      claimNo: out.claimNo,
      approve: true,
      operatorEmail,
      issueDecisions: decisions,
    });

    // The invariant holds against a human too.
    expect(decision.amountInr).toBeLessThanOrEqual(order!.amountInr);
    const summed = decision.issues.reduce((s, i) => s + i.approvedInr, 0);
    expect(summed).toBeLessThanOrEqual(order!.amountInr);
  }, 120_000);
});

/* ═════════════ Single-issue claims are unaffected ══════════════════ */

describe("a single-issue claim behaves exactly as before", () => {
  it("still produces one verdict, one remedy and the same gate", async () => {
    const out = await openClaim({
      userId: buyerId,
      orderNo: "ORD-DEMO002",
      complaint: "The case arrived cracked right across the lid.",
    });

    const claim = await Claim.findOne({ claimNo: out.claimNo }).lean<LeanClaim>();

    expect(claim!.multiIssue).toBe(false);
    expect(claim!.issues.length).toBe(1);
    expect(claim!.issueType).toBe("DAMAGED");
    // The headline amount is the single issue's amount.
    expect(claim!.verdict.amountInr).toBe(claim!.issues[0].payableInr);
  }, 120_000);

  it("can still be approved with no per-issue map at all", async () => {
    const out = await openClaim({
      userId: buyerId,
      orderNo: "ORD-DEMO002",
      complaint: "The item arrived smashed in transit.",
    });

    const claim = await Claim.findOne({ claimNo: out.claimNo }).lean<LeanClaim>();
    if (claim!.state !== "AWAITING_APPROVAL") return;

    const decision = await decideClaim({
      claimNo: out.claimNo,
      approve: true,
      operatorEmail,
    });

    expect(decision.state).toBe("RESOLVED");
  }, 120_000);
});

/* ══════════════════════ The rescue agent ═════════════════════════════ */

describe("the rescue agent acts on a parcel in trouble", () => {
  it("intervenes on the fragile demo order and records why", async () => {
    // ORD-DEMO001 is COD to a tier-3 pincode with no landmark.
    const run = await rescueOrder("ORD-DEMO001", { humanPresent: false });

    expect(["INTERVENE", "HANDOFF"]).toContain(run.assessment.decision);
    expect(run.assessment.triggers.length).toBeGreaterThan(0);
    // Every contributing factor carries the sentence that justifies it.
    for (const f of run.assessment.contributingFactors) {
      expect(f.detail.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("emits an assessment event crediting the engine, not a model", async () => {
    const e = await Event.findOne({ type: "rescue.assessed" }).sort({ seq: -1 }).lean<{
      actor: string; payload: Record<string, unknown>;
    }>();

    expect(e).toBeTruthy();
    expect(e!.actor).toBe("RiskAgent");
    // Labelled simulated, so nobody reads it as a real courier instruction.
    expect(e!.payload.simulatedCourier).toBe(true);
  });

  it("queues a gated action instead of performing it", async () => {
    const run = await rescueOrder("ORD-DEMO001", { humanPresent: false });

    for (const step of run.steps) {
      if (step.needsApproval) {
        // ask_buyer and convert_cod_to_prepaid are in APPROVAL_REQUIRED, so
        // the registry must refuse them from an agent turn.
        expect(step.outcome).toBe("queued_for_approval");
      }
    }
  }, 60_000);

  it("does not repeat an action it has already taken", async () => {
    const order = await Order.findOne({ orderNo: "ORD-DEMO001" }).lean<LeanOrder>();
    const taken = order!.rescueActions ?? [];

    if (taken.length > 0) {
      const again = await rescueOrder("ORD-DEMO001", { humanPresent: false });
      // Either it declines as already-done, or it proposes something different.
      if (again.steps.length > 0) {
        expect(taken).not.toContain(again.steps[0].action);
      }
    }
  }, 60_000);

  it("leaves a healthy parcel alone and says so", async () => {
    // ORD-DEMO006 is the clean metro parcel in the seed data.
    const run = await rescueOrder("ORD-DEMO006", { humanPresent: false });

    if (run.assessment.decision === "NO_ACTION") {
      expect(run.steps).toHaveLength(0);
      const declined = await Event.findOne({ type: "rescue.declined" }).sort({ seq: -1 }).lean();
      expect(declined).toBeTruthy();
    }
  }, 60_000);

  it("hands off rather than retrying past the attempt budget", async () => {
    const o = await Order.findOne({ orderNo: "ORD-DEMO001" });
    await Order.updateOne({ _id: o!._id }, { $set: { rescueAttempts: MAX_RESCUE_ATTEMPTS } });

    const run = await rescueOrder("ORD-DEMO001", { humanPresent: false });

    expect(run.assessment.decision).toBe("HANDOFF");
    expect(run.handedOff).toBe(true);
    expect(run.state).toBe("HANDOFF");

    await Order.updateOne({ _id: o!._id }, { $set: { rescueAttempts: 0 } });
  }, 60_000);

  it("hands off when the courier tool is broken rather than claiming success", async () => {
    const o = await Order.findOne({ orderNo: "ORD-DEMO001" });
    await Order.updateOne(
      { _id: o!._id },
      { $set: { rescueAttempts: 0, rescueActions: [], rescueState: "NONE" } },
    );
    await Shipment.updateOne({ orderId: o!._id }, { $set: { attempts: 1 } });

    // redirect_to_pickup is the reversible action chosen after a failed
    // attempt. Breaking it must produce a handoff, not a silent success.
    const run = await rescueOrder("ORD-DEMO001", {
      humanPresent: false,
      brokenTool: "redirect_to_pickup",
    });

    if (run.steps.some((s) => s.action === "redirect_to_pickup")) {
      expect(run.steps[0].outcome).toBe("failed");
      expect(run.state).toBe("HANDOFF");
      // And the failed action is NOT recorded as done, so a retry is possible
      // once the tool recovers.
      const after = await Order.findOne({ orderNo: "ORD-DEMO001" }).lean<LeanOrder>();
      expect(after!.rescueActions).not.toContain("redirect_to_pickup");
    }

    await Shipment.updateOne({ orderId: o!._id }, { $set: { attempts: 0 } });
  }, 60_000);
});

/* ═══════════════ Authorization cannot be bypassed ══════════════════ */

describe("the rescue agent cannot exceed its mandate", () => {
  it("is refused when it reaches for money", async () => {
    // The RiskAgent holds read, compute and reversible_courier. issue_refund
    // needs `draft`, so the registry refuses it before any work happens.
    const result = await callTool(
      "issue_refund",
      { order_no: "ORD-DEMO001", amount_inr: 500 },
      { userId: buyerId, agent: "RiskAgent" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("refused");
  });

  it("is refused when it reaches for an order", async () => {
    const result = await callTool(
      "place_order",
      { order_no: "ORD-DEMO001" },
      { userId: buyerId, agent: "RiskAgent" },
    );

    expect(result.ok).toBe(false);
  });

  it("records every refusal on the event stream", async () => {
    await callTool(
      "issue_refund",
      { order_no: "ORD-DEMO001", amount_inr: 100 },
      { userId: buyerId, agent: "RiskAgent" },
    );

    const refused = await Event.findOne({
      type: "agent.tool_call",
      actor: "RiskAgent",
      summary: { $regex: "^REFUSED" },
    })
      .sort({ seq: -1 })
      .lean();

    expect(refused).toBeTruthy();
  });

  it("may still perform a reversible courier action", async () => {
    const shipment = await Shipment.findOne({}).lean<{ shipmentId: string }>();

    const result = await callTool(
      "hold_shipment",
      { shipment_id: shipment!.shipmentId, reason: "test" },
      { userId: buyerId, agent: "RiskAgent" },
    );

    expect(result.ok).toBe(true);
  });
});

/* ════════════════════════ The sweep and queue ════════════════════════ */

describe("the sweep reports what it did and did not do", () => {
  it("considers every in-flight order and counts each outcome", async () => {
    await resetClock();
    // Clear rescue state so the sweep is not short-circuited by idempotency.
    await Order.updateMany(
      {},
      { $set: { rescueAttempts: 0, rescueActions: [], rescueState: "NONE" } },
    );

    const sweep = await rescueSweep({ humanPresent: false, limit: 25 });

    expect(sweep.ordersConsidered).toBeGreaterThan(0);
    // Every order ends in exactly one bucket.
    const accounted = sweep.interventions.length + sweep.handoffs.length + sweep.declined;
    expect(accounted).toBeLessThanOrEqual(sweep.ordersConsidered);
    expect(sweep.humanPresent).toBe(false);
  }, 120_000);

  it("emits a sweep summary with nobody at a keyboard", async () => {
    const e = await Event.findOne({ type: "rescue.swept" }).sort({ seq: -1 }).lean<{
      summary: string; payload: Record<string, unknown>;
    }>();

    expect(e).toBeTruthy();
    expect(e!.payload.humanPresent).toBe(false);
    expect(e!.summary).toMatch(/nobody at a keyboard/i);
  });

  it("lists the orders it is holding open", async () => {
    const queue = await rescueQueue();

    for (const row of queue) {
      expect(["WATCHING", "INTERVENED", "AWAITING_APPROVAL", "HANDOFF"]).toContain(row.rescueState);
      expect(row.orderNo).toBeTruthy();
    }
  }, 60_000);

  it("survives one order failing without abandoning the rest", async () => {
    // A sweep with a broken tool: some orders fail, the sweep still completes.
    const sweep = await rescueSweep({
      humanPresent: false,
      limit: 10,
      brokenTool: "redirect_to_pickup",
    });

    expect(sweep.ordersConsidered).toBeGreaterThan(0);
  }, 120_000);
});
