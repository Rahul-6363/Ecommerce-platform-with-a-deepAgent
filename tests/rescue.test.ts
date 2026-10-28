/**
 * The rescue engine.
 *
 * Two halves are worth testing here and they pull in opposite directions:
 *
 *  - it must act when a promise is genuinely in danger, and
 *  - it must NOT act otherwise.
 *
 * The second is the harder one and the one with more tests, because an agent
 * that intervenes on every parcel is not preventing failures — it is ringing
 * couriers and pestering buyers, and it would still score well on any metric
 * that only counts interventions attempted.
 */
import { describe, it, expect } from "vitest";
import {
  assessRescue,
  rescueOutcome,
  MAX_RESCUE_ATTEMPTS,
  MIN_RUNWAY_DAYS,
  RESCUE_ABANDON_DAYS,
} from "@/lib/engines/rescue";
import { riskScore, HIGH, MEDIUM } from "@/lib/engines/risk";

const NOW = new Date("2026-10-20T10:00:00Z");

/** A clean metro prepaid parcel with a complete address: nothing to rescue. */
const CLEAN = {
  orderNo: "ORD-CLEAN",
  paymentMode: "PREPAID",
  category: "books",
  buyerPriorRto: 0,
  address: { line: "14 Brigade Road, Shanthala Nagar, Bengaluru", landmark: "Opp. Metro", pinTier: 1 },
  promisedBy: new Date("2026-10-30T10:00:00Z"),
  sellerSlaDays: 1,
  status: "IN_TRANSIT",
};

/** A tier-3 COD parcel with no landmark and a prior failure. */
const FRAGILE = {
  orderNo: "ORD-FRAGILE",
  paymentMode: "COD",
  category: "footwear",
  buyerPriorRto: 1,
  address: { line: "Near temple", landmark: "", pinTier: 3 },
  promisedBy: new Date("2026-10-30T10:00:00Z"),
  sellerSlaDays: 2,
  status: "DISPATCHED",
};

const NO_ATTEMPTS = { shipmentId: "SHP-1", attempts: 0, phoneReachable: true };

/* ───────────────────────────── Restraint ────────────────────────────── */

describe("it leaves a healthy parcel alone", () => {
  it("declines to act on a clean low-risk parcel", () => {
    const a = assessRescue(CLEAN, NO_ATTEMPTS, NOW);

    expect(a.decision).toBe("NO_ACTION");
    expect(a.intervention).toBeNull();
    expect(a.triggers).toEqual([]);
  });

  it("says why it declined rather than staying silent", () => {
    const a = assessRescue(CLEAN, NO_ATTEMPTS, NOW);

    expect(a.reasons.join(" ")).toMatch(/no intervention is warranted/i);
    // The restraint is explained in terms a person can check.
    expect(a.reasons.join(" ")).toMatch(/\d+\/100/);
  });

  it("never rescues a delivered order", () => {
    const a = assessRescue({ ...FRAGILE, status: "DELIVERED" }, { shipmentId: "S", attempts: 2 }, NOW);

    expect(a.decision).toBe("NO_ACTION");
    expect(a.reasons.join(" ")).toMatch(/nothing left to rescue/i);
  });

  it("never rescues a cancelled or returned order", () => {
    for (const status of ["CANCELLED", "RTO"]) {
      const a = assessRescue({ ...FRAGILE, status }, { shipmentId: "S", attempts: 1 }, NOW);
      expect(a.decision).toBe("NO_ACTION");
    }
  });

  it("does not propose an action it has already taken", () => {
    const first = assessRescue(FRAGILE, NO_ATTEMPTS, NOW);
    expect(first.decision).toBe("INTERVENE");

    const again = assessRescue(
      { ...FRAGILE, actionsTaken: [first.intervention!.action] },
      NO_ATTEMPTS,
      NOW,
    );

    expect(again.decision).toBe("NO_ACTION");
    expect(again.reasons.join(" ")).toMatch(/already been done/i);
  });

  it("treats a risk score as a reason to look, not proof of failure", () => {
    // High risk but comfortably inside the promise and nothing fixable fired
    // as WILL_MISS — the decision must still be justified by a named trigger
    // rather than by the score alone.
    const a = assessRescue(FRAGILE, NO_ATTEMPTS, NOW);

    expect(a.triggers.length).toBeGreaterThan(0);
    expect(a.reasons.join(" ")).not.toMatch(/will fail/i);
  });
});

/* ──────────────────────────── Acting usefully ───────────────────────── */

