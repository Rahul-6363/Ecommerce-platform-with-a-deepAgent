/**
 * Seller standing — PURE DETERMINISTIC FUNCTION. No model, no clock, no I/O.
 *
 * The missing half of the loop. The platform already prices a seller's failure
 * rate into what a buyer pays (`trueCost`), but that rate was static seed data:
 * a seller could ship fault after fault and their number never moved. Which
 * means the one party able to prevent the problem felt nothing, while buyers
 * paid for it in the comparison.
 *
 * So an upheld claim is recorded against the seller who caused it, and the
 * defect rate the buyer sees is **observed, not declared**. Three consequences,
 * all computed here and all visible on screen:
 *
 *  - the buyer's true-cost comparison gets sharper as evidence accumulates,
 *  - a seller's listings are throttled or suspended once the rate is
 *    indefensible,
 *  - the seller is told exactly which number moved and what it cost them.
 *
 * Two deliberate limits, for the same reason the fraud analyst has them:
 *
 *  1. **Only upheld claims count.** A claim a buyer filed and an operator
 *     rejected is not evidence against the seller. Counting filings rather
 *     than findings would let one determined buyer destroy a good seller.
 *  2. **A small sample is held to a floor.** Two faults out of three orders
 *     is not a 67% defect rate, it is a tiny sample, and acting on it would
 *     punish new sellers for noise. Confidence is stated, never implied.
 */

/** Below this many orders, the observed rate is not yet trustworthy on its own. */
export const MIN_ORDERS_FOR_CONFIDENCE = 20;

/** Defect-rate bands, in percent. */
export const STANDING_BANDS = {
  /** At or under this, the seller is doing well and is said so. */
  good: 3,
  /** Above `good`, up to this: acceptable, watched. */
  acceptable: 8,
  /** Above `acceptable`, up to this: listings throttled. */
  poor: 15,
  // Above `poor`: suspension recommended.
} as const;

export type SellerStandingBand = "GOOD" | "ACCEPTABLE" | "POOR" | "UNACCEPTABLE";

/** What the platform does about a band. Never a punishment nobody can appeal. */
export type SellerAction =
  | "NONE"
  | "WATCH"
  | "THROTTLE_LISTINGS"
  | "RECOMMEND_SUSPENSION";

export type SellerStanding = {
  sellerId: string;
  /** Orders fulfilled, the denominator. */
  orders: number;
  /** Claims upheld against this seller — the numerator. */
  upheldClaims: number;
  /** Claims filed and then rejected. Reported, never counted against them. */
  rejectedClaims: number;
  /** The rate actually observed, 0..100. */
  observedDefectRatePct: number;
  /**
   * The rate the platform acts on. Blended toward the declared rate while the
   * sample is small, so a new seller is judged on evidence, not on noise.
   */
  effectiveDefectRatePct: number;
  /** Is the sample large enough to stand on its own? */
  confident: boolean;
  band: SellerStandingBand;
  action: SellerAction;
  /** What the buyer's refunds have cost this seller, in rupees. */
  refundedInr: number;
  /** Every conclusion, traced to the number behind it. */
  reasons: string[];
  /** One sentence for the seller, naming what moved and what it cost. */
  notice: string;
};

export type SellerStandingInput = {
  sellerId: string;
  /** Orders this seller has fulfilled. */
  orders: number;
  /** Claims upheld (approved) against them. */
  upheldClaims: number;
  /** Claims filed against them and rejected on review. */
  rejectedClaims: number;
  /** Rupees refunded or credited to buyers because of their faults. */
  refundedInr: number;
  /** The rate on their record before any claims were observed. */
  declaredDefectRatePct: number;
};

/**
 * Compute a seller's standing from upheld claims.
 *
 * Pure: the same inputs always give the same standing, so a seller can be
 * shown exactly why they were throttled months after the fact, and can argue
 * with the arithmetic rather than with a verdict.
 */
