/**
 * Unit tests for the three pure engines.
 *
 * These exist because the engines are where the money decisions live. A test
 * here is the difference between "the model said so" and "we can show you why,
 * and prove it still behaves that way."
 */
import { describe, it, expect } from "vitest";
import {
  checkEntitlement,
  AMBIGUOUS_CONFIDENCE,
  PARTIAL_PCT,
  LATE_CREDIT_CAP,
  type EntitlementPolicy,
} from "@/lib/engines/entitlement";
import { riskScore, chooseIntervention } from "@/lib/engines/risk";
import { assessAuthenticity } from "@/lib/engines/authenticity";
import { keywordTriage, detectScript } from "@/lib/agent/triage";
import { verifyDraft, templateDraft } from "@/lib/agent/verifier";
import { checkGrounding, correctionFor } from "@/lib/agent/grounding";
import { assertClaimTransition, isTerminalClaim } from "@/lib/engines/states";

const NOW = new Date("2026-10-18T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const policy: EntitlementPolicy = {
  returnWindowDays: 7,
  replacementAllowed: true,
  refundSlaDays: 7,
  lateCompensation: true,
  clauses: [
    { id: "VJ-ELEC-2.1", text: "DOA replacement", tags: ["doa", "replacement", "full_refund"] },
    { id: "VJ-ELEC-2.2", text: "Damaged replacement", tags: ["damaged", "replacement", "photo"] },
    { id: "VJ-ELEC-2.4", text: "Missing part", tags: ["missing_part", "part_shipment", "partial_refund"] },
    { id: "VJ-ELEC-3.1", text: "Not delivered", tags: ["not_delivered", "reship", "full_refund", "window"] },
    { id: "VJ-ELEC-4.1", text: "Late credit", tags: ["late", "store_credit"] },
    { id: "VJ-ELEC-1.1", text: "Window", tags: ["window", "return"] },
  ],
};

const order = {
  amountInr: 2499,
  deliveredAt: day(-3),
  promisedBy: day(-5),
  stockAvailable: true,
  buyerPriority: "speed" as const,
};

