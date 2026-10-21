/**
 * Offer economics — PURE DETERMINISTIC FUNCTIONS. No model, no clock, no I/O.
 *
 * Two questions a price tag cannot answer, and nobody on any platform answers
 * for the buyer:
 *
 *  1. **What will this actually cost me?** The sticker is one of four numbers.
 *     A COD fee, a delivery charge and the expected cost of the seller failing
 *     are all real money, and the cheapest sticker is routinely not the
 *     cheapest purchase. `trueCost` adds them up and shows its arithmetic.
 *
 *  2. **Will it arrive in time?** Every platform quotes one optimistic date
 *     with no confidence attached. `deliveryForecast` returns a likely date
 *     AND a date it is 80% confident about, because an honest interval is more
 *     useful to someone with a deadline than a confident wrong date.
 *
 * Both are built from fields the platform already has — `defectRatePct` and
 * `fulfilmentSlaDays` per seller, `pinTier` per address, `priorRto` per buyer —
 * so none of this needs a third-party feed.
 */

/* ───────────────────────────── True cost ───────────────────────────── */

/** Cash-on-delivery handling fee, charged by the courier not the seller. */
export const COD_FEE_INR = 40;

/** Delivery charge by pincode tier. Tier 1 metros are subsidised; tier 4 is not. */
export const DELIVERY_FEE_BY_TIER: Record<number, number> = { 1: 0, 2: 40, 3: 60, 4: 90 };

/** Orders at or above this value ship free, whatever the tier. */
export const FREE_DELIVERY_ABOVE_INR = 5_000;

/**
 * What a return costs the buyer in time and courier handling even when the
 * refund itself is full: the pickup wait, the re-order, the second delivery.
 * Priced as a flat inconvenience cost so it can be reasoned about at all.
 */
export const RETURN_FRICTION_INR = 99;

export type CostLine = {
  label: string;
  amountInr: number;
  /** Shown under the line. Explains where the number came from. */
  detail: string;
  /** True for lines that are an expectation rather than a billed amount. */
  probabilistic?: boolean;
};

export type TrueCost = {
  stickerInr: number;
  /** What the buyer is actually billed at checkout. */
  payableNowInr: number;
  /** Payable plus the expected cost of a return. The number to compare on. */
  expectedTotalInr: number;
  /** Expected return cost alone, for display next to the seller's defect rate. */
  returnRiskInr: number;
  lines: CostLine[];
  /** Why this is or is not the cheapest option, in one sentence. */
  summary: string;
};

export type TrueCostInput = {
  priceInr: number;
  qty?: number;
  paymentMode: "COD" | "PREPAID";
  /** Delivery pincode tier, 1..4. */
  pinTier: number;
  /** The seller's historical defect rate, 0..100. */
  sellerDefectRatePct: number;
  /** Whether the policy would refund a defect at all. */
  refundable?: boolean;
};

/**
 * Add up what the buyer really pays. Pure and fully itemised: every line
 * carries the sentence that justifies it, because a total nobody can take
 * apart is just another number to distrust.
 */