export function sellerStanding(input: SellerStandingInput): SellerStanding {
  const reasons: string[] = [];
  const orders = Math.max(0, Math.trunc(input.orders));
  const upheld = Math.max(0, Math.trunc(input.upheldClaims));
  const rejected = Math.max(0, Math.trunc(input.rejectedClaims));
  const declared = clampPct(input.declaredDefectRatePct);
  const refundedInr = Math.max(0, Math.trunc(input.refundedInr));

  const observed = orders > 0 ? round1((upheld / orders) * 100) : 0;

  if (orders === 0) {
    reasons.push("no fulfilled orders yet, so there is nothing to measure");
  } else {
    reasons.push(
      `${upheld} upheld claim${upheld === 1 ? "" : "s"} across ${orders} ` +
        `fulfilled order${orders === 1 ? "" : "s"} = ${observed}% observed defect rate`,
    );
  }

  if (rejected > 0) {
    // Said out loud, because a seller reading this deserves to know that
    // claims against them were reviewed and thrown out.
    reasons.push(
      `${rejected} further claim${rejected === 1 ? "" : "s"} ${rejected === 1 ? "was" : "were"} ` +
        "filed and rejected on review — not counted against this seller",
    );
  }

  // Blend toward the declared rate while the sample is thin. The weight is the
  // sample size as a fraction of the confidence threshold, so evidence takes
  // over smoothly rather than at a cliff.
  const confident = orders >= MIN_ORDERS_FOR_CONFIDENCE;
  let effective: number;

  if (orders === 0) {
    effective = declared;
    reasons.push(`using the declared ${declared}% until there are orders to judge`);
  } else if (confident) {
    effective = observed;
    reasons.push(
      `${orders} orders is at or above the ${MIN_ORDERS_FOR_CONFIDENCE}-order ` +
        "threshold, so the observed rate is used directly",
    );
  } else {
    const weight = orders / MIN_ORDERS_FOR_CONFIDENCE;
    effective = round1(observed * weight + declared * (1 - weight));
    reasons.push(
      `only ${orders} of ${MIN_ORDERS_FOR_CONFIDENCE} orders needed for confidence, so the ` +
        `rate is blended ${Math.round(weight * 100)}% observed / ` +
        `${Math.round((1 - weight) * 100)}% declared = ${effective}%`,
    );
  }

  const band = bandFor(effective);
  const action = actionFor(band, confident, reasons);

  if (refundedInr > 0) {
    reasons.push(`₹${refundedInr.toLocaleString("en-IN")} refunded to buyers for these faults`);
  }

  return {
    sellerId: input.sellerId,
    orders,
    upheldClaims: upheld,
    rejectedClaims: rejected,
    observedDefectRatePct: observed,
    effectiveDefectRatePct: effective,
    confident,
    band,
    action,
    refundedInr,
    reasons,
    notice: noticeFor(band, action, effective, upheld, orders, refundedInr, confident),
  };
}

function bandFor(pct: number): SellerStandingBand {
  if (pct <= STANDING_BANDS.good) return "GOOD";
  if (pct <= STANDING_BANDS.acceptable) return "ACCEPTABLE";
  if (pct <= STANDING_BANDS.poor) return "POOR";
  return "UNACCEPTABLE";
}

/**
 * What follows from a band.
 *
 * A thin sample never triggers a listing restriction, however bad the ratio
 * looks: the consequence waits for the evidence. The seller is watched in the
 * meantime, and told so.
 */
function actionFor(
  band: SellerStandingBand,
  confident: boolean,
  reasons: string[],
): SellerAction {
  if (band === "GOOD") return "NONE";
  if (band === "ACCEPTABLE") return "WATCH";

  if (!confident) {
    reasons.push(
      "the rate is above the acceptable band, but the sample is too small to " +
        "restrict listings on — watching instead",
    );
    return "WATCH";
  }

  return band === "POOR" ? "THROTTLE_LISTINGS" : "RECOMMEND_SUSPENSION";
}

function noticeFor(
  band: SellerStandingBand,
  action: SellerAction,
  pct: number,
  upheld: number,
  orders: number,
  refundedInr: number,
  confident: boolean,
): string {
  const cost = refundedInr > 0 ? ` It has cost you ₹${refundedInr.toLocaleString("en-IN")} in refunds.` : "";
  const basis = `${upheld} upheld claim${upheld === 1 ? "" : "s"} in ${orders} order${orders === 1 ? "" : "s"} (${pct}%)`;

  switch (action) {
    case "NONE":
      return `${basis}. Your defect rate is within the ${STANDING_BANDS.good}% band, and buyers see that in your favour when the agent compares offers.${cost}`;
    case "WATCH":
      return (
        `${basis}. Above the ${STANDING_BANDS.good}% band, so buyers now see this rate priced ` +
        `into your offers and you will lose comparisons to cleaner sellers.` +
        (confident ? "" : " Too few orders to act on yet; this is a warning, not a restriction.") +
        cost
      );
    case "THROTTLE_LISTINGS":
      return (
        `${basis}. Above the ${STANDING_BANDS.acceptable}% band, so your listings are ranked ` +
        `down until the rate recovers.${cost}`
      );
    case "RECOMMEND_SUSPENSION":
      return (
        `${basis}. Above the ${STANDING_BANDS.poor}% band. Listings are suspended pending ` +
        `review — this is referred to a person, not applied automatically.${cost}`
      );
  }
}

function clampPct(n: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, round1(v)));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