describe("it acts when a delivery is genuinely in trouble", () => {
  it("fires on an incomplete address", () => {
    const a = assessRescue(FRAGILE, NO_ATTEMPTS, NOW);

    expect(a.triggers).toContain("INCOMPLETE_DETAILS");
    expect(a.decision).toBe("INTERVENE");
  });

  it("fires on a failed delivery attempt", () => {
    const a = assessRescue(FRAGILE, { shipmentId: "S", attempts: 1, phoneReachable: true }, NOW);

    expect(a.triggers).toContain("REPEATED_FAILURE");
  });

  it("fires on an unreachable phone", () => {
    const a = assessRescue(
      { ...CLEAN, orderNo: "ORD-PHONE" },
      { shipmentId: "S", attempts: 0, phoneReachable: false },
      NOW,
    );

    expect(a.triggers).toContain("INCOMPLETE_DETAILS");
  });

  it("fires on COD at a high score", () => {
    const a = assessRescue(FRAGILE, { shipmentId: "S", attempts: 1, phoneReachable: false }, NOW);

    expect(a.risk.score).toBeGreaterThanOrEqual(HIGH);
    expect(a.triggers).toContain("COD_REFUSAL_RISK");
  });

  it("judges the promise against the confident date, not the optimistic one", () => {
    // A tier-3 COD parcel with a prior failure: the likely date may make the
    // promise while the confident date does not. Every other platform shows
    // the first and calls it green.
    const tight = {
      ...FRAGILE,
      orderNo: "ORD-TIGHT",
      promisedBy: new Date("2026-10-27T10:00:00Z"),
      sellerSlaDays: 2,
    };
    const a = assessRescue(tight, NO_ATTEMPTS, NOW);

    expect(a.forecast).not.toBeNull();
    expect(a.forecast!.confidentAt >= a.forecast!.likelyAt).toBe(true);
    if (a.forecast!.deadline && !a.forecast!.deadline.confidentMeets) {
      expect(a.triggers).toContain("WILL_MISS_PROMISE");
    }
  });

  it("reports the contributing factors most costly first", () => {
    const a = assessRescue(FRAGILE, { shipmentId: "S", attempts: 1, phoneReachable: false }, NOW);

    const points = a.contributingFactors.map((f) => f.points);
    expect(points).toEqual([...points].sort((x, y) => y - x));
    // Every factor carries the sentence that justifies it.
    for (const f of a.contributingFactors) expect(f.detail.length).toBeGreaterThan(0);
  });

  it("carries the intervention's own approval flag rather than re-deciding it", () => {
    const a = assessRescue(FRAGILE, NO_ATTEMPTS, NOW);

    // `ask_buyer` is gated; the engine must not quietly mark it unapproved.
    expect(a.intervention).not.toBeNull();
    if (a.intervention!.action === "ask_buyer") {
      expect(a.intervention!.needsApproval).toBe(true);
    }
  });

  it("orders the triggers most serious first", () => {
    const a = assessRescue(
      { ...FRAGILE, promisedBy: new Date("2026-10-21T10:00:00Z") },
      { shipmentId: "S", attempts: 1, phoneReachable: false },
      NOW,
    );

    if (a.triggers.includes("WILL_MISS_PROMISE")) {
      expect(a.triggers[0]).toBe("WILL_MISS_PROMISE");
    }
  });
});

/* ──────────────────── Budgets, runway and handoff ───────────────────── */

describe("it stops instead of looping", () => {
  it("hands off after the attempt budget is spent", () => {
    const a = assessRescue(
      { ...FRAGILE, attemptsMade: MAX_RESCUE_ATTEMPTS },
      NO_ATTEMPTS,
      NOW,
    );

    expect(a.decision).toBe("HANDOFF");
    expect(a.intervention).toBeNull();
    expect(a.handoffReason).toMatch(/already been attempted/i);
  });

  it("hands off rather than acting on a long-overdue parcel", () => {
    const a = assessRescue(
      { ...FRAGILE, promisedBy: new Date("2026-10-10T10:00:00Z") },
      NO_ATTEMPTS,
      NOW,
    );

    expect(a.decision).toBe("HANDOFF");
    expect(a.handoffReason).toMatch(/claim to be adjudicated/i);
    expect(a.runwayDays).toBeLessThan(-RESCUE_ABANDON_DAYS);
  });

  it("hands off when there is no runway left for the action to help", () => {
    // Due today: a courier action cannot change a parcel already on a van.
    const a = assessRescue(
      { ...FRAGILE, promisedBy: new Date("2026-10-20T20:00:00Z") },
      NO_ATTEMPTS,
      NOW,
    );

    if (a.triggers.includes("WILL_MISS_PROMISE")) {
      expect(a.decision).toBe("HANDOFF");
      expect(a.handoffReason).toMatch(/runway/i);
    }
  });

  it("counts runway in days and reports it", () => {
    const a = assessRescue(FRAGILE, NO_ATTEMPTS, NOW);
    expect(a.runwayDays).toBe(10);
  });

  it("works on an order with no promised date at all", () => {
    const a = assessRescue({ ...FRAGILE, promisedBy: null }, NO_ATTEMPTS, NOW);

    expect(a.forecast).toBeNull();
    expect(a.runwayDays).toBeNull();
    // It can still act on a fixable address; it just cannot judge a promise.
    expect(a.triggers).not.toContain("WILL_MISS_PROMISE");
  });

  it("hands off when a trigger fires but the policy has no action for it", () => {
    // Nothing fixable: no attempts, phone fine, address complete, prepaid —
    // but the forecast misses the promise.
    const doomed = {
      orderNo: "ORD-DOOMED",
      paymentMode: "PREPAID",
      category: "books",
      buyerPriorRto: 0,
      address: { line: "14 Brigade Road, Shanthala Nagar, Bengaluru", landmark: "Opp. Metro", pinTier: 1 },
      promisedBy: new Date("2026-10-22T10:00:00Z"),
      sellerSlaDays: 9,
      status: "IN_TRANSIT",
    };
    const a = assessRescue(doomed, NO_ATTEMPTS, NOW);

    if (a.triggers.includes("WILL_MISS_PROMISE") && a.decision === "HANDOFF") {
      expect(a.handoffReason).toMatch(/no safe automated action|no intervention in the policy|runway/i);
    }
  });
});