describe("entitlement engine", () => {
  it("is pure: identical inputs give identical output", () => {
    const a = checkEntitlement(order, policy, "DOA", { stated_fault: true }, NOW);
    const b = checkEntitlement(order, policy, "DOA", { stated_fault: true }, NOW);
    expect(a).toEqual(b);
  });

  it("gives a DOA inside the window a replacement when stock exists", () => {
    const v = checkEntitlement(order, policy, "DOA", { stated_fault: true }, NOW);
    expect(v.eligible).toBe(true);
    expect(v.remedy).toBe("REPLACEMENT");
    expect(v.amountInr).toBe(0); // a goods remedy pays no cash
    expect(v.clauseIds).toContain("VJ-ELEC-2.1");
  });

  it("falls through to a full refund when there is no replacement stock", () => {
    const v = checkEntitlement(
      { ...order, stockAvailable: false }, policy, "DOA", { stated_fault: true }, NOW,
    );
    expect(v.remedy).toBe("FULL_REFUND");
    expect(v.amountInr).toBe(2499);
    expect(v.alternatives.join(" ")).toMatch(/no replacement stock/i);
  });

  it("honours buyer priority when two remedies are feasible", () => {
    const speed = checkEntitlement(order, policy, "DOA", { stated_fault: true }, NOW);
    const money = checkEntitlement(
      { ...order, buyerPriority: "money" }, policy, "DOA", { stated_fault: true }, NOW,
    );
    expect(speed.remedy).toBe("REPLACEMENT");
    expect(money.remedy).toBe("FULL_REFUND");
  });

  it("refuses a claim raised after the window with a cited clause", () => {
    const v = checkEntitlement(
      { ...order, deliveredAt: day(-30) }, policy, "DAMAGED", { photo: true }, NOW,
    );
    expect(v.eligible).toBe(false);
    expect(v.remedy).toBe("NONE");
    expect(v.amountInr).toBe(0);
    expect(v.reasons.join(" ")).toMatch(/after the 7-day window closed/);
  });

  it("doubles the window for a counterfeit claim", () => {
    const inside = checkEntitlement(
      { ...order, deliveredAt: day(-10) }, policy, "COUNTERFEIT", { brand_mismatch: true }, NOW,
    );
    expect(inside.reasons.join(" ")).toMatch(/counterfeit window doubled/);
    const outside = checkEntitlement(
      { ...order, deliveredAt: day(-20) }, policy, "COUNTERFEIT", { brand_mismatch: true }, NOW,
    );
    expect(outside.eligible).toBe(false);
  });

  it("never pays more than the order value", () => {
    for (const issue of ["DOA", "DAMAGED", "COUNTERFEIT", "MISSING_PART", "LATE", "NOT_DELIVERED"]) {
      const v = checkEntitlement(order, policy, issue, { photo: true, stated_fault: true }, NOW);
      expect(v.amountInr).toBeLessThanOrEqual(order.amountInr);
      expect(v.amountInr).toBeGreaterThanOrEqual(0);
    }
  });

  it("computes a partial refund as the declared percentage", () => {
    const v = checkEntitlement(
      { ...order, stockAvailable: false }, policy, "MISSING_PART", { stated_missing: true }, NOW,
    );
    expect(v.remedy).toBe("PARTIAL_REFUND");
    expect(v.amountInr).toBe(Math.round(2499 * PARTIAL_PCT));
  });

  it("caps late store credit", () => {
    const v = checkEntitlement(
      { ...order, amountInr: 50_000, buyerPriority: "money" },
      policy, "LATE", { late_scan: true }, NOW,
    );
    expect(v.remedy).toBe("STORE_CREDIT");
    expect(v.amountInr).toBe(LATE_CREDIT_CAP);
  });

  it("routes to a human rather than guessing when confidence is low", () => {
    const thin: EntitlementPolicy = { ...policy, clauses: [] };
    const v = checkEntitlement(order, thin, "DAMAGED", {}, NOW);
    expect(v.confidence).toBeLessThan(AMBIGUOUS_CONFIDENCE);
    expect(v.remedy).toBe("ESCALATE_AMBIGUOUS");
    expect(v.eligible).toBe(false);
  });

  it("lowers confidence when a photo contradicts the complaint", () => {
    const supports = checkEntitlement(order, policy, "DAMAGED", { photo: true, image_supports_claim: true }, NOW);
    const contradicts = checkEntitlement(order, policy, "DAMAGED", { photo: true, image_contradicts_claim: true }, NOW);
    expect(contradicts.confidence).toBeLessThan(supports.confidence);
  });

  it("escalates an unknown issue type instead of inventing a remedy", () => {
    const v = checkEntitlement(order, policy, "SOMETHING_ELSE", {}, NOW);
    expect(v.remedy).toBe("ESCALATE_AMBIGUOUS");
    expect(v.amountInr).toBe(0);
  });

  it("cannot establish a window with no delivery scan", () => {
    const v = checkEntitlement({ ...order, deliveredAt: null }, policy, "DAMAGED", { photo: true }, NOW);
    expect(v.remedy).toBe("ESCALATE_AMBIGUOUS");
  });

  it("never returns a confidence of 1.0", () => {
    const v = checkEntitlement(
      order, policy, "DAMAGED",
      { photo: true, tracking_corroborates: true, image_supports_claim: true },
      NOW,
    );
    expect(v.confidence).toBeLessThan(1);
  });
});

