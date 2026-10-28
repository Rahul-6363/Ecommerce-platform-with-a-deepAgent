/**
 * Order rescue — PURE. No model, no clock, no I/O, no database.
 *
 * The platform already scored dispatched parcels and proposed one
 * intervention. What it did not do is ask the question a rescue actually turns
 * on: **is this parcel going to miss the date it promised, and is there still
 * time to do something about it?** A risk band says a parcel is fragile. It
 * does not say the promise is in danger, and it does not say whether acting
 * today is any better than acting tomorrow.
 *
 * So this engine composes the two engines that already exist rather than
 * scoring anything itself:
 *
 *   `riskScore()`        — how likely is this delivery to fail, and why
 *   `deliveryForecast()` — when will it realistically arrive, as an interval
 *
 * and adds the three judgements that need both:
 *
 *  1. **Is the promise actually at risk?** Judged against the *confident*
 *     date, never the optimistic one — the same rule `/find` uses when it
 *     refuses to promise a deadline it cannot make. A parcel that is risky but
 *     comfortably early is not an emergency.
 *  2. **Is intervening justified?** A LOW-risk parcel with a safe forecast
 *     gets nothing, and that restraint is reported rather than silent. An
 *     agent that acts on every order is not preventing failures, it is
 *     generating noise and pestering buyers.
 *  3. **Is there still time?** An intervention that lands after the parcel
 *     was already due prevents nothing. Past the point of usefulness the
 *     honest output is a handoff, not a courier call.
 *
 * Everything this returns is a *proposal*. It holds no authority: the tool
 * registry decides what may run unapproved, and `chooseIntervention`'s own
 * `needsApproval` flag is carried through unchanged rather than re-derived
 * here. This file cannot authorise anything, which is why it is safe for it to
 * be the thing that decides what to attempt.
 */
import { riskScore, chooseIntervention, HIGH, MEDIUM, type Intervention, type RiskOrder, type RiskShipment } from "@/lib/engines/risk";
import { deliveryForecast, parseDate, isoDay } from "@/lib/engines/offers";
import type { RiskReason, RiskVerdict } from "@/lib/types";

/** A parcel already past this many days overdue is a claim, not a rescue. */
export const RESCUE_ABANDON_DAYS = 3;

/** Attempts on one order before the agent stops proposing and hands off. */
export const MAX_RESCUE_ATTEMPTS = 3;

/**
 * How close to the promise is "too late to help".
 *
 * A courier action placed the day before a parcel is due does not change the
 * outcome: the parcel is already on a van. Below this many days of runway the
 * honest answer is to tell a person rather than to act.
 */
export const MIN_RUNWAY_DAYS = 1;

/** What the engine concluded about one order. */
export type RescueTrigger =
  /** The confident date is past the promise. The commonest real rescue. */
  | "WILL_MISS_PROMISE"
  /** No landmark, short address, unreachable phone — fixable before dispatch. */
  | "INCOMPLETE_DETAILS"
  /** The courier has already failed at the door at least once. */
  | "REPEATED_FAILURE"
  /** High risk and cash on delivery: refusable at the door. */
  | "COD_REFUSAL_RISK";

export type RescueDecision =
  /** Act or ask: a justified intervention exists. */
  | "INTERVENE"
  /** Nothing is wrong enough to act on, and that is reported. */
  | "NO_ACTION"
  /** Something is wrong but no safe action remains. A person decides. */
  | "HANDOFF";

export type RescueOrderInput = RiskOrder & {
  /** The date the buyer was promised. Without it there is no promise to rescue. */
  promisedBy?: Date | string | null;
  /** Dispatch SLA for the seller on this order, for the forecast. */
  sellerSlaDays?: number;
  /** Already-delivered or cancelled orders are never rescued. */
  status?: string;
  /** Interventions already attempted on this order, for the retry limit. */
  attemptsMade?: number;
  /** Actions already taken, so the same one is never proposed twice. */
  actionsTaken?: string[];
};

export type RescueAssessment = {
  orderNo: string;
  decision: RescueDecision;
  /** Every trigger that fired, most serious first. */
  triggers: RescueTrigger[];
  /** Straight from `riskScore`. Not recomputed, not adjusted. */
  risk: RiskVerdict;
  /** The forecast interval, judged against the promise. */
  forecast: ReturnType<typeof deliveryForecast> | null;
  /** Days between now and the promised date. Negative when already overdue. */
  runwayDays: number | null;
  /** The contributing factors that justify acting, most costly first. */
  contributingFactors: RiskReason[];
  /**
   * What to attempt. Null for NO_ACTION and HANDOFF.
   *
   * `needsApproval` is `chooseIntervention`'s own flag, carried through. The
   * registry still enforces the gate independently — this is a proposal.
   */
  intervention: Intervention | null;
  /** Why this decision, in sentences a person can argue with. */
  reasons: string[];
  /** Set on HANDOFF: what a person needs to decide. */
  handoffReason: string;
};

