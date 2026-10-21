/**
 * Seller accountability and refund-abuse patterns.
 *
 * These two sit either side of the same decision. When an operator upholds a
 * claim, money moves to the buyer and a fault is recorded against the seller;
 * when they reject it, neither happens. Both directions have to be right, and
 * both are easy to get subtly wrong in ways that punish the innocent party:
 *
 *  - counting *filings* rather than *findings* lets one determined buyer
 *    destroy a good seller,
 *  - acting on a tiny sample punishes new sellers for noise,
 *  - counting upheld claims against the BUYER treats someone genuinely wronged
 *    three times as a fraudster.
 *
 * Each of those is pinned below.
 */
import { describe, it, expect } from "vitest";
import {
  sellerStanding,
  MIN_ORDERS_FOR_CONFIDENCE,
  STANDING_BANDS,
} from "@/lib/engines/seller-standing";
import { assessAuthenticity } from "@/lib/engines/authenticity";
import type { AuthenticityInput } from "@/lib/engines/authenticity";

/* ───────────────────────── Seller standing ───────────────────────── */

const base = {
  sellerId: "SEL-TEST",
  orders: 100,
  upheldClaims: 0,
  rejectedClaims: 0,
  refundedInr: 0,
  declaredDefectRatePct: 5,
};

describe("sellerStanding", () => {
  it("is pure: identical inputs give identical output", () => {
    expect(sellerStanding(base)).toEqual(sellerStanding(base));
  });

  it("computes the observed rate from upheld claims over orders", () => {
    const s = sellerStanding({ ...base, orders: 100, upheldClaims: 12 });
    expect(s.observedDefectRatePct).toBe(12);
  });

  it("counts only upheld claims, never claims that were rejected on review", () => {
    // The protection that matters: a buyer who files ten unsupported claims
    // must not be able to wreck a seller's standing.
    const clean = sellerStanding({ ...base, orders: 100, upheldClaims: 1, rejectedClaims: 0 });
    const attacked = sellerStanding({ ...base, orders: 100, upheldClaims: 1, rejectedClaims: 10 });

    expect(attacked.observedDefectRatePct).toBe(clean.observedDefectRatePct);
    expect(attacked.band).toBe(clean.band);
    expect(attacked.action).toBe(clean.action);
  });

  it("tells the seller that claims against them were reviewed and dismissed", () => {
    const s = sellerStanding({ ...base, rejectedClaims: 4 });
    expect(s.reasons.some((r) => /filed and rejected on review/.test(r))).toBe(true);
  });

  it("holds a small sample to a blended rate rather than acting on noise", () => {
    // 2 faults in 3 orders is not a 67% defect rate, it is three orders.
    const s = sellerStanding({ ...base, orders: 3, upheldClaims: 2, declaredDefectRatePct: 5 });
    expect(s.observedDefectRatePct).toBeCloseTo(66.7, 0);
    expect(s.confident).toBe(false);
    expect(s.effectiveDefectRatePct).toBeLessThan(s.observedDefectRatePct);
  });

  it("never restricts listings on a sample too small to defend", () => {
    const s = sellerStanding({ ...base, orders: 3, upheldClaims: 3, declaredDefectRatePct: 5 });
    expect(s.confident).toBe(false);
    expect(s.action).toBe("WATCH");
    expect(s.reasons.some((r) => /too small to restrict listings/.test(r))).toBe(true);
  });

  it("uses the observed rate directly once the sample is large enough", () => {
    const s = sellerStanding({
      ...base,
      orders: MIN_ORDERS_FOR_CONFIDENCE,
      upheldClaims: 2,
      declaredDefectRatePct: 40,
    });
    expect(s.confident).toBe(true);
    expect(s.effectiveDefectRatePct).toBe(s.observedDefectRatePct);
  });

  it("bands a good seller as good and does nothing to them", () => {
    const s = sellerStanding({ ...base, orders: 200, upheldClaims: 2 });
    expect(s.band).toBe("GOOD");
    expect(s.action).toBe("NONE");
  });

  it("throttles listings in the poor band", () => {
    const s = sellerStanding({ ...base, orders: 100, upheldClaims: 12 });
    expect(s.band).toBe("POOR");
    expect(s.action).toBe("THROTTLE_LISTINGS");
  });

  it("refers an unacceptable seller to a person rather than auto-banning", () => {
    const s = sellerStanding({ ...base, orders: 100, upheldClaims: 30 });
    expect(s.band).toBe("UNACCEPTABLE");
    expect(s.action).toBe("RECOMMEND_SUSPENSION");
    // Stated explicitly: suspension is recommended, not silently applied.
    expect(s.notice).toMatch(/referred to a person/);
  });

  it("escalates monotonically as the defect rate climbs", () => {
    const rank = { NONE: 0, WATCH: 1, THROTTLE_LISTINGS: 2, RECOMMEND_SUSPENSION: 3 };
    let last = -1;
    for (const upheld of [0, 4, 6, 10, 14, 25, 40]) {
      const s = sellerStanding({ ...base, orders: 100, upheldClaims: upheld });
      expect(rank[s.action]).toBeGreaterThanOrEqual(last);
      last = rank[s.action];
    }
  });

  it("tells the seller what it cost them in refunds", () => {
    const s = sellerStanding({ ...base, orders: 100, upheldClaims: 10, refundedInr: 14_500 });
    expect(s.notice).toMatch(/14,500/);
    expect(s.reasons.some((r) => /refunded to buyers/.test(r))).toBe(true);
  });

  it("traces every conclusion to a number", () => {
    const s = sellerStanding({ ...base, orders: 50, upheldClaims: 9, refundedInr: 900 });
    expect(s.reasons.length).toBeGreaterThanOrEqual(2);
    for (const r of s.reasons) expect(r).toMatch(/\d/);
  });

  it("handles a brand-new seller with no orders at all", () => {
    const s = sellerStanding({ ...base, orders: 0, declaredDefectRatePct: 7 });
    expect(s.observedDefectRatePct).toBe(0);
    expect(s.effectiveDefectRatePct).toBe(7);
    expect(s.action).toBe("WATCH"); // 7% declared sits in the acceptable band
    expect(s.reasons.some((r) => /nothing to measure/.test(r))).toBe(true);
  });

  it("clamps a nonsensical declared rate instead of trusting it", () => {
    const s = sellerStanding({ ...base, orders: 0, declaredDefectRatePct: 900 });
    expect(s.effectiveDefectRatePct).toBeLessThanOrEqual(100);
  });

  it("keeps the band thresholds in the documented order", () => {
    expect(STANDING_BANDS.good).toBeLessThan(STANDING_BANDS.acceptable);
    expect(STANDING_BANDS.acceptable).toBeLessThan(STANDING_BANDS.poor);
  });
});

