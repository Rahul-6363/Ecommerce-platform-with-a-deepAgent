/**
 * Entitlement engine — a PURE DETERMINISTIC FUNCTION. No model call inside.
 *
 * Eligibility, remedy, amount and deadline come only from here. The language
 * model classifies the complaint and writes prose; it never does arithmetic on
 * someone's refund. Every branch appends a human-readable reason, so the
 * operator sees why, not just what.
 */
import type { EvidenceFlags, IssueType, Remedy, Verdict } from "@/lib/types";

export const GRACE_DAYS = 2;
export const PARTIAL_PCT = 0.15;
export const LATE_CREDIT_PCT = 0.05;
export const LATE_CREDIT_CAP = 200;
export const AMBIGUOUS_CONFIDENCE = 0.55;
export const MAX_CONFIDENCE = 0.95;

/** issue_type -> remedy priority list, walked in order; first FEASIBLE wins. */
const PRIORITY: Record<IssueType, Remedy[]> = {
  NOT_DELIVERED: ["RESHIP", "FULL_REFUND"],
  DOA: ["REPLACEMENT", "FULL_REFUND"],
  DAMAGED: ["REPLACEMENT", "FULL_REFUND"],
  WRONG_ITEM: ["REPLACEMENT", "FULL_REFUND"],
  MISSING_PART: ["PART_SHIPMENT", "PARTIAL_REFUND"],
  COUNTERFEIT: ["FULL_REFUND"],
  NOT_AS_DESCRIBED: ["FULL_REFUND"],
  LATE: ["STORE_CREDIT", "NONE"],
};

/** issue_type -> evidence flags, any one of which earns full confidence. */
const REQUIRED_EVIDENCE: Record<IssueType, string[]> = {
  NOT_DELIVERED: ["no_delivery_scan"],
  DOA: ["photo", "stated_fault"],
  DAMAGED: ["photo"],
  WRONG_ITEM: ["photo", "sku_mismatch"],
  MISSING_PART: ["stated_missing"],
  COUNTERFEIT: ["brand_mismatch"],
  NOT_AS_DESCRIBED: ["listing_comparison"],
  LATE: ["late_scan"],
};

export type EntitlementOrder = {
  amountInr: number;
  deliveredAt?: Date | string | null;
  promisedBy?: Date | string | null;
  stockAvailable?: boolean;
  buyerPriority?: "speed" | "money";
};

export type EntitlementPolicy = {
  returnWindowDays: number;
  replacementAllowed: boolean;
  refundSlaDays: number;
  lateCompensation: boolean;
  clauses: { id: string; text: string; tags: string[] }[];
};

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function parseDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function verdict(
  eligible: boolean,
  remedy: Remedy,
  alternatives: string[],
  amountInr: number,
  deadlineAt: string | null,
  clauseIds: string[],
  reasons: string[],
  confidence: number,
): Verdict {
  return {
    eligible,
    remedy,
    alternatives: [...alternatives],
    amountInr: Math.trunc(amountInr),
    deadlineAt,
    clauseIds: [...clauseIds],
    reasons: [...reasons],
    confidence,
  };
}

/**
 * Return a Verdict. Pure: the same inputs always give the same output, so it is
 * unit-testable and reproducible months after the fact.
 */