/**
 * Should this order be rescued, and how?
 *
 * Deterministic and side-effect free: the same order and shipment always
 * produce the same assessment, which is what makes the intervention precision
 * measurable in the eval suite rather than anecdotal.
 */
export function assessRescue(
  order: RescueOrderInput,
  shipment: RiskShipment,
  now: Date,
): RescueAssessment {
  const orderNo = order.orderNo ?? "";
  const reasons: string[] = [];

  // The existing engine, called not reimplemented. Every point of the score
  // and every named factor comes from there.
  const risk = riskScore(order, shipment);

  /* ── Is there a promise, and how much runway is left? ───────────── */

  const promised = parseDate(order.promisedBy);
  const runwayDays =
    promised === null
      ? null
      : Math.floor((promised.getTime() - now.getTime()) / 86_400_000);

  // The forecast, from the same function `/find` uses, judged against the
  // promise. `confidentMeets` is the honest answer to "will it arrive in
  // time" — the likely date is the one every other platform shows.
  const forecast =
    promised === null
      ? null
      : deliveryForecast(
          {
            // Already dispatched, so there is no dispatch wait left to count.
            sellerSlaDays: Math.max(0, Math.trunc(order.sellerSlaDays ?? 0)),
            pinTier: order.address?.pinTier ?? 2,
            paymentMode: (order.paymentMode ?? "PREPAID").toUpperCase() === "COD" ? "COD" : "PREPAID",
            buyerPriorRto: order.buyerPriorRto,
            inStock: true,
          },
          now,
          promised,
        );

  /* ── Which problems actually fired ──────────────────────────────── */

  const factors = new Set(risk.reasons.map((r) => r.factor));
  const attempts = Math.trunc(shipment.attempts ?? 0);
  const cod = (order.paymentMode ?? "").toUpperCase() === "COD";

  const triggers: RescueTrigger[] = [];

  if (forecast?.deadline && !forecast.deadline.confidentMeets) {
    triggers.push("WILL_MISS_PROMISE");
    reasons.push(
      `the date we are ${forecast.confidencePct}% confident about is ` +
        `${forecast.confidentAt} against a promise of ${isoDay(promised!)} — ` +
        forecast.deadline.sentence,
    );
  }

  if (attempts >= 1) {
    triggers.push("REPEATED_FAILURE");
    reasons.push(`${attempts} delivery attempt(s) have already failed at the door`);
  }

  if (factors.has("address_quality") || shipment.phoneReachable === false) {
    triggers.push("INCOMPLETE_DETAILS");
    reasons.push(
      shipment.phoneReachable === false
        ? "the courier cannot reach the buyer by phone, which is the commonest cause of a failed attempt"
        : "the delivery address is missing the detail a courier needs to find it first time",
    );
  }

  if (cod && risk.score >= HIGH) {
    triggers.push("COD_REFUSAL_RISK");
    reasons.push(
      `cash on delivery on a parcel scoring ${risk.score}/100 — refusable at the door, ` +
        "and a refusal costs the whole delivery",
    );
  }

  // Most serious first, so the operator reads the reason that matters.
  const ORDER_OF_SERIOUSNESS: RescueTrigger[] = [
    "WILL_MISS_PROMISE", "REPEATED_FAILURE", "COD_REFUSAL_RISK", "INCOMPLETE_DETAILS",
  ];
  triggers.sort(
    (a, b) => ORDER_OF_SERIOUSNESS.indexOf(a) - ORDER_OF_SERIOUSNESS.indexOf(b),
  );

  const contributingFactors = [...risk.reasons].sort((a, b) => b.points - a.points);

  const base: Omit<RescueAssessment, "decision" | "intervention" | "handoffReason"> = {
    orderNo, triggers, risk, forecast, runwayDays, contributingFactors, reasons,
  };

  /* ── Terminal states are never rescued ──────────────────────────── */

  const status = (order.status ?? "").toUpperCase();
  if (status === "DELIVERED" || status === "CANCELLED" || status === "RTO") {
    return {
      ...base,
      decision: "NO_ACTION",
      intervention: null,
      handoffReason: "",
      reasons: [`order is ${status}; there is nothing left to rescue`],
      triggers: [],
    };
  }

  /* ── Nothing wrong: say so, rather than acting to look busy ─────── */

  if (triggers.length === 0) {
    return {
      ...base,
      decision: "NO_ACTION",
      intervention: null,
      handoffReason: "",
      reasons: [
        `risk ${risk.score}/100 (${risk.band})` +
          (forecast?.deadline ? ` and the confident date meets the promise` : "") +
          " — no intervention is warranted, and acting anyway would pester the buyer",
      ],
    };
  }

  /* ── Retry limit, before anything is proposed ───────────────────── */

  const attemptsMade = Math.max(0, Math.trunc(order.attemptsMade ?? 0));
  if (attemptsMade >= MAX_RESCUE_ATTEMPTS) {
    return {
      ...base,
      decision: "HANDOFF",
      intervention: null,
      handoffReason:
        `${attemptsMade} interventions have already been attempted on this order and it is ` +
        "still at risk — a person should decide rather than the agent trying a fourth time",
    };
  }

  /* ── Too late to help ───────────────────────────────────────────── */

  if (runwayDays !== null && runwayDays < -RESCUE_ABANDON_DAYS) {
    return {
      ...base,
      decision: "HANDOFF",
      intervention: null,
      handoffReason:
        `the promised date passed ${Math.abs(runwayDays)} days ago — this is a claim to be ` +
        "adjudicated, not a delivery to be rescued",
    };
  }

  /* ── What to attempt ────────────────────────────────────────────── */

  // The existing deterministic policy decides the action and whether it is
  // gated. Re-deciding either here would create a second authority that could
  // disagree with the one the risk page and the watcher already show.
  const proposed = chooseIntervention(order, shipment, risk);

  if (!proposed) {
    // Something is wrong but the policy has no action for it. That is a
    // handoff, not a shrug: a MEDIUM parcel with a doomed forecast and no
    // fixable factor is exactly what a person should see.
    return {
      ...base,
      decision: "HANDOFF",
      intervention: null,
      handoffReason:
        `${triggers[0]} fired but no intervention in the policy addresses it — ` +
        "no safe automated action remains",
    };
  }

  // Never propose what has already been done. Idempotency at the decision
  // layer, so a second tick on the same order does not re-ask the buyer the
  // question they are already looking at.
  const alreadyDone = (order.actionsTaken ?? []).includes(proposed.action);
  if (alreadyDone) {
    return {
      ...base,
      decision: "NO_ACTION",
      intervention: null,
      handoffReason: "",
      reasons: [
        ...reasons,
        `${proposed.action} has already been done on this order — not repeating it`,
      ],
    };
  }

  // An action that cannot land in time prevents nothing.
  if (runwayDays !== null && runwayDays < MIN_RUNWAY_DAYS && triggers.includes("WILL_MISS_PROMISE")) {
    return {
      ...base,
      decision: "HANDOFF",
      intervention: null,
      handoffReason:
        `only ${runwayDays}d of runway left before the promised date — ${proposed.action} ` +
        "cannot change the outcome now, so a person should decide what the buyer is told",
    };
  }

  reasons.push(
    `${proposed.action} ${proposed.needsApproval ? "proposed for approval" : "is reversible and may run now"}: ` +
      proposed.expectedEffect,
  );

  return {
    ...base,
    decision: "INTERVENE",
    intervention: proposed,
    handoffReason: "",
    reasons,
  };
}