describe("risk engine", () => {
  const highRisk = {
    orderNo: "ORD-1", paymentMode: "COD", category: "footwear", buyerPriorRto: 1,
    address: { line: "Near water tank", landmark: "", pinTier: 3 },
  };

  it("scores a COD tier-3 parcel with no landmark as HIGH", () => {
    const v = riskScore(highRisk, { shipmentId: "SHP-1", attempts: 0, phoneReachable: true });
    expect(v.band).toBe("HIGH");
    expect(v.score).toBeGreaterThanOrEqual(60);
  });

  it("traces every point to a named factor", () => {
    const v = riskScore(highRisk, { shipmentId: "SHP-1", attempts: 1, phoneReachable: false });
    const total = v.reasons.reduce((s, r) => s + r.points, 0);
    expect(Math.min(total, 100)).toBe(v.score);
    for (const r of v.reasons) expect(r.detail.length).toBeGreaterThan(0);
  });

  it("clamps to 100", () => {
    const v = riskScore(
      { ...highRisk, buyerPriorRto: 9, address: { line: "x", landmark: "", pinTier: 4 } },
      { shipmentId: "SHP-1", attempts: 5, phoneReachable: false },
    );
    expect(v.score).toBe(100);
  });

  it("scores a clean prepaid metro order LOW and proposes nothing", () => {
    const o = {
      orderNo: "ORD-2", paymentMode: "PREPAID", category: "books", buyerPriorRto: 0,
      address: { line: "Flat 402, Brigade Residency, Koramangala", landmark: "Opposite Forum Mall", pinTier: 1 },
    };
    const s = { shipmentId: "SHP-2", attempts: 0, phoneReachable: true };
    const v = riskScore(o, s);
    expect(v.band).toBe("LOW");
    // Declining to act is the behaviour under test, not an absence of one.
    expect(chooseIntervention(o, s, v)).toBeNull();
  });

  it("asks about the address before anything more expensive", () => {
    const s = { shipmentId: "SHP-1", attempts: 0, phoneReachable: true };
    const i = chooseIntervention(highRisk, s, riskScore(highRisk, s));
    expect(i?.action).toBe("ask_buyer");
    expect(i?.needsApproval).toBe(true);
  });

  it("redirects to a pickup point after a failed attempt", () => {
    const o = { ...highRisk, address: { line: "Flat 402, Brigade Residency, Koramangala", landmark: "Opposite Forum", pinTier: 3 } };
    const s = { shipmentId: "SHP-1", attempts: 1, phoneReachable: true };
    const i = chooseIntervention(o, s, riskScore(o, s));
    expect(i?.action).toBe("redirect_to_pickup");
    expect(i?.needsApproval).toBe(false); // reversible, so no gate
  });
});

describe("authenticity engine", () => {
  const base = {
    issueType: "DAMAGED" as const,
    evidenceFlags: {},
    hasImage: true,
    minutesSinceDelivery: 600,
    windowFraction: 0.3,
    orderAmountInr: 2499,
    buyerTotalClaims: 1,
    buyerRejectedClaims: 0,
    buyerOrderCount: 6,
    sellerDefectRatePct: 3,
  };

  it("treats a corroborated claim with a supporting photo as genuine", () => {
    const a = assessAuthenticity({
      ...base,
      evidenceFlags: { image_supports_claim: true, tracking_corroborates: true, photo: true },
    });
    expect(a.verdict).toBe("LIKELY_GENUINE");
    expect(a.reviewRequired).toBe(false);
  });

  it("flags a claim whose photo contradicts it", () => {
    const a = assessAuthenticity({
      ...base,
      evidenceFlags: { image_contradicts_claim: true, metadata_suspect: true },
      buyerRejectedClaims: 2,
    });
    expect(a.verdict).toBe("LIKELY_FABRICATED");
    expect(a.reviewRequired).toBe(true);
  });

  it("always demands human review rather than deciding against a buyer", () => {
    const a = assessAuthenticity({
      ...base,
      evidenceFlags: { image_contradicts_claim: true },
      hasImage: false, buyerRejectedClaims: 3, minutesSinceDelivery: 2,
    });
    // Even at maximum suspicion the engine asks for a person. It never rejects.
    expect(a.reviewRequired).toBe(true);
    expect(a.score).toBeLessThanOrEqual(100);
  });

  it("notes a missing photo on a claim that is normally photographable", () => {
    const a = assessAuthenticity({ ...base, hasImage: false, evidenceFlags: {} });
    expect(a.signals.map((s) => s.factor)).toContain("evidence_missing");
  });

  it("gives a first-time claimant the benefit of the doubt", () => {
    const first = assessAuthenticity({ ...base, buyerTotalClaims: 0, evidenceFlags: { image_supports_claim: true } });
    const repeat = assessAuthenticity({ ...base, buyerTotalClaims: 5, buyerRejectedClaims: 2, evidenceFlags: { image_supports_claim: true } });
    expect(first.score).toBeLessThan(repeat.score);
  });

  it("every signal carries a human-readable explanation", () => {
    const a = assessAuthenticity({ ...base, buyerRejectedClaims: 1, hasImage: false });
    expect(a.signals.length).toBeGreaterThan(0);
    for (const s of a.signals) expect(s.detail.length).toBeGreaterThan(10);
    expect(a.narrative.length).toBeGreaterThan(20);
  });
});

