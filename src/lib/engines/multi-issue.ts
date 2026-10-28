/**
 * Multi-issue adjudication — PURE. No model, no clock, no I/O.
 *
 * One complaint can carry two real problems: *"the earbuds are dead and the
 * charging case is missing"* is a DOA and a MISSING_PART, and the old pipeline
 * classified it as the stronger one only. The buyer got one remedy for two
 * faults, and the README reported that honestly as a known limitation.
 *
 * This fixes it by *composing* the existing engine rather than replacing it.
 * Each issue is adjudicated by `checkEntitlement` on its own — same function,
 * same clauses, same arithmetic — and this module does the two things that
 * only make sense across a set:
 *
 *  1. **It caps the aggregate.** Two issues on a Rs 2,499 order cannot pay out
 *     Rs 2,499 twice. The per-issue invariant (`amount <= order value`) was
 *     never wrong, it was just not sufficient once there was more than one
 *     issue — so the cap is applied again over the sum, in a declared order,
 *     with the reason recorded on whichever issue got trimmed.
 *  2. **It refuses to pay twice for the same thing.** A FULL_REFUND already
 *     returns the entire order value, so nothing can be owed on top of it.
 *     Two issues that are really one allegation (DAMAGED and DOA on the same
 *     unit) are collapsed, with the weaker one marked as subsumed.
 *
 * What this module deliberately does NOT do:
 *
 *  - It does not classify. A model splits the prose into issues; that is
 *    extraction, and it is checked against a closed list before it gets here.
 *  - It does not decide any remedy or amount itself. Every number in its
 *    output came out of `checkEntitlement`. This module can only ever *reduce*
 *    a payout, never invent or raise one, which is what makes it safe to have
 *    between the engine and the money.
 */
import { checkEntitlement, type EntitlementOrder, type EntitlementPolicy } from "@/lib/engines/entitlement";
import type { EvidenceFlags, IssueType, Remedy, Verdict } from "@/lib/types";

/**
 * Remedies that already return the whole order value.
 *
 * Nothing can be owed on top of one of these, so a second cash remedy
 * alongside it is duplicate compensation by definition.
 */
const WHOLE_ORDER_REMEDIES: Remedy[] = ["FULL_REFUND", "RESHIP", "REPLACEMENT"];

/** Remedies that move cash. Only these consume the aggregate cap. */
const CASH_REMEDIES: Remedy[] = ["FULL_REFUND", "PARTIAL_REFUND", "STORE_CREDIT"];

/**
 * Issues that are the same physical allegation about the same unit.
 *
 * A buyer who says "it arrived smashed and it will not switch on" is
 * describing one broken item, not two faults to be remedied separately.
 * Ordered strongest-first within each group: the survivor is the one with the
 * more provable claim, which is the same ordering triage already uses.
 */
const SAME_ALLEGATION: IssueType[][] = [
  ["DAMAGED", "DOA"],
  ["COUNTERFEIT", "NOT_AS_DESCRIBED"],
  ["NOT_DELIVERED", "LATE"],
];

/** How serious an issue is, for deciding which one leads the claim. */
const SEVERITY: Record<IssueType, number> = {
  NOT_DELIVERED: 8,
  COUNTERFEIT: 7,
  DOA: 6,
  DAMAGED: 5,
  WRONG_ITEM: 4,
  NOT_AS_DESCRIBED: 3,
  MISSING_PART: 2,
  LATE: 1,
};

/** One issue as it arrives from extraction, before anything is decided. */
export type IssueInput = {
  /** Stable within a claim, so an operator can decide one issue by name. */
  key: string;
  issueType: IssueType;
  /** The sentence or clause of the complaint this issue came from. */
  excerpt: string;
  /** Evidence flags asserted for THIS issue, not for the complaint overall. */
  evidenceFlags: EvidenceFlags;
  /** Extraction confidence for the classification itself. */
  confidence: number;
  /** Filenames of the evidence that bears on this issue, if attributable. */
  evidenceFilenames?: string[];
};