/* ──────────────────── Refund-abuse patterns ──────────────────── */

const claim: AuthenticityInput = {
  issueType: "DAMAGED",
  evidenceFlags: { photo: true, image_supports_claim: true },
  hasImage: true,
  minutesSinceDelivery: 600,
  windowFraction: 0.3,
  orderAmountInr: 2000,
  buyerTotalClaims: 1,
  buyerRejectedClaims: 0,
  buyerOrderCount: 10,
  sellerDefectRatePct: 5,
};

/** The suspicion score for a claim with some history attached. */
const withHistory = (over: Partial<AuthenticityInput>) =>
  assessAuthenticity({ ...claim, ...over });

describe("cross-order refund abuse", () => {
  it("scores a well-evidenced first claim as genuine", () => {
    const a = assessAuthenticity(claim);
    expect(a.verdict).toBe("LIKELY_GENUINE");
  });

  it("flags a second claim on an order already claimed", () => {
    const repeat = withHistory({ priorClaimsOnThisOrder: 2 });
    const signal = repeat.signals.find((s) => s.factor === "repeat_claim_same_order");
    expect(signal).toBeTruthy();
    expect(signal!.points).toBeGreaterThan(0);
    expect(signal!.detail).toMatch(/already been filed on this same order/);

    // Compared on the raw signal sum, not the published score: a strongly
    // corroborated claim sits at the 0 floor, so the clamp hides the
    // difference between "clean" and "clean but suspicious pattern".
    const sum = (x: typeof repeat) => x.signals.reduce((t, g) => t + g.points, 0);
    expect(sum(repeat)).toBeGreaterThan(sum(assessAuthenticity(claim)));
  });

  it("flags a buyer claiming several times in a month", () => {
    const a = withHistory({ claimsLast30Days: 5 });
    expect(a.signals.some((s) => s.factor === "serial_claimant")).toBe(true);
  });

  it("does not flag an ordinary claim rate as serial", () => {
    const a = withHistory({ claimsLast30Days: 2 });
    expect(a.signals.some((s) => s.factor === "serial_claimant")).toBe(false);
  });

  it("caps the serial-claimant signal so it cannot alone condemn a claim", () => {
    const many = withHistory({ claimsLast30Days: 50 });
    const signal = many.signals.find((s) => s.factor === "serial_claimant");
    expect(signal!.points).toBeLessThanOrEqual(34);
  });

  it("flags the same hard-to-disprove allegation repeated", () => {
    const a = withHistory({ sameIssueTypeCount: 4 });
    expect(a.signals.some((s) => s.factor === "same_issue_repeated")).toBe(true);
  });

  it("flags goods that were refunded and never returned", () => {
    const a = withHistory({ unreturnedGoodsCount: 2 });
    const signal = a.signals.find((s) => s.factor === "goods_never_returned");
    expect(signal).toBeTruthy();
    expect(signal!.points).toBeGreaterThan(0);
  });

  it("flags refunds far out of proportion to what the buyer ever spent", () => {
    const a = withHistory({ refundedToBuyerInr: 9_000, buyerLifetimeSpendInr: 10_000 });
    expect(a.signals.some((s) => s.factor === "refund_ratio")).toBe(true);
  });

  it("does not flag a proportionate refund history", () => {
    const a = withHistory({ refundedToBuyerInr: 1_000, buyerLifetimeSpendInr: 50_000 });
    expect(a.signals.some((s) => s.factor === "refund_ratio")).toBe(false);
  });

  it("sends an organised pattern to a human even when the evidence looks perfect", () => {
    // Every per-claim signal is clean: photo supplied, vision agrees, filed
    // promptly, mid-window. Only the pattern is wrong — which is exactly the
    // case a per-claim model passes and this engine must not.
    const a = withHistory({
      priorClaimsOnThisOrder: 1,
      claimsLast30Days: 6,
      sameIssueTypeCount: 4,
      unreturnedGoodsCount: 2,
      refundedToBuyerInr: 12_000,
      buyerLifetimeSpendInr: 15_000,
    });
    expect(a.verdict).toBe("LIKELY_FABRICATED");
    expect(a.reviewRequired).toBe(true);
  });

  it("still never decides the remedy or rejects the buyer itself", () => {
    // The hard limit on this engine, unchanged by the new signals: it can
    // demand review, it cannot refuse anyone. Accusing a customer of fraud is
    // not a decision a scoring function gets to make.
    const a = withHistory({
      claimsLast30Days: 20,
      unreturnedGoodsCount: 10,
      refundedToBuyerInr: 99_000,
      buyerLifetimeSpendInr: 10_000,
    });
    expect(a.reviewRequired).toBe(true);
    expect(a).not.toHaveProperty("remedy");
    expect(a).not.toHaveProperty("amountInr");
    expect(a.score).toBeLessThanOrEqual(100);
  });

  it("does not punish a buyer for claims that were upheld", () => {
    // Three genuine faults is bad luck, or a bad seller — not fraud.
    const unlucky = withHistory({ buyerTotalClaims: 3, buyerRejectedClaims: 0 });
    const suspect = withHistory({ buyerTotalClaims: 3, buyerRejectedClaims: 3 });
    expect(suspect.score).toBeGreaterThan(unlucky.score);
  });

  it("ignores the new signals entirely when no history is supplied", () => {
    // Optional inputs: existing callers must behave exactly as before.
    const a = assessAuthenticity(claim);
    const b = withHistory({
      priorClaimsOnThisOrder: 0,
      claimsLast30Days: 0,
      sameIssueTypeCount: 0,
      unreturnedGoodsCount: 0,
      refundedToBuyerInr: 0,
      buyerLifetimeSpendInr: 0,
    });
    expect(b.score).toBe(a.score);
  });
});