describe("triage fallback", () => {
  it("classifies English complaints", () => {
    expect(keywordTriage("the screen arrived cracked").issueType).toBe("DAMAGED");
    expect(keywordTriage("it never arrived, not delivered at all").issueType).toBe("NOT_DELIVERED");
    expect(keywordTriage("this is a fake, not the real brand").issueType).toBe("COUNTERFEIT");
    expect(keywordTriage("the charger is missing from the box").issueType).toBe("MISSING_PART");
  });

  it("classifies transliterated complaints", () => {
    expect(keywordTriage("mera saman toota hua aaya").issueType).toBe("DAMAGED");
    expect(keywordTriage("abhi tak nahi mila").issueType).toBe("NOT_DELIVERED");
    expect(keywordTriage("yeh nakli hai").issueType).toBe("COUNTERFEIT");
  });

  it("detects the script of native-script complaints", () => {
    expect(detectScript("मेरा सामान टूटा हुआ आया")).toBe("hi");
    expect(detectScript("ಇದು ಮುರಿದಿದೆ")).toBe("kn");
    expect(detectScript("இது உடைந்தது")).toBe("ta");
    expect(detectScript("it arrived broken")).toBe("en");
  });

  it("admits low confidence and marks itself degraded", () => {
    const t = keywordTriage("the screen arrived cracked");
    expect(t.degraded).toBe(true);
    expect(t.confidence).toBeLessThanOrEqual(0.65);
  });

  it("does not match a keyword inside a longer word", () => {
    // "late" inside "chocolate" must not classify this as a LATE delivery.
    expect(keywordTriage("the chocolate box arrived cracked").issueType).toBe("DAMAGED");
  });
});