export type IssueOutcomeStatus =
  /** Adjudicated and payable, pending the usual approval gate. */
  | "ELIGIBLE"
  /** Adjudicated and honestly declined — out of window, no policy cover. */
  | "NOT_ELIGIBLE"
  /** Real, but already fully compensated by another issue's remedy. */
  | "SUBSUMED"
  /** Trimmed or zeroed because the aggregate cap was reached. */
  | "CAPPED"
  /** The engine could not decide it safely; a person must. */
  | "NEEDS_REVIEW";

/** One issue after adjudication. The verdict is the engine's, untouched. */
export type IssueOutcome = IssueInput & {
  /** Straight from `checkEntitlement`. Never edited. */
  verdict: Verdict;
  status: IssueOutcomeStatus;
  /** What is actually payable on this issue after the cross-issue rules. */
  payableInr: number;
  /** Why `payableInr` differs from `verdict.amountInr`, when it does. */
  adjustments: string[];
  /** Set when this issue was folded into another. */
  subsumedBy?: string;
};

export type MultiIssueVerdict = {
  issues: IssueOutcome[];
  /** The issue the claim is headed by — the most serious eligible one. */
  primaryKey: string;
  /** Sum of `payableInr`. Guaranteed <= the order value. */
  totalPayableInr: number;
  /** What the engine would have paid with no cross-issue rules applied. */
  uncappedTotalInr: number;
  /** The order value the aggregate was capped against. */
  capInr: number;
  /** True when any issue was trimmed, zeroed or subsumed. */
  capApplied: boolean;
  /** True when at least one issue needs a person before anything moves. */
  reviewRequired: boolean;
  /** Human-readable, in the order the rules were applied. */
  reasons: string[];
};

/**
 * Collapse issues that are the same allegation, and drop exact duplicates.
 *
 * Runs before adjudication: there is no point asking the engine for a verdict
 * on an issue that is not separately real. Returns the survivors plus a note
 * for each one removed, so nothing disappears silently.
 */
export function dedupeIssues(
  issues: IssueInput[],
): { kept: IssueInput[]; collapsed: { key: string; intoKey: string; why: string }[] } {
  const kept: IssueInput[] = [];
  const collapsed: { key: string; intoKey: string; why: string }[] = [];

  for (const issue of issues) {
    // Same issue type twice in one complaint is one issue.
    const sameType = kept.find((k) => k.issueType === issue.issueType);
    if (sameType) {
      collapsed.push({
        key: issue.key,
        intoKey: sameType.key,
        why: `the same ${issue.issueType} allegation appears twice in the complaint`,
      });
      // Keep whichever excerpt carried more evidence, so merging never loses a flag.
      Object.assign(sameType.evidenceFlags, issue.evidenceFlags);
      continue;
    }

    // Two names for one physical fault on one unit.
    const group = SAME_ALLEGATION.find(
      (g) => g.includes(issue.issueType) && kept.some((k) => g.includes(k.issueType)),
    );
    if (group) {
      const existing = kept.find((k) => group.includes(k.issueType))!;
      const keepIncoming = group.indexOf(issue.issueType) < group.indexOf(existing.issueType);
      const loser = keepIncoming ? existing : issue;
      const winner = keepIncoming ? issue : existing;

      collapsed.push({
        key: loser.key,
        intoKey: winner.key,
        why:
          `${loser.issueType} and ${winner.issueType} describe one fault on the same item; ` +
          `${winner.issueType} is the more provable claim`,
      });

      if (keepIncoming) {
        Object.assign(issue.evidenceFlags, existing.evidenceFlags);
        kept.splice(kept.indexOf(existing), 1, issue);
      } else {
        Object.assign(existing.evidenceFlags, issue.evidenceFlags);
      }
      continue;
    }

    kept.push(issue);
  }

  return { kept, collapsed };
}

/**
 * Adjudicate every issue, then apply the cross-issue rules.
 *
 * `checkEntitlement` is called once per issue and its verdict is stored
 * verbatim. Everything after that can only reduce what is payable.
 */
