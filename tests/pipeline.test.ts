/**
 * End-to-end integration against a real MongoDB (in-process).
 *
 * This walks the whole platform the way a buyer and an operator would: seed,
 * search, cart, order, fulfil, complain, adjudicate, approve. No model key is
 * required — the deterministic paths are exactly what should still work when
 * the model is unavailable, so testing without one is testing the floor.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { seed } from "@/lib/seed";
import { Claim, MailLog, Order, Product, Shipment, User, Event } from "@/models";
import type { LeanClaim, LeanOrder, LeanUser } from "@/models";
import { callTool } from "@/lib/agent/tools";
import { placeOrder, advanceFulfilment, recordFailedAttempt } from "@/lib/orders";
import { openClaim } from "@/lib/agent/claims";
import { decideClaim } from "@/lib/agent/approval";
import { tick } from "@/lib/agent/watcher";
import { advanceTo, resetClock } from "@/lib/clock";

let buyerId: string;
let operatorEmail: string;

let savedKey: string | undefined;

beforeAll(async () => {
  // This suite asserts exact remedies, amounts and states, so it runs on the
  // deterministic path with the model removed. That is deliberate: these
  // tests verify the floor the platform must hold when no model is reachable,
  // and a model in the loop would make the expected values legitimately vary.
  // The live-model behaviour is covered in live-agent.test.ts instead.
  savedKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;

  await connectDb();
  await seed();
  const buyer = await User.findOne({ email: "arjun@example.in" }).lean<LeanUser>();
  const op = await User.findOne({ role: "operator" }).lean<LeanUser>();
  buyerId = String(buyer!._id);
  operatorEmail = op!.email;
}, 120_000);

afterAll(async () => {
  if (savedKey) process.env.GROQ_API_KEY = savedKey;
  await disconnectDb();
});

describe("seed", () => {
  it("builds a catalogue, policies and the demo scenarios", async () => {
    expect(await Product.countDocuments()).toBeGreaterThan(10);
    expect(await Order.countDocuments()).toBe(7);
    expect(await Shipment.countDocuments()).toBe(7);
    expect(await User.countDocuments()).toBe(5);
  });

  it("records the seed on the event stream", async () => {
    const e = await Event.findOne({ type: "system.seeded" }).lean();
    expect(e).toBeTruthy();
  });
});

describe("catalogue retrieval without a model", () => {
  const ctx = { userId: "", agent: "ShoppingAgent" as const };

  it("finds shoes from an English query", async () => {
    const r = await callTool("search_catalogue", { query: "running shoes" }, { ...ctx, userId: buyerId });
    expect(r.ok).toBe(true);
    const d = (r as { data: { results: { title: string }[] } }).data;
    expect(d.results.length).toBeGreaterThan(0);
    expect(d.results.some((x) => /shoe/i.test(x.title))).toBe(true);
  });

  it("finds the same shoes from a transliterated Hindi query", async () => {
    const r = await callTool("search_catalogue", { query: "sasta joota" }, { ...ctx, userId: buyerId });
    const d = (r as { data: { results: { category: string }[] } }).data;
    expect(d.results.length).toBeGreaterThan(0);
    expect(d.results.some((x) => x.category === "footwear")).toBe(true);
  });

  it("finds products from a native-script Kannada query", async () => {
    const r = await callTool("search_catalogue", { query: "ಚಪ್ಪಲಿ" }, { ...ctx, userId: buyerId });
    const d = (r as { data: { results: unknown[] } }).data;
    expect(d.results.length).toBeGreaterThan(0);
  });

  it("respects a budget ceiling", async () => {
    const r = await callTool(
      "search_catalogue",
      { query: "shoes", max_price_inr: 1000 },
      { ...ctx, userId: buyerId },
    );
    const d = (r as { data: { results: { price_inr: number }[] } }).data;
    for (const p of d.results) expect(p.price_inr).toBeLessThanOrEqual(1000);
  });

  it("survives a query containing regex metacharacters", async () => {
    const r = await callTool("search_catalogue", { query: "shoes (*.+[" }, { ...ctx, userId: buyerId });
    expect(r.ok).toBe(true);
  });
});

describe("the mandate and the approval gate", () => {
  it("refuses a tool the calling agent does not hold the capability for", async () => {
    // The verifier may only read, compute and reject. It must not write a cart.
    const r = await callTool(
      "add_to_cart",
      { sku: "VJ-SHOE-101", rationale: "test" },
      { userId: buyerId, agent: "VerifierAgent" },
    );
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("refused");
  });

  it("stops a money-moving tool at the gate instead of running it", async () => {
    const r = await callTool(
      "issue_refund",
      { order_no: "ORD-DEMO002", amount_inr: 2499 },
      { userId: buyerId, agent: "ActionAgent" },
    );
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("pending_approval");
  });

  it("will not let the agent place an order on the buyer's behalf", async () => {
    const r = await callTool("place_order", {}, { userId: buyerId, agent: "ShoppingAgent" });
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("pending_approval");
  });

  it("allows a reversible courier action with no approval", async () => {
    const r = await callTool(
      "redirect_to_pickup",
      { shipment_id: "SHP-DEMO001" },
      { userId: buyerId, agent: "RiskAgent" },
    );
    expect(r.ok).toBe(true);
  });

  it("injected tool failure is reported, not hidden", async () => {
    const r = await callTool(
      "search_catalogue",
      { query: "shoes" },
      { userId: buyerId, agent: "ShoppingAgent", brokenTool: "search_catalogue" },
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/unavailable/);
  });
});

describe("ordering", () => {
  it("places an order from the cart and raises a shipment", async () => {
    await callTool(
      "add_to_cart",
      { sku: "VJ-KITCH-503", qty: 2, rationale: "buyer asked for a 1L flask" },
      { userId: buyerId, agent: "ShoppingAgent" },
    );

    const before = (await Product.findOne({ sku: "VJ-KITCH-503" }).lean())!.stock;
    const result = await placeOrder({ userId: buyerId, paymentMode: "PREPAID" });

    expect(result.orderNo).toMatch(/^ORD-/);
    expect(result.amountInr).toBe(699 * 2);
    expect(result.risk.band).toBeDefined();

    const after = (await Product.findOne({ sku: "VJ-KITCH-503" }).lean())!.stock;
    expect(after).toBe(before - 2); // stock actually decrements

    const order = await Order.findOne({ orderNo: result.orderNo }).lean<LeanOrder>();
    expect(await Shipment.countDocuments({ orderId: order!._id })).toBe(1);
  });

  it("carries delivery instructions onto the order, trimmed and capped", async () => {
    // Free text that reaches a courier label and an email, so the cap is the
    // safety model: an unbounded string from the client would be a way to
    // push arbitrary text into both.
    await callTool(
      "add_to_cart",
      { sku: "VJ-KITCH-503", qty: 1, rationale: "test" },
      { userId: buyerId, agent: "ShoppingAgent" },
    );
    const { orderNo } = await placeOrder({
      userId: buyerId,
      paymentMode: "PREPAID",
      deliveryInstructions: "   Leave with the guard, gate code 4417   ",
    });

    const order = await Order.findOne({ orderNo }).lean<LeanOrder>();
    expect(order!.deliveryInstructions).toBe("Leave with the guard, gate code 4417");

    await callTool(
      "add_to_cart",
      { sku: "VJ-KITCH-503", qty: 1, rationale: "test" },
      { userId: buyerId, agent: "ShoppingAgent" },
    );
    const long = await placeOrder({
      userId: buyerId,
      paymentMode: "PREPAID",
      deliveryInstructions: "x".repeat(900),
    });
    const capped = await Order.findOne({ orderNo: long.orderNo }).lean<LeanOrder>();
    expect(capped!.deliveryInstructions.length).toBe(400);
  });

  it("defaults delivery instructions to empty rather than undefined", async () => {
    // The orders projection sends this straight to the client, and an order
    // placed before the field existed must not read as `undefined` there.
    await callTool(
      "add_to_cart",
      { sku: "VJ-KITCH-503", qty: 1, rationale: "test" },
      { userId: buyerId, agent: "ShoppingAgent" },
    );
    const { orderNo } = await placeOrder({ userId: buyerId, paymentMode: "PREPAID" });
    const order = await Order.findOne({ orderNo }).lean<LeanOrder>();
    expect(order!.deliveryInstructions).toBe("");
  });

  it("refuses to place an empty order", async () => {
    await expect(placeOrder({ userId: buyerId, paymentMode: "PREPAID" })).rejects.toThrow(/empty/i);
  });

  it("walks an order through its delivery lifecycle", async () => {
    await callTool(
      "add_to_cart",
      { sku: "VJ-ELEC-204", qty: 1, rationale: "test" },
      { userId: buyerId, agent: "ShoppingAgent" },
    );
    const { orderNo } = await placeOrder({ userId: buyerId, paymentMode: "PREPAID" });

    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await advanceFulfilment(orderNo);
      seen.push(r.to);
      if (r.to === "DELIVERED") break;
    }
    expect(seen).toEqual([
      "CONFIRMED", "PACKED", "DISPATCHED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED",
    ]);

    const order = await Order.findOne({ orderNo }).lean<LeanOrder>();
    expect(order!.status).toBe("DELIVERED");
    expect(order!.deliveredAt).toBeTruthy();
  });

  it("a failed attempt raises the risk score", async () => {
    const before = (await Shipment.findOne({ shipmentId: "SHP-DEMO001" }).lean())!.riskScore ?? 0;
    await recordFailedAttempt("ORD-DEMO001", false);
    const r = await callTool(
      "risk_score",
      { order_no: "ORD-DEMO001" },
      { userId: buyerId, agent: "RiskAgent" },
    );
    const d = (r as { data: { score: number; band: string } }).data;
    expect(d.score).toBeGreaterThan(before);
    expect(d.band).toBe("HIGH");
  });
});

describe("the complaint pipeline", () => {
  it("adjudicates a genuine in-window claim and stops at the gate", async () => {
    const out = await openClaim({
      userId: buyerId,
      orderNo: "ORD-DEMO002",
      complaint: "The earbuds arrived with a cracked case and the right bud does not work.",
    });

    expect(out.claimNo).toMatch(/^CLM-/);
    expect(out.triage.issueType).toBe("DAMAGED");
    expect(out.verdict.eligible).toBe(true);
    // The money decision came from the engine, not from prose.
    expect(out.verdict.amountInr).toBeLessThanOrEqual(2499);
    expect(out.verdict.clauseIds.length).toBeGreaterThan(0);
    // Nothing executed: it is waiting for a person.
    expect(out.state).toBe("AWAITING_APPROVAL");
    expect(out.draftVerified).toBe(true);
  }, 60_000);

  it("emails the buyer and the operator on intake", async () => {
    const mails = await MailLog.find().sort({ sentAt: -1 }).limit(10).lean();
    const templates = mails.map((m) => m.template);
    expect(templates).toContain("claim_received");
    expect(templates).toContain("operator_approval");
  });

  it("gives an honest, clause-cited no outside the window", async () => {
    const priya = await User.findOne({ email: "priya@example.in" }).lean<LeanUser>();
    const out = await openClaim({
      userId: String(priya!._id),
      orderNo: "ORD-DEMO005",
      complaint: "The bedsheet is torn along the seam.",
    });
    expect(out.verdict.eligible).toBe(false);
    expect(out.verdict.amountInr).toBe(0);
    expect(out.verdict.reasons.join(" ")).toMatch(/window closed/);
  }, 60_000);

  it("routes a courier contradiction to a human instead of guessing", async () => {
    const priya = await User.findOne({ email: "priya@example.in" }).lean<LeanUser>();
    const out = await openClaim({
      userId: String(priya!._id),
      orderNo: "ORD-DEMO004",
      complaint: "I never received this parcel. It never arrived.",
    });
    // The courier recorded DELIVERED; the buyer says otherwise. Both may be
    // honest, so the system refuses to decide.
    expect(out.state).toBe("HUMAN_HANDOFF");
  }, 60_000);

  it("treats a repeat claimant with no evidence as suspicious, but still defers", async () => {
    const murugan = await User.findOne({ email: "murugan@example.in" }).lean<LeanUser>();
    const out = await openClaim({
      userId: String(murugan!._id),
      orderNo: "ORD-DEMO003",
      complaint: "The pressure cooker is completely broken and cracked.",
    });
    expect(out.authenticity.score).toBeGreaterThan(0);
    expect(out.authenticity.signals.length).toBeGreaterThan(0);
    // However suspicious, the engine asks a person — it never rejects a buyer.
    if (out.authenticity.verdict === "LIKELY_FABRICATED") {
      expect(out.state).toBe("HUMAN_HANDOFF");
    }
  }, 60_000);

  it("rejects a claim for an order the buyer does not own", async () => {
    await expect(
      openClaim({ userId: buyerId, orderNo: "ORD-DEMO003", complaint: "broken" }),
    ).rejects.toThrow(/different buyer/i);
  });
});

describe("the approval gate", () => {
  it("executes the remedy and notifies the buyer on approval", async () => {
    const claim = await Claim.findOne({ state: "AWAITING_APPROVAL" }).lean<LeanClaim>();
    expect(claim).toBeTruthy();

    const result = await decideClaim({
      claimNo: claim!.claimNo,
      approve: true,
      operatorEmail,
      note: "Photo clearly shows the damage.",
    });

    expect(result.state).toBe("RESOLVED");
    const after = await Claim.findOne({ claimNo: claim!.claimNo }).lean<LeanClaim>();
    expect(after!.approval.decision).toBe("APPROVED");
    expect(after!.approval.decidedBy).toBe(operatorEmail);
    expect(after!.resolvedAt).toBeTruthy();

    const mail = await MailLog.findOne({ claimId: claim!._id, template: "claim_approved" }).lean();
    expect(mail).toBeTruthy();
  }, 60_000);

  it("will not decide the same claim twice", async () => {
    const claim = await Claim.findOne({ "approval.decision": "APPROVED" }).lean<LeanClaim>();
    await expect(
      decideClaim({ claimNo: claim!.claimNo, approve: true, operatorEmail }),
    ).rejects.toThrow(/already/i);
  });

  it("caps an operator override at the order value", async () => {
    const murugan = await User.findOne({ email: "murugan@example.in" }).lean<LeanUser>();
    const out = await openClaim({
      userId: String(murugan!._id),
      orderNo: "ORD-DEMO003",
      complaint: "The cooker lid gasket is missing from the box.",
    });

    const result = await decideClaim({
      claimNo: out.claimNo,
      approve: true,
      operatorEmail,
      overrideAmountInr: 999_999, // more than the order was ever worth
    });

    const order = await Order.findOne({ orderNo: "ORD-DEMO003" }).lean<LeanOrder>();
    expect(result.amountInr).toBeLessThanOrEqual(order!.amountInr);
    expect(result.overridden).toBe(true);
  }, 60_000);

  it("counts a rejection against the buyer's claim record", async () => {
    const arjun = await User.findOne({ email: "arjun@example.in" }).lean<LeanUser>();
    const before = arjun!.rejectedClaims;

    const out = await openClaim({
      userId: buyerId,
      orderNo: "ORD-DEMO006",
      complaint: "The bottles arrived dented and the lids leak.",
    });
    await decideClaim({
      claimNo: out.claimNo, approve: false, operatorEmail,
      note: "No damage visible in the photographs supplied.",
    });

    const after = await User.findOne({ email: "arjun@example.in" }).lean<LeanUser>();
    expect(after!.rejectedClaims).toBe(before + 1);
  }, 60_000);
});

describe("the autonomous watcher", () => {
  it("escalates a breached deadline with nobody at a keyboard", async () => {
    const murugan = await User.findOne({ email: "murugan@example.in" }).lean<LeanUser>();
    const out = await openClaim({
      userId: String(murugan!._id),
      orderNo: "ORD-DEMO003",
      complaint: "The cooker handle snapped off on first use.",
    });

    // Approve it so there is a live promise with a deadline attached.
    await decideClaim({ claimNo: out.claimNo, approve: true, operatorEmail });
    await Claim.updateOne(
      { claimNo: out.claimNo },
      { $set: { state: "APPROVED", resolvedAt: null } },
    );

    const claim = await Claim.findOne({ claimNo: out.claimNo }).lean<LeanClaim>();
    if (!claim?.deadlineAt) return; // a goods remedy may carry no deadline

    // Move the clock past the deadline, then let the watcher find it.
    await advanceTo(new Date(claim.deadlineAt));
    const result = await tick(false);

    expect(result.humanPresent).toBe(false);
    expect(result.escalated.some((e) => e.claimNo === out.claimNo)).toBe(true);

    const after = await Claim.findOne({ claimNo: out.claimNo }).lean<LeanClaim>();
    expect(after!.escalationTier).toBeGreaterThanOrEqual(1);
    expect(after!.state).toMatch(/ESCALATED_T/);

    await resetClock();
  }, 90_000);

  it("hands off rather than looping once the escalation budget is spent", async () => {
    const claim = await Claim.findOne({ state: /ESCALATED_T/ }).lean<LeanClaim>();
    if (!claim) return;

    await Claim.updateOne(
      { _id: claim._id },
      { $set: { escalationTier: 2, state: "ESCALATED_T1" } },
    );
    await advanceTo(new Date(claim.deadlineAt!));
    const result = await tick(false);

    const after = await Claim.findOne({ _id: claim._id }).lean<LeanClaim>();
    expect(after!.state).toBe("HUMAN_HANDOFF");
    expect(result.handedOff.length).toBeGreaterThan(0);
    await resetClock();
  }, 90_000);
});

describe("the event stream", () => {
  it("gives every event a unique increasing sequence number", async () => {
    const events = await Event.find().sort({ seq: 1 }).lean();
    expect(events.length).toBeGreaterThan(20);
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  it("records the agent that performed each step", async () => {
    const actors = await Event.distinct("actor");
    expect(actors).toContain("TriageAgent");
    expect(actors).toContain("PolicyAgent");
    expect(actors).toContain("FraudAnalyst");
    expect(actors.some((a: string) => a.startsWith("operator:"))).toBe(true);
  });

  it("records refused tool calls, not just successful ones", async () => {
    const refused = await Event.findOne({ summary: /^REFUSED/ }).lean();
    expect(refused).toBeTruthy();
  });
});