describe("verifier", () => {
  const verdict = {
    eligible: true, remedy: "FULL_REFUND" as const, alternatives: [],
    amountInr: 2499, deadlineAt: "2026-10-25T12:00:00.000Z",
    clauseIds: ["VJ-ELEC-2.1"], reasons: [], confidence: 0.9,
  };
  const ids = ["VJ-ELEC-2.1", "VJ-ELEC-2.2"];

  it("passes a grounded draft", () => {
    const draft =
      "Dear Arjun,\nWe reviewed your report. Your claim is eligible and a full refund " +
      "of ₹2499 will be issued. This will be completed by 2026-10-25. " +
      "This follows policy clause VJ-ELEC-2.1.\nVaanijya Resolutions";
    expect(verifyDraft(draft, verdict, ids).passed).toBe(true);
  });

  it("catches an invented amount", () => {
    const draft = "Dear Arjun, a full refund of ₹3000 will be issued by 2026-10-25. Clause VJ-ELEC-2.1.";
    const r = verifyDraft(draft, verdict, ids);
    expect(r.passed).toBe(false);
    expect(r.notes.join(" ")).toMatch(/3000.*but the engine computed.*2499/);
  });

  it("catches an invented date", () => {
    const draft = "Dear Arjun, a full refund of ₹2499 will be issued by 2026-11-30. Clause VJ-ELEC-2.1.";
    expect(verifyDraft(draft, verdict, ids).passed).toBe(false);
  });

  it("catches an invented clause id", () => {
    const draft = "Dear Arjun, a full refund of ₹2499 by 2026-10-25 under clause VJ-ELEC-9.9.";
    const r = verifyDraft(draft, verdict, ids);
    expect(r.passed).toBe(false);
    expect(r.notes.join(" ")).toMatch(/VJ-ELEC-9\.9/);
  });

  it("catches a draft claiming money already moved", () => {
    const draft = "Dear Arjun, we have refunded ₹2499 to you. Completed by 2026-10-25. Clause VJ-ELEC-2.1.";
    expect(verifyDraft(draft, verdict, ids).passed).toBe(false);
  });

  it("catches an approval tone on a rejected claim", () => {
    const rejected = { ...verdict, eligible: false, remedy: "NONE" as const, amountInr: 0, deadlineAt: null, clauseIds: [] };
    const draft = "Dear Arjun, your claim has been approved and we will sort this out.";
    expect(verifyDraft(draft, rejected, ids).passed).toBe(false);
  });

  it("the template it falls back to always passes its own check", () => {
    for (const v of [
      verdict,
      { ...verdict, remedy: "REPLACEMENT" as const, amountInr: 0 },
      { ...verdict, eligible: false, remedy: "NONE" as const, amountInr: 0, deadlineAt: null, clauseIds: [] },
    ]) {
      const t = templateDraft({
        buyerName: "Arjun", orderNo: "ORD-1", productTitle: "Earbuds",
        issueType: "DOA", verdict: v,
      });
      expect(verifyDraft(t, v, ids).passed).toBe(true);
    }
  });
});

describe("native-script triage", () => {
  // Kept as escapes so the tests survive any shell or editor encoding.
  const KN_NOTDELIV = "\u0CB6\u0CC2 \u0C87\u0CA8\u0CCD\u0CA8\u0CC2 \u0CAC\u0C82\u0CA6\u0CBF\u0CB2\u0CCD\u0CB2, \u0CB8\u0CBF\u0C95\u0CCD\u0C95\u0CBF\u0CB2\u0CCD\u0CB2";
  const HI_NOTDELIV = "\u092e\u0947\u0930\u093e \u0938\u093e\u092e\u093e\u0928 \u0905\u092d\u0940 \u0924\u0915 \u0928\u0939\u0940\u0902 \u092e\u093f\u0932\u093e";
  const TA_BROKEN = "\u0b87\u0ba4\u0bc1 \u0b89\u0b9f\u0bc8\u0ba8\u0bcd\u0ba4 \u0ba8\u0bbf\u0bb2\u0bc8\u0baf\u0bbf\u0bb2\u0bcd \u0bb5\u0ba8\u0bcd\u0ba4\u0ba4\u0bc1";

  it("carries the detected script through as the reply language", () => {
    expect(keywordTriage(KN_NOTDELIV).lang).toBe("kn");
    expect(keywordTriage(HI_NOTDELIV).lang).toBe("hi");
    expect(keywordTriage(TA_BROKEN).lang).toBe("ta");
  });

  it("classifies native-script complaints", () => {
    expect(keywordTriage(KN_NOTDELIV).issueType).toBe("NOT_DELIVERED");
    expect(keywordTriage(HI_NOTDELIV).issueType).toBe("NOT_DELIVERED");
    expect(keywordTriage(TA_BROKEN).issueType).toBe("DAMAGED");
  });
});