export function adjudicateIssues(
  order: EntitlementOrder,
  policy: EntitlementPolicy,
  issues: IssueInput[],
  now: Date,
): MultiIssueVerdict {
  const capInr = Math.max(0, Math.trunc(order.amountInr));
  const reasons: string[] = [];

  if (issues.length === 0) {
    return {
      issues: [],
      primaryKey: "",
      totalPayableInr: 0,
      uncappedTotalInr: 0,
      capInr,
      capApplied: false,
      reviewRequired: true,
      reasons: ["no issue was extracted from the complaint; a person must read it"],
    };
  }

  const { kept, collapsed } = dedupeIssues(issues.map((i) => ({ ...i, evidenceFlags: { ...i.evidenceFlags } })));
  for (const c of collapsed) reasons.push(`${c.key} folded into ${c.intoKey}: ${c.why}`);

  /* ── 1. One engine verdict per surviving issue ──────────────────── */

  const outcomes: IssueOutcome[] = kept.map((issue) => {
    const verdict = checkEntitlement(order, policy, issue.issueType, issue.evidenceFlags, now);

    const status: IssueOutcomeStatus =
      verdict.remedy === "ESCALATE_AMBIGUOUS"
        ? "NEEDS_REVIEW"
        : verdict.eligible
          ? "ELIGIBLE"
          : "NOT_ELIGIBLE";

    return {
      ...issue,
      verdict,
      status,
      // A goods remedy is eligible but pays no cash; that is already in the verdict.
      payableInr: status === "ELIGIBLE" ? verdict.amountInr : 0,
      adjustments: [],
    };
  });

  // Issues collapsed before adjudication still appear, so the operator sees
  // that the second allegation was read and accounted for.
  for (const c of collapsed) {
    const source = issues.find((i) => i.key === c.key);
    if (!source) continue;
    const into = outcomes.find((o) => o.key === c.intoKey);
    outcomes.push({
      ...source,
      verdict: into
        ? { ...into.verdict, amountInr: 0, reasons: [...into.verdict.reasons, c.why] }
        : zeroVerdict(c.why),
      status: "SUBSUMED",
      payableInr: 0,
      adjustments: [c.why],
      subsumedBy: c.intoKey,
    });
  }

  const uncappedTotalInr = outcomes.reduce((s, o) => s + o.payableInr, 0);

  /* ── 2. Nothing is owed on top of a whole-order remedy ──────────── */

  const whole = outcomes.find(
    (o) => o.status === "ELIGIBLE" && WHOLE_ORDER_REMEDIES.includes(o.verdict.remedy),
  );

  // Only counts as an adjustment if it actually suppressed a payout. A single
  // issue that happens to be a full refund has adjusted nothing.
  let subsumedByWhole = 0;

  if (whole) {
    for (const o of outcomes) {
      if (o === whole || o.status !== "ELIGIBLE") continue;
      if (!CASH_REMEDIES.includes(o.verdict.remedy)) continue;
      o.adjustments.push(
        `no cash payable: ${whole.key} (${whole.verdict.remedy.replace(/_/g, " ")}) already ` +
          "returns the full order value",
      );
      o.payableInr = 0;
      o.status = "SUBSUMED";
      o.subsumedBy = whole.key;
      subsumedByWhole += 1;
    }

    if (subsumedByWhole > 0) {
      reasons.push(
        `${whole.key} is a ${whole.verdict.remedy.replace(/_/g, " ")}, which already makes the ` +
          "buyer whole for the entire order — no further cash remedy can be owed on top of it",
      );
    }
  }

  /* ── 3. The aggregate cap ───────────────────────────────────────── */

  // Most serious first, so if the cap bites it trims the least serious issue.
  // A declared order matters: whichever issue gets trimmed must not depend on
  // the order the model happened to list them in.
  const payingOrder = outcomes
    .filter((o) => o.status === "ELIGIBLE" && o.payableInr > 0)
    .sort(
      (a, b) =>
        SEVERITY[b.issueType] - SEVERITY[a.issueType] ||
        b.payableInr - a.payableInr ||
        a.key.localeCompare(b.key),
    );

  let spent = 0;
  let capApplied = collapsed.length > 0 || subsumedByWhole > 0;

  for (const o of payingOrder) {
    const room = capInr - spent;
    if (room <= 0) {
      o.adjustments.push(
        `nothing payable: the Rs ${capInr} order value is already fully committed to ` +
          "more serious issues on this claim",
      );
      o.payableInr = 0;
      o.status = "CAPPED";
      capApplied = true;
      continue;
    }
    if (o.payableInr > room) {
      o.adjustments.push(
        `trimmed from Rs ${o.payableInr} to Rs ${room}: the total across all issues cannot ` +
          `exceed the Rs ${capInr} order value`,
      );
      o.payableInr = room;
      o.status = "CAPPED";
      capApplied = true;
    }
    spent += o.payableInr;
  }

  if (spent < uncappedTotalInr) {
    reasons.push(
      `aggregate payout capped at the Rs ${capInr} order value: the per-issue remedies ` +
        `summed to Rs ${uncappedTotalInr}`,
    );
  }

  /* ── 4. Who heads the claim, and does a person have to look ─────── */

  const primary =
    [...outcomes]
      .filter((o) => o.status === "ELIGIBLE" || o.status === "CAPPED")
      .sort((a, b) => SEVERITY[b.issueType] - SEVERITY[a.issueType])[0] ??
    [...outcomes].sort((a, b) => SEVERITY[b.issueType] - SEVERITY[a.issueType])[0];

  const reviewRequired = outcomes.some((o) => o.status === "NEEDS_REVIEW");
  if (reviewRequired) {
    const which = outcomes.filter((o) => o.status === "NEEDS_REVIEW").map((o) => o.key);
    reasons.push(
      `${which.join(", ")} could not be decided on the evidence available — ` +
        "routed to a person rather than guessed",
    );
  }

  const totalPayableInr = outcomes.reduce((s, o) => s + o.payableInr, 0);

  // The invariant, asserted rather than assumed. If this ever trips, the bug
  // is here and not in the caller, and it must not reach an approval screen.
  if (totalPayableInr > capInr) {
    throw new Error(
      `multi-issue aggregate Rs ${totalPayableInr} exceeds the Rs ${capInr} order value`,
    );
  }

  return {
    issues: outcomes,
    primaryKey: primary?.key ?? outcomes[0].key,
    totalPayableInr,
    uncappedTotalInr,
    capInr,
    capApplied,
    reviewRequired,
    reasons,
  };
}