/**
 * Did the intervention help?
 *
 * Re-scoring after an action is what separates a rescue from a gesture. The
 * comparison is deliberately on the *score*, not the band: a parcel that went
 * from 75 to 62 is still HIGH, and reporting that as "no improvement" would
 * hide a real reduction.
 *
 * Pure, so the eval suite can assert the arithmetic of a rescue rather than
 * trusting a log line.
 */
export function rescueOutcome(
  before: RiskVerdict,
  after: RiskVerdict,
): {
  improved: boolean;
  pointsRemoved: number;
  bandChanged: boolean;
  /** True when the parcel is no longer in a band that warrants acting. */
  resolved: boolean;
  sentence: string;
} {
  const pointsRemoved = before.score - after.score;
  const bandChanged = before.band !== after.band;
  const resolved = after.score < MEDIUM;

  return {
    improved: pointsRemoved > 0,
    pointsRemoved,
    bandChanged,
    resolved,
    sentence:
      pointsRemoved > 0
        ? `risk fell ${pointsRemoved} points to ${after.score}/100 (${after.band})` +
          (resolved ? " — no longer warrants intervention" : "")
        : pointsRemoved === 0
          ? `risk unchanged at ${after.score}/100 (${after.band})`
          : `risk ROSE ${Math.abs(pointsRemoved)} points to ${after.score}/100 (${after.band})`,
  };
}

export { HIGH, MEDIUM };