describe("buyer priority is deferred to the profile unless voiced", () => {
  // Regression: triage used to default to "money", silently overwriting a
  // stored preference for a fast replacement and changing which remedy the
  // engine picked.
  it("returns null when the complaint expresses no preference", () => {
    expect(keywordTriage("the shoe never arrived").buyerPriority).toBeNull();
  });

  it("reads an explicit request for a replacement as speed", () => {
    expect(keywordTriage("it is broken, please send a replacement").buyerPriority).toBe("speed");
  });

  it("reads an explicit request for a refund as money", () => {
    expect(keywordTriage("it is broken, I want a refund").buyerPriority).toBe("money");
  });

  it("a speed preference selects a goods remedy over cash", () => {
    const p: EntitlementPolicy = {
      returnWindowDays: 14, replacementAllowed: true, refundSlaDays: 5, lateCompensation: true,
      clauses: [{ id: "VJ-FOOT-3.1", text: "x", tags: ["not_delivered", "reship", "full_refund", "window"] }],
    };
    const o = (buyerPriority: "speed" | "money") => ({
      amountInr: 1899, deliveredAt: null,
      promisedBy: new Date(NOW.getTime() + 3 * 86_400_000),
      stockAvailable: true, buyerPriority,
    });
    expect(checkEntitlement(o("speed"), p, "NOT_DELIVERED", { no_delivery_scan: true }, NOW).remedy).toBe("RESHIP");
    expect(checkEntitlement(o("money"), p, "NOT_DELIVERED", { no_delivery_scan: true }, NOW).remedy).toBe("FULL_REFUND");
  });
});

describe("grounding guard for shopping replies", () => {
  // The shopping-side equivalent of the verifier: a model writing about
  // products invents them, and a prompt rule is a request, not a check.
  const facts = {
    titles: ["Stride Pro Running Shoes", "Everyday Canvas Sneakers"],
    prices: [1899, 799],
    searched: true,
  };

  it("passes a reply that only quotes what the catalogue returned", () => {
    const reply =
      "Two options under your budget: **Stride Pro Running Shoes** at ₹1,899, " +
      "and **Everyday Canvas Sneakers** at ₹799. Which size do you wear?";
    expect(checkGrounding(reply, facts, "en")).toEqual([]);
  });

  it("catches a hallucinated product", () => {
    const reply = "Try **Nike Air Max 270** — a great running shoe.";
    const issues = checkGrounding(reply, facts, "en");
    expect(issues.some((i) => i.kind === "invented_product")).toBe(true);
    expect(issues[0].detail).toMatch(/Nike Air Max 270/);
  });

  it("catches a hallucinated price", () => {
    const reply = "The **Stride Pro Running Shoes** are ₹12,999.";
    const issues = checkGrounding(reply, facts, "en");
    expect(issues.some((i) => i.kind === "invented_price")).toBe(true);
  });

  it("catches products named with no search at all — the worse case", () => {
    const bare = { titles: [], prices: [], searched: false };
    const reply = "I suggest **Adidas Ultraboost 21** at ₹13,499.";
    const issues = checkGrounding(reply, bare, "en");
    expect(issues.some((i) => i.kind === "invented_product")).toBe(true);
    expect(issues.some((i) => i.kind === "invented_price")).toBe(true);
    expect(issues.map((i) => i.detail).join(" ")).toMatch(/never looked up|without reading/);
  });

  it("catches a reply in the wrong script", () => {
    const reply = "आपने हाल ही में तीन ऑर्डर दिए हैं।";
    const issues = checkGrounding(reply, facts, "en");
    expect(issues.some((i) => i.kind === "wrong_language")).toBe(true);
  });

  it("allows an Indic reply when the buyer wrote in that language", () => {
    const reply = "**Stride Pro Running Shoes** ₹1,899 — ಇದು ಒಳ್ಳೆಯ ಆಯ್ಕೆ.";
    expect(checkGrounding(reply, facts, "kn").some((i) => i.kind === "wrong_language")).toBe(false);
  });

  it("catches a return window stated without reading a policy", () => {
    const bare = { titles: [], prices: [], searched: false };
    const reply = "You can return electronics within 30 days of delivery for a refund.";
    const issues = checkGrounding(reply, bare, "en");
    expect(issues.some((i) => i.kind === "unsourced_policy")).toBe(true);
  });

  it("does not mistake a UI label for a product", () => {
    const reply = 'Open the order and press **Report a problem** to start a claim.';
    const issues = checkGrounding(reply, { titles: [], prices: [], searched: false }, "en");
    expect(issues.some((i) => i.kind === "invented_product")).toBe(false);
  });


  it("lets the agent echo the buyer's own budget back", () => {
    // Regression: "nothing under ₹500" was flagged as an invented price
    // because 500 is not a catalogue price. Confirming the buyer's own figure
    // is correct behaviour, and a false warning is worse than none.
    const bare = { titles: [], prices: [], searched: true };
    const reply = "I could not find any 4K televisions under ₹500. Raise the budget?";
    const issues = checkGrounding(reply, bare, "en", "I want a 4K television under 500 rupees");
    expect(issues.some((i) => i.kind === "invented_price")).toBe(false);
  });

  it("still catches an invented price when the buyer never said it", () => {
    const bare = { titles: [], prices: [], searched: true };
    const reply = "The television is ₹13,499.";
    const issues = checkGrounding(reply, bare, "en", "show me a television");
    expect(issues.some((i) => i.kind === "invented_price")).toBe(true);
  });
  it("writes a correction a buyer can act on", () => {
    const note = correctionFor([
      { kind: "invented_product", detail: "x" },
      { kind: "unsourced_policy", detail: "y" },
    ]);
    expect(note).toMatch(/not from our catalogue/i);
    expect(note).toMatch(/Report a problem/i);
  });
});