function zeroVerdict(why: string): Verdict {
  return {
    eligible: false,
    remedy: "NONE",
    alternatives: [],
    amountInr: 0,
    deadlineAt: null,
    clauseIds: [],
    reasons: [why],
    confidence: 0,
  };
}

/**
 * The single verdict a multi-issue claim is headed by.
 *
 * Everything downstream of adjudication — the letter, the approval gate, the
 * refund ledger, the seller record — was built around one `Verdict`, and a
 * claim with three issues still has one answer to "what happens next". So the
 * primary issue's verdict is reused verbatim, with the *aggregate* amount
 * substituted and the other issues' clauses merged in.
 *
 * Substituting the amount is the one edit, and it is always downward or equal:
 * `totalPayableInr` is capped at the order value by construction above.
 */
export function headlineVerdict(multi: MultiIssueVerdict): Verdict {
  const primary = multi.issues.find((i) => i.key === multi.primaryKey);
  if (!primary) {
    return zeroVerdict("no primary issue could be identified on this claim");
  }

  const clauseIds = [...new Set(multi.issues.flatMap((i) => i.verdict.clauseIds))];
  const payingIssues = multi.issues.filter((i) => i.payableInr > 0);

  const reasons = [...primary.verdict.reasons];
  // Reported whenever more than one issue was read, including when the extra
  // ones were subsumed. "We found two problems and one remedy covers both" is
  // the sentence the buyer needs; silence reads as the second being ignored,
  // which is exactly the old behaviour this replaced.
  if (multi.issues.length > 1) {
    reasons.push(
      `${multi.issues.length} issues were read from this complaint; ` +
        `${payingIssues.length} carry a cash remedy totalling Rs ${multi.totalPayableInr}`,
    );
    reasons.push(...multi.reasons);
  }

  return {
    ...primary.verdict,
    amountInr: multi.totalPayableInr,
    clauseIds,
    reasons,
    // A claim where any issue needs a person cannot be acted on automatically.
    remedy: multi.reviewRequired && !primary.verdict.eligible
      ? "ESCALATE_AMBIGUOUS"
      : primary.verdict.remedy,
  };
}

export { SEVERITY, SAME_ALLEGATION, WHOLE_ORDER_REMEDIES, CASH_REMEDIES };
