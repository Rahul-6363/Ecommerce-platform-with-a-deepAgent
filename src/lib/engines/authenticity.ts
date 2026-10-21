/**
 * Authenticity engine — pure, additive, advisory.
 *
 * This is the engine behind "is this allegation genuine or fabricated". It
 * scores *suspicion*, 0..100, from signals that are each checkable by a human:
 * timing, claim history, evidence presence, what the vision model saw, whether
 * the courier record agrees with the story.
 *
 * Three deliberate limits:
 *
 *  1. It never decides the remedy or the amount — that is `checkEntitlement`.
 *  2. It never auto-rejects a buyer. A high score sets `reviewRequired`, which
 *     routes the case to an operator. Accusing a customer of fraud is not a
 *     decision we let a scoring function make on its own.
 *  3. The vision model is one signal among many and is capped, so a single
 *     model misread cannot by itself condemn a claim.
 */
import type { AuthenticityAssessment, EvidenceFlags, IssueType, RiskReason } from "@/lib/types";

/** Weights. Positive points = more suspicious. */
const W = {
  noEvidenceWhenRequired: 22,
  imageContradictsClaim: 28,
  imageUnrelated: 14,
  metadataSuspect: 12,
  claimedImmediately: 10,
  claimedAtWindowEdge: 14,
  repeatRejectedClaims: 16,
  repeatRejectedCap: 32,
  highClaimRate: 12,
  trackingContradicts: 20,
  highValueOrder: 8,
  counterfeitWithoutBrandProof: 16,
  // Cross-order patterns. A single claim can look perfect and still be the
  // fourth one this month: the signals above read one claim in isolation, and
  // organised refund abuse is only visible across a buyer's history.
  repeatClaimSameOrder: 26,
  serialClaimant: 20,
  serialClaimantCap: 34,
  sameIssueRepeated: 18,
  refundValueFarAboveNorm: 14,
  neverReturnsGoods: 22,
  // Negative points = more credible.
  imageSupportsClaim: -26,
  trackingCorroborates: -18,
  firstTimeClaimant: -10,
  sellerHighDefectRate: -12,
} as const;

const SUSPICIOUS = 55;
const INCONCLUSIVE_FLOOR = 30;
const HIGH_VALUE_INR = 15_000;
const IMMEDIATE_MINUTES = 15;
const WINDOW_EDGE_FRACTION = 0.9;
const HIGH_CLAIM_RATE = 0.4;
/** Refunds above this share of lifetime spend are worth a human look. */
const REFUND_RATIO_LIMIT = 0.5;

export type AuthenticityInput = {
  issueType: IssueType;
  evidenceFlags: EvidenceFlags;
  /** Does the claim have at least one uploaded image? */
  hasImage: boolean;
  /** Minutes between the delivery scan and the complaint being raised. */
  minutesSinceDelivery: number | null;
  /** How far through the return window the claim arrived, 0..1+. */
  windowFraction: number | null;
  orderAmountInr: number;
  buyerTotalClaims: number;
  buyerRejectedClaims: number;
  buyerOrderCount: number;
  /** The seller's historical defect rate, 0..100. */
  sellerDefectRatePct: number;

  /* ── Cross-order history. Optional so existing callers still compile;
   * each is simply not scored when it is not supplied. ───────────────── */

  /** Claims this buyer has already filed on THIS order. */
  priorClaimsOnThisOrder?: number;
  /** Claims this buyer filed in the last 30 days, across all orders. */
  claimsLast30Days?: number;
  /** How many of this buyer's claims were the same issue type as this one. */
  sameIssueTypeCount?: number;
  /** Total rupees already refunded to this buyer, all time. */
  refundedToBuyerInr?: number;
  /** Rupees this buyer has spent, all time. Used as the scale for the above. */
  buyerLifetimeSpendInr?: number;
  /**
   * Upheld claims where a return was required and the goods never came back.
   * The clearest signal in the whole engine: a buyer who keeps the item and
   * the money, repeatedly.
   */
  unreturnedGoodsCount?: number;
};