export function trueCost(input: TrueCostInput): TrueCost {
  const qty = Math.max(1, Math.trunc(input.qty ?? 1));
  const sticker = Math.trunc(input.priceInr) * qty;
  const lines: CostLine[] = [
    {
      label: qty > 1 ? `Sticker price × ${qty}` : "Sticker price",
      amountInr: sticker,
      detail: qty > 1 ? `₹${Math.trunc(input.priceInr)} each` : "listed price",
    },
  ];

  if (input.paymentMode === "COD") {
    lines.push({
      label: "Cash-on-delivery fee",
      amountInr: COD_FEE_INR,
      detail: "courier handling charge for collecting cash at the door",
    });
  }

  const tier = clampTier(input.pinTier);
  const deliveryFee = sticker >= FREE_DELIVERY_ABOVE_INR ? 0 : (DELIVERY_FEE_BY_TIER[tier] ?? 40);
  if (deliveryFee > 0) {
    lines.push({
      label: "Delivery",
      amountInr: deliveryFee,
      detail: `tier-${tier} pincode; free above ₹${FREE_DELIVERY_ABOVE_INR.toLocaleString("en-IN")}`,
    });
  } else {
    lines.push({
      label: "Delivery",
      amountInr: 0,
      detail:
        sticker >= FREE_DELIVERY_ABOVE_INR
          ? `free above ₹${FREE_DELIVERY_ABOVE_INR.toLocaleString("en-IN")}`
          : `free to tier-${tier} pincodes`,
    });
  }

  const payableNow = lines.reduce((s, l) => s + l.amountInr, 0);

  // The expected cost of this seller failing. Not a charge — a probability
  // times a cost, which is exactly how the buyer should weigh a cheap seller
  // with a bad record against a dearer one with a good record.
  const defectRate = Math.max(0, Math.min(100, input.sellerDefectRatePct)) / 100;
  const refundable = input.refundable !== false;
  const returnRisk = Math.round(defectRate * RETURN_FRICTION_INR);

  if (defectRate > 0) {
    lines.push({
      label: "Return risk",
      amountInr: returnRisk,
      probabilistic: true,
      detail:
        `₹${RETURN_FRICTION_INR} of pickup and re-order hassle × ` +
        `${Math.round(defectRate * 100)}% of this seller's orders arriving faulty` +
        (refundable ? "" : " — and this category is not replaceable, only refundable"),
    });
  }

  const expectedTotal = payableNow + returnRisk;
  const added = expectedTotal - sticker;

  return {
    stickerInr: sticker,
    payableNowInr: payableNow,
    expectedTotalInr: expectedTotal,
    returnRiskInr: returnRisk,
    lines,
    summary:
      added === 0
        ? `₹${sticker.toLocaleString("en-IN")} is the whole cost — nothing is added at checkout.`
        : `₹${added.toLocaleString("en-IN")} more than the sticker once delivery` +
          `${input.paymentMode === "COD" ? ", the COD fee" : ""} and this seller's ` +
          `${Math.round(defectRate * 100)}% defect rate are counted.`,
  };
}

/* ────────────────────────── Delivery forecast ────────────────────────── */

/** Transit days by pincode tier — the same ladder `placeOrder` promises on. */
export const TRANSIT_DAYS_BY_TIER: Record<number, number> = { 1: 3, 2: 4, 3: 6, 4: 7 };

/** Each prior failed delivery to this buyer adds this much slack, capped. */
export const RTO_SLACK_DAYS = 1;
export const RTO_SLACK_CAP = 2;

/** COD parcels can be refused at the door, which costs a redelivery cycle. */
export const COD_SLACK_DAYS = 1;

/** The confidence we attach to the padded date. Stated, never implied. */
export const CONFIDENCE_PCT = 80;

export type DeliveryForecast = {
  /** Best estimate: dispatch SLA plus tier transit. */
  likelyAt: string;
  /** The date we are CONFIDENCE_PCT confident about. Always >= likelyAt. */
  confidentAt: string;
  confidencePct: number;
  /** Days of padding between the two, and why each day is there. */
  slackDays: number;
  reasons: string[];
  /** Set when a deadline was supplied. */
  deadline: null | {
    at: string;
    /** Does the likely date meet it? */
    likelyMeets: boolean;
    /** Does the confident date meet it? The honest answer to "will it arrive?" */
    confidentMeets: boolean;
    verdict: "SAFE" | "TIGHT" | "WILL_MISS";
    sentence: string;
  };
};

export type DeliveryForecastInput = {
  /** The seller's dispatch SLA in days. */
  sellerSlaDays: number;
  pinTier: number;
  paymentMode?: "COD" | "PREPAID";
  /** Prior return-to-origin count for this buyer. */
  buyerPriorRto?: number;
  /** Is the item in stock? Out of stock adds the restock wait. */
  inStock?: boolean;
  /** Days added when the item must be restocked before dispatch. */
  restockDays?: number;
};