describe("claim state machine", () => {
  it("permits the designed path through a claim", () => {
    for (const [from, to] of [
      ["INTAKE", "TRIAGED"], ["TRIAGED", "ADJUDICATED"],
      ["ADJUDICATED", "AWAITING_APPROVAL"], ["AWAITING_APPROVAL", "APPROVED"],
      ["APPROVED", "RESOLVED"],
    ] as [string, string][]) {
      expect(() => assertClaimTransition(from, to)).not.toThrow();
    }
  });

  it("refuses to skip the approval gate", () => {
    // The whole audit story rests on this: a claim cannot become APPROVED
    // without passing through the state where a human decides.
    expect(() => assertClaimTransition("TRIAGED", "APPROVED")).toThrow(/illegal/i);
    expect(() => assertClaimTransition("INTAKE", "RESOLVED")).toThrow(/illegal/i);
  });

  it("treats resolved and rejected as terminal", () => {
    expect(isTerminalClaim("RESOLVED")).toBe(true);
    expect(isTerminalClaim("REJECTED")).toBe(true);
    expect(() => assertClaimTransition("RESOLVED", "AWAITING_APPROVAL")).toThrow(/terminal/i);
  });

  it("allows a human to decide a handed-off case", () => {
    expect(() => assertClaimTransition("HUMAN_HANDOFF", "APPROVED")).not.toThrow();
    expect(() => assertClaimTransition("HUMAN_HANDOFF", "REJECTED")).not.toThrow();
  });

  it("escalates only one tier at a time", () => {
    expect(() => assertClaimTransition("ESCALATED_T1", "ESCALATED_T2")).not.toThrow();
    expect(() => assertClaimTransition("AWAITING_APPROVAL", "ESCALATED_T2")).toThrow(/illegal/i);
  });

  it("names the allowed transitions when it refuses", () => {
    try {
      assertClaimTransition("TRIAGED", "RESOLVED");
      throw new Error("should have thrown");
    } catch (e) {
      expect(String(e)).toMatch(/ADJUDICATED/);
    }
  });

  it("rejects an unknown state rather than accepting it", () => {
    expect(() => assertClaimTransition("MADE_UP", "RESOLVED")).toThrow();
    expect(() => assertClaimTransition("TRIAGED", "MADE_UP")).toThrow();
  });
});