export function assessAuthenticity(input: AuthenticityInput): AuthenticityAssessment {
  const signals: RiskReason[] = [];
  const add = (factor: string, points: number, detail: string) => {
    if (points) signals.push({ factor, points, detail });
  };

  const f = input.evidenceFlags ?? {};

  /* ── Evidence signals ─────────────────────────────────────────────── */

  const photoIssues: IssueType[] = ["DAMAGED", "DOA", "WRONG_ITEM", "COUNTERFEIT"];
  if (photoIssues.includes(input.issueType) && !input.hasImage) {
    add("evidence_missing", W.noEvidenceWhenRequired,
      `a ${input.issueType} claim is normally provable by photograph and none was supplied`);
  }

  if (f.image_contradicts_claim) {
    add("image_contradicts_claim", W.imageContradictsClaim,
      "the vision model found the uploaded photograph does not show the stated defect");
  } else if (f.image_supports_claim) {
    add("image_supports_claim", W.imageSupportsClaim,
      "the uploaded photograph visibly shows the stated defect");
  } else if (input.hasImage) {
    add("image_unrelated", W.imageUnrelated,
      "a photograph was supplied but it neither shows nor excludes the stated defect");
  }

  if (f.metadata_suspect) {
    add("metadata_suspect", W.metadataSuspect,
      "the image appears to be a screenshot, a stock photo or a re-encoded file");
  }

  if (input.issueType === "COUNTERFEIT" && !f.brand_mismatch) {
    add("counterfeit_unsupported", W.counterfeitWithoutBrandProof,
      "counterfeit alleged but nothing in the evidence identifies a brand mismatch");
  }

  /* ── Timing signals ───────────────────────────────────────────────── */

  if (input.minutesSinceDelivery !== null && input.minutesSinceDelivery >= 0) {
    if (input.minutesSinceDelivery < IMMEDIATE_MINUTES && input.issueType !== "NOT_DELIVERED") {
      add("claimed_immediately", W.claimedImmediately,
        `complaint raised ${Math.round(input.minutesSinceDelivery)} minutes after the ` +
        "delivery scan, before a parcel is normally opened and inspected");
    }
  }

  if (input.windowFraction !== null && input.windowFraction >= WINDOW_EDGE_FRACTION) {
    add("claimed_at_window_edge", W.claimedAtWindowEdge,
      `complaint raised at ${Math.round(input.windowFraction * 100)}% of the return window, ` +
      "a pattern associated with use-then-return");
  }

  /* ── History signals ──────────────────────────────────────────────── */

  if (input.buyerRejectedClaims > 0) {
    add("prior_rejected_claims",
      Math.min(input.buyerRejectedClaims * W.repeatRejectedClaims, W.repeatRejectedCap),
      `${input.buyerRejectedClaims} earlier claim(s) by this buyer were rejected as unsupported`);
  }

  if (input.buyerOrderCount >= 4 && input.buyerTotalClaims / input.buyerOrderCount > HIGH_CLAIM_RATE) {
    const pct = Math.round((input.buyerTotalClaims / input.buyerOrderCount) * 100);
    add("high_claim_rate", W.highClaimRate,
      `this buyer has claimed on ${pct}% of their orders`);
  }

  if (input.buyerTotalClaims === 0) {
    add("first_time_claimant", W.firstTimeClaimant,
      "first claim this buyer has ever filed");
  }

  /* ── Cross-order patterns ─────────────────────────────────────────────
   *
   * Everything above reads this claim on its own. Refund abuse at any scale
   * does not look wrong one claim at a time - it looks wrong in the pattern,
   * which is exactly what a per-claim model cannot see. These are the signals
   * that catch a second claim on an order already refunded, a buyer claiming
   * every fortnight, and the one that matters most: goods that never come back.
   */

  const priorSameOrder = Math.trunc(input.priorClaimsOnThisOrder ?? 0);
  if (priorSameOrder > 0) {
    add("repeat_claim_same_order", W.repeatClaimSameOrder,
      `${priorSameOrder} earlier claim(s) have already been filed on this same order`);
  }

  const recent = Math.trunc(input.claimsLast30Days ?? 0);
  if (recent >= 3) {
    add("serial_claimant",
      Math.min((recent - 2) * W.serialClaimant, W.serialClaimantCap),
      `${recent} claims filed by this buyer in the last 30 days`);
  }

  const sameIssue = Math.trunc(input.sameIssueTypeCount ?? 0);
  if (sameIssue >= 3) {
    add("same_issue_repeated", W.sameIssueRepeated,
      `this buyer has alleged ${input.issueType} ${sameIssue} times before — a repeated ` +
      "allegation of the one issue type that is hardest to disprove");
  }

  const unreturned = Math.trunc(input.unreturnedGoodsCount ?? 0);
  if (unreturned >= 1) {
    add("goods_never_returned", W.neverReturnsGoods,
      `${unreturned} previously refunded item(s) were never returned by this buyer ` +
      "despite a pickup being arranged");
  }

  // Refunds far out of proportion to what the buyer has actually spent.
  const refunded = Math.trunc(input.refundedToBuyerInr ?? 0);
  const spend = Math.trunc(input.buyerLifetimeSpendInr ?? 0);
  if (refunded > 0 && spend > 0 && refunded / spend > REFUND_RATIO_LIMIT) {
    add("refund_ratio", W.refundValueFarAboveNorm,
      `Rs ${refunded} refunded against Rs ${spend} ever spent — ` +
      `${Math.round((refunded / spend) * 100)}% of this buyer's spend has come back to them`);
  }

  /* ── Corroboration signals ────────────────────────────────────────── */

  if (f.tracking_corroborates) {
    add("tracking_corroborates", W.trackingCorroborates,
      "the courier scan record independently supports the complaint");
  }
  if (f.conflicting_evidence) {
    add("tracking_contradicts", W.trackingContradicts,
      "the courier scan record is inconsistent with the complaint");
  }

  if (input.sellerDefectRatePct >= 8) {
    add("seller_defect_base_rate", W.sellerHighDefectRate,
      `this seller has a ${input.sellerDefectRatePct}% historical defect rate, so the ` +
      "complaint is consistent with their base rate");
  }

  if (input.orderAmountInr >= HIGH_VALUE_INR) {
    add("high_value_order", W.highValueOrder,
      `Rs ${input.orderAmountInr} order — high-value claims warrant a second look`);
  }

  /* ── Score ────────────────────────────────────────────────────────── */

  const raw = signals.reduce((s, x) => s + x.points, 0);
  const score = Math.max(0, Math.min(raw, 100));

  let verdict: AuthenticityAssessment["verdict"];
  if (score >= SUSPICIOUS) verdict = "LIKELY_FABRICATED";
  else if (score >= INCONCLUSIVE_FLOOR) verdict = "INCONCLUSIVE";
  else verdict = "LIKELY_GENUINE";

  signals.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

  return {
    verdict,
    score,
    signals,
    narrative: narrate(verdict, score, signals),
    // Everything above "clearly genuine" goes to a person. The agent never
    // tells a customer their complaint is fraudulent on its own authority.
    reviewRequired: verdict !== "LIKELY_GENUINE",
  };
}

function narrate(
  verdict: AuthenticityAssessment["verdict"],
  score: number,
  signals: RiskReason[],
): string {
  const top = signals.slice(0, 3).map((s) => s.detail);
  const lead =
    verdict === "LIKELY_GENUINE"
      ? `Suspicion score ${score}/100 — the complaint is consistent with the record.`
      : verdict === "INCONCLUSIVE"
        ? `Suspicion score ${score}/100 — the evidence neither supports nor refutes the complaint; a person should look.`
        : `Suspicion score ${score}/100 — several signals point away from a genuine defect. Operator review required before anything is paid.`;
  if (top.length === 0) return lead;
  return `${lead} Chiefly: ${top.join("; ")}.`;
}

export { SUSPICIOUS, INCONCLUSIVE_FLOOR };