export function checkEntitlement(
  order: EntitlementOrder,
  policy: EntitlementPolicy,
  issueType: string,
  evidenceFlags: EvidenceFlags,
  now: Date,
): Verdict {
  const flags: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(evidenceFlags ?? {})) flags[k] = Boolean(v);

  const reasons: string[] = [];
  const alternatives: string[] = [];
  const clauses = policy.clauses ?? [];
  const amountCap = Math.trunc(order.amountInr);

  if (!(issueType in PRIORITY)) {
    return verdict(false, "ESCALATE_AMBIGUOUS", [], 0, null, [],
      [`unknown issue type '${issueType}'`], 0);
  }
  const issue = issueType as IssueType;

  // 1. Resolve the window the claim is judged against.
  const deliveredAt = parseDate(order.deliveredAt);
  const promisedBy = parseDate(order.promisedBy);

  let base: Date | null;
  let limit: number;
  let basis: string;

  if (issue === "NOT_DELIVERED") {
    base = promisedBy;
    limit = GRACE_DAYS;
    basis = `promised delivery date + ${GRACE_DAYS}d grace`;
  } else {
    base = deliveredAt;
    limit = Math.trunc(policy.returnWindowDays);
    basis = `delivery date + ${limit}d return window`;
  }

  if (base === null) {
    const why = issue === "NOT_DELIVERED"
      ? "no promised delivery date on the shipment"
      : "order has no delivery scan but the issue is not non-delivery; cannot establish a window";
    return verdict(false, "ESCALATE_AMBIGUOUS", [], 0, null, [], [why], 0.3);
  }

  // Counterfeit gets a doubled window: the buyer often cannot tell at once.
  if (issue === "COUNTERFEIT") {
    limit *= 2;
    basis = `delivery date + ${limit}d (counterfeit window doubled)`;
  }

  const windowEnd = addDays(base, limit);
  reasons.push(`window checked against ${basis}, expiring ${isoDay(windowEnd)}`);

  // 2. Outside the window is an honest no — still a correct answer.
  if (now > windowEnd) {
    const wc = matchClauses(clauses, new Set(["window", issue.toLowerCase()]));
    const daysLate = Math.floor((now.getTime() - windowEnd.getTime()) / 86_400_000);
    reasons.push(
      `claim raised ${daysLate}d after the ${limit}-day window closed` +
        (wc.length ? ` (clause ${wc[0]})` : ""),
    );
    return verdict(false, "NONE", PRIORITY[issue], 0, null, wc, reasons, 0.9);
  }

  // 3. Walk the remedy priority list; take the first feasible one.
  const stock = order.stockAvailable !== false;
  const replacementOk = Boolean(policy.replacementAllowed);
  const lateComp = Boolean(policy.lateCompensation);

  const feasible: Remedy[] = [];
  for (const r of PRIORITY[issue]) {
    const [ok, why] = isFeasible(r, replacementOk, stock, lateComp);
    if (ok) feasible.push(r);
    else alternatives.push(`${r} — ${why}`);
  }

  if (feasible.length === 0) {
    reasons.push("no remedy in the priority list is feasible under this policy");
    return verdict(false, "NONE", alternatives, 0, null,
      matchClauses(clauses, new Set([issue.toLowerCase()])), reasons, 0.8);
  }

  const buyerPriority = order.buyerPriority ?? "money";
  const remedy = tiebreak(feasible, buyerPriority);
  for (const r of feasible) {
    if (r !== remedy) {
      alternatives.push(
        `${r} — feasible, not chosen: buyer prefers ${buyerPriority}, which selects ${remedy}`,
      );
    }
  }
  reasons.push(`remedy ${remedy} is the first feasible option for ${issue}`);

  // 4. Amount. Hard invariant: the payout never exceeds the order value.
  let amount = amountFor(remedy, amountCap, reasons);
  amount = Math.max(0, Math.min(amount, amountCap));

  let eligible: boolean;
  if (remedy === "NONE") {
    eligible = false;
    reasons.push("policy offers no compensation for this issue");
  } else {
    eligible = true;
  }

  // 5. Deadline from the policy SLA — never a model-invented date.
  const deadline = addDays(now, Math.trunc(policy.refundSlaDays));
  reasons.push(`deadline = now + ${policy.refundSlaDays}d refund SLA`);

  // 6. Grounding: clauses tagged with this issue type, preferring those that
  // also name the chosen remedy, so a DOA remedy cites the DOA clause and not
  // every clause that happens to mention replacement.
  let clauseIds = matchClauses(clauses, new Set([remedy.toLowerCase()]), issue.toLowerCase());
  if (clauseIds.length === 0) {
    clauseIds = matchClauses(clauses, new Set([issue.toLowerCase()]));
  }

  // 7. Confidence, additive and explained.
  let conf = 0.5;
  const req = REQUIRED_EVIDENCE[issue] ?? [];
  const present = req.filter((f) => flags[f]);
  if (req.length === 0 || present.length > 0) {
    conf += 0.2;
    reasons.push(`required evidence present (${present.join(", ") || "n/a"})`);
  } else {
    reasons.push(`required evidence missing (expected one of: ${req.join(", ")})`);
  }

  if (clauseIds.length > 0) {
    conf += 0.2;
    reasons.push(`grounded in clause(s) ${clauseIds.join(", ")}`);
  } else {
    conf -= 0.3;
    reasons.push("no clause matched this issue and remedy");
  }

  if (flags.tracking_corroborates) {
    conf += 0.1;
    reasons.push("courier tracking record corroborates the complaint");
  }
  if (flags.image_supports_claim) {
    conf += 0.1;
    reasons.push("uploaded photograph is consistent with the stated defect");
  }
  if (flags.image_contradicts_claim) {
    conf -= 0.3;
    reasons.push("uploaded photograph does not show the stated defect");
  }
  if (flags.conflicting_evidence) {
    conf -= 0.25;
    reasons.push("evidence on this product conflicts between sources");
  }

  // Capped below 1.0: the buyer's evidence is self-reported, so the engine
  // never claims certainty it cannot have.
  conf = Math.round(Math.max(0, Math.min(MAX_CONFIDENCE, conf)) * 100) / 100;

  if (conf < AMBIGUOUS_CONFIDENCE) {
    reasons.push(
      `confidence ${conf} is below the ${AMBIGUOUS_CONFIDENCE} threshold — ` +
        "routing to a human rather than acting",
    );
    return verdict(false, "ESCALATE_AMBIGUOUS", alternatives, 0, null, clauseIds, reasons, conf);
  }

  return verdict(
    eligible, remedy, alternatives, amount,
    deadline.toISOString(), clauseIds, reasons, conf,
  );
}