/**
 * Forecast a delivery as an interval, not a promise.
 *
 * `likelyAt` is what another platform would print on its own. `confidentAt`
 * is the date that survives the things that actually go wrong — a tier-3
 * pincode, a COD refusal, a buyer the courier has already failed to reach.
 * Returning both, and saying which one to trust when a date matters, is the
 * whole point.
 */
export function deliveryForecast(
  input: DeliveryForecastInput,
  now: Date,
  deadline?: Date | string | null,
): DeliveryForecast {
  const reasons: string[] = [];
  const tier = clampTier(input.pinTier);

  const sla = Math.max(0, Math.trunc(input.sellerSlaDays));
  const transit = TRANSIT_DAYS_BY_TIER[tier] ?? 4;
  reasons.push(`seller dispatches in ${sla}d, then ${transit}d transit to a tier-${tier} pincode`);

  let base = sla + transit;

  if (input.inStock === false) {
    const restock = Math.max(0, Math.trunc(input.restockDays ?? 3));
    base += restock;
    reasons.push(`out of stock: ${restock}d restock before it can be dispatched`);
  }

  const likely = addDays(now, base);

  // Slack: each day traceable to a named reason, so the interval is arguable
  // rather than a vague hedge.
  let slack = 0;

  if (tier >= 3) {
    slack += 1;
    reasons.push(`tier-${tier} pincodes miss the quoted date more often — 1d of slack`);
  }

  const prior = Math.max(0, Math.trunc(input.buyerPriorRto ?? 0));
  if (prior > 0) {
    const add = Math.min(prior * RTO_SLACK_DAYS, RTO_SLACK_CAP);
    slack += add;
    reasons.push(`${prior} prior failed delivery to this address — ${add}d of slack`);
  }

  if ((input.paymentMode ?? "PREPAID") === "COD") {
    slack += COD_SLACK_DAYS;
    reasons.push(`COD can be refused at the door, costing a redelivery — ${COD_SLACK_DAYS}d of slack`);
  }

  if (slack === 0) {
    reasons.push("no risk factor on this route adds slack to the date");
  }

  const confident = addDays(likely, slack);

  const parsedDeadline = parseDate(deadline);
  let deadlineBlock: DeliveryForecast["deadline"] = null;

  if (parsedDeadline) {
    const likelyMeets = likely.getTime() <= parsedDeadline.getTime();
    const confidentMeets = confident.getTime() <= parsedDeadline.getTime();
    const verdict = confidentMeets ? "SAFE" : likelyMeets ? "TIGHT" : "WILL_MISS";

    deadlineBlock = {
      at: parsedDeadline.toISOString(),
      likelyMeets,
      confidentMeets,
      verdict,
      sentence:
        verdict === "SAFE"
          ? `Arrives by ${isoDay(confident)} even if the route goes badly, so it meets ${isoDay(parsedDeadline)}.`
          : verdict === "TIGHT"
            ? `Likely ${isoDay(likely)}, which meets ${isoDay(parsedDeadline)} — but ${CONFIDENCE_PCT}% ` +
              `confidence only reaches ${isoDay(confident)}. Prepaid removes a day of that risk if the date matters.`
            : `Even the likely date ${isoDay(likely)} is after ${isoDay(parsedDeadline)}. This will not arrive in time.`,
    };
  }

  return {
    likelyAt: likely.toISOString(),
    confidentAt: confident.toISOString(),
    confidencePct: CONFIDENCE_PCT,
    slackDays: slack,
    reasons,
    deadline: deadlineBlock,
  };
}

/* ───────────────────────────── Helpers ───────────────────────────── */

function clampTier(t: number): number {
  const n = Math.trunc(t);
  return Number.isFinite(n) ? Math.max(1, Math.min(4, n)) : 2;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

export function parseDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