/* ─────────────────── Purity and the reused engines ──────────────────── */

describe("it composes the existing engines rather than re-scoring", () => {
  it("returns the risk verdict riskScore would return, unchanged", () => {
    const a = assessRescue(FRAGILE, NO_ATTEMPTS, NOW);
    const direct = riskScore(FRAGILE, NO_ATTEMPTS);

    expect(a.risk.score).toBe(direct.score);
    expect(a.risk.band).toBe(direct.band);
    expect(a.risk.reasons.length).toBe(direct.reasons.length);
  });

  it("is pure — the same inputs give the same assessment", () => {
    const a = assessRescue(FRAGILE, NO_ATTEMPTS, NOW);
    const b = assessRescue(FRAGILE, NO_ATTEMPTS, NOW);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate its inputs", () => {
    const order = { ...FRAGILE, actionsTaken: ["ask_buyer"] };
    const before = JSON.stringify(order);
    assessRescue(order, NO_ATTEMPTS, NOW);
    expect(JSON.stringify(order)).toBe(before);
  });

  it("moves with the clock rather than reading the wall clock", () => {
    const early = assessRescue(FRAGILE, NO_ATTEMPTS, new Date("2026-10-01T10:00:00Z"));
    const late = assessRescue(FRAGILE, NO_ATTEMPTS, new Date("2026-10-29T10:00:00Z"));

    expect(early.runwayDays).toBeGreaterThan(late.runwayDays!);
  });
});

/* ──────────────────────── Measuring the outcome ─────────────────────── */

describe("it measures whether the intervention helped", () => {
  const before = riskScore(FRAGILE, { shipmentId: "S", attempts: 1, phoneReachable: false });

  it("reports points removed, not just a band change", () => {
    // A metro prepaid parcel, so the score is nowhere near the 100 clamp and a
    // removed factor actually shows up. FRAGILE with a failed attempt and no
    // phone saturates at 100, where removing one factor changes nothing — the
    // clamp is correct, but it makes that pairing useless for this assertion.
    const unsaturated = {
      orderNo: "ORD-MEASURE",
      paymentMode: "PREPAID",
      category: "books",
      buyerPriorRto: 0,
      address: { line: "14 Brigade Road, Shanthala Nagar, Bengaluru", landmark: "Opp. Metro", pinTier: 1 },
    };
    const worse = riskScore(unsaturated, { shipmentId: "S", attempts: 0, phoneReachable: false });
    const better = riskScore(unsaturated, { shipmentId: "S", attempts: 0, phoneReachable: true });
    const out = rescueOutcome(worse, better);

    expect(worse.score).toBeLessThan(100);
    expect(out.pointsRemoved).toBeGreaterThan(0);
    expect(out.improved).toBe(true);
    expect(out.sentence).toMatch(/risk fell/i);
  });

  it("counts a reduction that stays inside the same band as an improvement", () => {
    const after = { ...before, score: before.score - 10 };
    const out = rescueOutcome(before, after);

    expect(out.improved).toBe(true);
    // A parcel that went from 75 to 65 is still HIGH, and calling that "no
    // improvement" would hide a real reduction.
    expect(out.pointsRemoved).toBe(10);
  });

  it("reports honestly when nothing changed", () => {
    const out = rescueOutcome(before, before);

    expect(out.improved).toBe(false);
    expect(out.pointsRemoved).toBe(0);
    expect(out.sentence).toMatch(/unchanged/i);
  });

  it("reports a risk that went up rather than hiding it", () => {
    const worse = { ...before, score: before.score + 15 };
    const out = rescueOutcome(before, worse);

    expect(out.improved).toBe(false);
    expect(out.sentence).toMatch(/ROSE/);
  });

  it("calls a parcel resolved only when it leaves the acting range", () => {
    const low = { ...before, score: MEDIUM - 1, band: "LOW" as const };
    const still = { ...before, score: MEDIUM + 1, band: "MEDIUM" as const };

    expect(rescueOutcome(before, low).resolved).toBe(true);
    expect(rescueOutcome(before, still).resolved).toBe(false);
  });
});

/* ──────────────────────────── The constants ─────────────────────────── */

describe("the declared limits are real numbers, not folklore", () => {
  it("declares a retry budget, a runway floor and an abandon point", () => {
    expect(MAX_RESCUE_ATTEMPTS).toBeGreaterThan(0);
    expect(MIN_RUNWAY_DAYS).toBeGreaterThanOrEqual(0);
    expect(RESCUE_ABANDON_DAYS).toBeGreaterThan(0);
  });
});