function isFeasible(
  remedy: Remedy,
  replacementOk: boolean,
  stock: boolean,
  lateComp: boolean,
): [boolean, string] {
  if (remedy === "REPLACEMENT") {
    if (!replacementOk) return [false, "policy does not permit replacement for this category"];
    if (!stock) return [false, "seller has no replacement stock"];
    return [true, ""];
  }
  if (remedy === "RESHIP") {
    return stock ? [true, ""] : [false, "seller has no stock to reship"];
  }
  if (remedy === "PART_SHIPMENT") {
    return stock ? [true, ""] : [false, "missing component not in stock"];
  }
  if (remedy === "STORE_CREDIT") {
    return lateComp ? [true, ""] : [false, "policy offers no late-delivery compensation"];
  }
  return [true, ""];
}

/** speed prefers goods remedies; money prefers cash back. */
function tiebreak(feasible: Remedy[], buyerPriority: "speed" | "money"): Remedy {
  if (feasible.length === 1) return feasible[0];
  const order: Remedy[] = buyerPriority === "speed"
    ? ["REPLACEMENT", "RESHIP", "PART_SHIPMENT"]
    : ["FULL_REFUND", "PARTIAL_REFUND"];
  for (const r of order) if (feasible.includes(r)) return r;
  return feasible[0];
}

function amountFor(remedy: Remedy, cap: number, reasons: string[]): number {
  if (remedy === "FULL_REFUND") {
    reasons.push(`amount = full order value Rs ${cap}`);
    return cap;
  }
  if (remedy === "PARTIAL_REFUND") {
    const amt = Math.round(cap * PARTIAL_PCT);
    reasons.push(`amount = ${Math.round(PARTIAL_PCT * 100)}% of Rs ${cap} = Rs ${amt}`);
    return amt;
  }
  if (remedy === "STORE_CREDIT") {
    const amt = Math.min(Math.round(cap * LATE_CREDIT_PCT), LATE_CREDIT_CAP);
    reasons.push(
      `store credit = ${Math.round(LATE_CREDIT_PCT * 100)}% of Rs ${cap} ` +
        `capped at Rs ${LATE_CREDIT_CAP} = Rs ${amt}`,
    );
    return amt;
  }
  reasons.push(`${remedy} is a goods remedy, no cash amount payable`);
  return 0;
}

/**
 * Clauses whose tags intersect `wanted`. When `require` is given, a clause must
 * carry that tag too.
 */
function matchClauses(
  clauses: { id: string; tags?: string[] }[],
  wanted: Set<string>,
  require?: string,
): string[] {
  const want = new Set([...wanted].map((w) => w.toLowerCase()));
  const req = require?.toLowerCase();
  const out: string[] = [];
  for (const c of clauses) {
    const tags = new Set((c.tags ?? []).map((t) => t.toLowerCase()));
    if (![...want].some((w) => tags.has(w))) continue;
    if (req && !tags.has(req)) continue;
    out.push(c.id);
  }
  return out;
}

export { matchClauses, PRIORITY, REQUIRED_EVIDENCE };
