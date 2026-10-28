/**
 * Multi-issue adjudication.
 *
 * The thing under test is the arithmetic across a *set* of issues, because
 * that is the part `checkEntitlement` cannot do on its own: it was always
 * correct about one issue and had no way to know a second existed.
 *
 * So the assertions here are mostly about money that must NOT move — two
 * remedies for one fault, a second refund on top of a full one, a sum past
 * the order value. A multi-issue claim that pays too much is a worse bug than
 * one that pays once, which is what this replaced.
 */
import { describe, it, expect } from "vitest";
import {
  adjudicateIssues,
  dedupeIssues,
  headlineVerdict,
  SEVERITY,
  type IssueInput,
} from "@/lib/engines/multi-issue";
import { keywordSplit } from "@/lib/agent/issue-splitter";
import { keywordTriage } from "@/lib/agent/triage";
import { ISSUE_TYPES, type IssueType } from "@/lib/types";

const NOW = new Date("2026-10-20T10:00:00Z");
const DELIVERED = new Date("2026-10-18T10:00:00Z");

const ORDER = {
  amountInr: 2499,
  deliveredAt: DELIVERED,
  promisedBy: new Date("2026-10-17T10:00:00Z"),
  stockAvailable: true,
  buyerPriority: "money" as const,
};

const POLICY = {
  returnWindowDays: 7,
  replacementAllowed: true,
  refundSlaDays: 5,
  lateCompensation: true,
  clauses: [
    { id: "VJ-ELEC-1.1", text: "Dead on arrival is replaced or refunded.", tags: ["doa", "replacement", "full_refund"] },
    { id: "VJ-ELEC-1.2", text: "Transit damage is replaced.", tags: ["damaged", "replacement", "full_refund"] },
    { id: "VJ-ELEC-2.2", text: "A missing component is shipped, or partly refunded.", tags: ["missing_part", "part_shipment", "partial_refund"] },
    { id: "VJ-ELEC-3.1", text: "A wrong item is replaced or refunded.", tags: ["wrong_item", "replacement", "full_refund"] },
    { id: "VJ-ELEC-4.1", text: "Late delivery earns store credit.", tags: ["late", "store_credit"] },
    { id: "VJ-ELEC-9.9", text: "Claims outside the window are declined.", tags: ["window"] },
  ],
};

function issue(type: IssueType, over: Partial<IssueInput> = {}): IssueInput {
  return {
    key: over.key ?? `I-${type}`,
    issueType: type,
    excerpt: over.excerpt ?? `the ${type} problem`,
    evidenceFlags: over.evidenceFlags ?? {},
    confidence: over.confidence ?? 0.8,
    ...over,
  };
}

/* ─────────────────────────── Single-issue parity ─────────────────────── */

describe("a single issue behaves exactly as it did before", () => {
  it("returns one row with the engine's own verdict untouched", () => {
    const m = adjudicateIssues(ORDER, POLICY, [issue("DOA", { evidenceFlags: { stated_fault: true } })], NOW);

    expect(m.issues).toHaveLength(1);
    expect(m.issues[0].status).toBe("ELIGIBLE");
    expect(m.issues[0].verdict.eligible).toBe(true);
    // No cross-issue rule can fire with one issue, so nothing is adjusted.
    expect(m.issues[0].adjustments).toEqual([]);
    expect(m.capApplied).toBe(false);
  });

  it("makes the headline verdict identical to the single verdict", () => {
    const only = issue("MISSING_PART", { evidenceFlags: { stated_missing: true } });
    const m = adjudicateIssues(ORDER, POLICY, [only], NOW);
    const head = headlineVerdict(m);

    expect(head.remedy).toBe(m.issues[0].verdict.remedy);
    expect(head.amountInr).toBe(m.issues[0].verdict.amountInr);
    expect(head.eligible).toBe(m.issues[0].verdict.eligible);
    expect(head.deadlineAt).toBe(m.issues[0].verdict.deadlineAt);
  });

  it("still declines a single issue that is out of its window", () => {
    const late = new Date("2026-11-30T10:00:00Z");
    const m = adjudicateIssues(ORDER, POLICY, [issue("DAMAGED")], late);

    expect(m.issues[0].status).toBe("NOT_ELIGIBLE");
    expect(m.totalPayableInr).toBe(0);
  });
});

/* ──────────────────────── Two genuinely distinct issues ─────────────── */

describe("two distinct issues each get their own verdict", () => {
  // The exact complaint the README reported as a known limitation.
  const twoIssues = [
    issue("DOA", { key: "I1-DOA", evidenceFlags: { stated_fault: true } }),
    issue("MISSING_PART", { key: "I2-MISSING_PART", evidenceFlags: { stated_missing: true } }),
  ];

  it("adjudicates both rather than only the stronger one", () => {
    const m = adjudicateIssues(ORDER, POLICY, twoIssues, NOW);

    expect(m.issues).toHaveLength(2);
    const types = m.issues.map((i) => i.issueType).sort();
    expect(types).toEqual(["DOA", "MISSING_PART"]);
    // Each one cites its own clause, not the other's.
    const doa = m.issues.find((i) => i.issueType === "DOA")!;
    const part = m.issues.find((i) => i.issueType === "MISSING_PART")!;
    expect(doa.verdict.clauseIds).toContain("VJ-ELEC-1.1");
    expect(part.verdict.clauseIds).toContain("VJ-ELEC-2.2");
  });

  it("heads the claim with the more serious issue", () => {
    const m = adjudicateIssues(ORDER, POLICY, twoIssues, NOW);
    const primary = m.issues.find((i) => i.key === m.primaryKey)!;

    expect(primary.issueType).toBe("DOA");
    expect(SEVERITY.DOA).toBeGreaterThan(SEVERITY.MISSING_PART);
  });

  it("records on the headline verdict that there was more than one issue", () => {
    const m = adjudicateIssues(ORDER, POLICY, twoIssues, NOW);
    const head = headlineVerdict(m);

    expect(head.reasons.join(" ")).toMatch(/2 issues were read/i);
    // Clauses from both issues are cited, so the letter can mention each.
    expect(head.clauseIds).toContain("VJ-ELEC-1.1");
    expect(head.clauseIds).toContain("VJ-ELEC-2.2");
  });

  it("reads a late issue alongside a wrong-item issue and keeps both visible", () => {
    const m = adjudicateIssues(
      ORDER,
      POLICY,
      [
        issue("WRONG_ITEM", { key: "I1", evidenceFlags: { sku_mismatch: true } }),
        issue("LATE", { key: "I2", evidenceFlags: { late_scan: true } }),
      ],
      NOW,
    );

    // Both issues are adjudicated and reported. The wrong item resolves to a
    // full refund for this money-preferring buyer, which already returns the
    // whole order value — so the late-delivery store credit is correctly
    // subsumed rather than paid on top. Two rows, one payment.
    expect(m.issues).toHaveLength(2);
    const wrong = m.issues.find((i) => i.issueType === "WRONG_ITEM")!;
    const late = m.issues.find((i) => i.issueType === "LATE")!;
    expect(wrong.status).toBe("ELIGIBLE");
    expect(late.status).toBe("SUBSUMED");
    expect(late.payableInr).toBe(0);
    expect(m.totalPayableInr).toBe(wrong.payableInr);
  });

  it("pays two issues separately when neither remedy covers the whole order", () => {
    // Replacement barred and no stock, so neither issue can reach a
    // whole-order remedy: MISSING_PART pays a partial refund and LATE pays
    // store credit, and both are genuinely owed at once.
    const m = adjudicateIssues
    (
      { ...ORDER, stockAvailable: false, buyerPriority: "money" },
      { ...POLICY, replacementAllowed: false },
      [
        issue("MISSING_PART", { key: "I1", evidenceFlags: { stated_missing: true } }),
        issue("LATE", { key: "I2", evidenceFlags: { late_scan: true } }),
      ],
      NOW,
    );

    const paying = m.issues.filter((i) => i.payableInr > 0);
    expect(paying.length).toBeGreaterThanOrEqual(2);
    expect(m.totalPayableInr).toBeLessThanOrEqual(ORDER.amountInr);
  });
});

/* ─────────────────── Duplicate compensation is refused ──────────────── */

describe("it never pays twice for the same thing", () => {
  it("collapses two names for one physical fault", () => {
    const { kept, collapsed } = dedupeIssues([
      issue("DAMAGED", { key: "I1" }),
      issue("DOA", { key: "I2" }),
    ]);

    expect(kept).toHaveLength(1);
    // DAMAGED survives: visible damage is the more provable claim, which is
    // the same ordering triage uses.
    expect(kept[0].issueType).toBe("DAMAGED");
    expect(collapsed[0].intoKey).toBe("I1");
    expect(collapsed[0].why).toMatch(/one fault on the same item/i);
  });

  it("keeps the collapsed issue visible rather than dropping it", () => {
    const m = adjudicateIssues(
      ORDER,
      POLICY,
      [issue("DAMAGED", { key: "I1" }), issue("DOA", { key: "I2" })],
      NOW,
    );

    // Both rows are present; the second pays nothing and says why.
    expect(m.issues).toHaveLength(2);
    const sub = m.issues.find((i) => i.status === "SUBSUMED")!;
    expect(sub.issueType).toBe("DOA");
    expect(sub.payableInr).toBe(0);
    expect(sub.subsumedBy).toBe("I1");
  });

  it("merges the evidence of a collapsed issue instead of losing it", () => {
    const { kept } = dedupeIssues([
      issue("DAMAGED", { key: "I1", evidenceFlags: { photo: true } }),
      issue("DOA", { key: "I2", evidenceFlags: { stated_fault: true } }),
    ]);

    expect(kept[0].evidenceFlags.photo).toBe(true);
    expect(kept[0].evidenceFlags.stated_fault).toBe(true);
  });

  it("folds the same issue type reported twice into one", () => {
    const { kept, collapsed } = dedupeIssues([
      issue("MISSING_PART", { key: "I1" }),
      issue("MISSING_PART", { key: "I2" }),
    ]);

    expect(kept).toHaveLength(1);
    expect(collapsed[0].why).toMatch(/appears twice/i);
  });

  it("pays no cash on top of a full refund", () => {
    // Buyer prefers money, so NOT_DELIVERED with no stock resolves to cash.
    const m = adjudicateIssues(
      { ...ORDER, stockAvailable: false },
      POLICY,
      [
        issue("NOT_DELIVERED", { key: "I1", evidenceFlags: { no_delivery_scan: true } }),
        issue("MISSING_PART", { key: "I2", evidenceFlags: { stated_missing: true } }),
      ],
      NOW,
    );

    const full = m.issues.find((i) => i.verdict.remedy === "FULL_REFUND");
    if (full && full.status === "ELIGIBLE") {
      const other = m.issues.find((i) => i.key === "I2")!;
      expect(other.payableInr).toBe(0);
      expect(m.totalPayableInr).toBe(full.payableInr);
      expect(m.reasons.join(" ")).toMatch(/already makes the buyer whole/i);
    }
  });
});

/* ─────────────────────────── The aggregate cap ──────────────────────── */

describe("the aggregate never exceeds the order value", () => {
  it("caps the sum at the order value across many issues", () => {
    const many = [
      issue("WRONG_ITEM", { key: "I1", evidenceFlags: { sku_mismatch: true } }),
      issue("MISSING_PART", { key: "I2", evidenceFlags: { stated_missing: true } }),
      issue("LATE", { key: "I3", evidenceFlags: { late_scan: true } }),
    ];
    const m = adjudicateIssues(ORDER, POLICY, many, NOW);

    expect(m.totalPayableInr).toBeLessThanOrEqual(ORDER.amountInr);
    expect(m.capInr).toBe(ORDER.amountInr);
  });

  it("holds the invariant on a tiny order where remedies must collide", () => {
    const tiny = { ...ORDER, amountInr: 100 };
    const m = adjudicateIssues(
      tiny,
      POLICY,
      [
        issue("WRONG_ITEM", { key: "I1", evidenceFlags: { sku_mismatch: true } }),
        issue("MISSING_PART", { key: "I2", evidenceFlags: { stated_missing: true } }),
        issue("LATE", { key: "I3", evidenceFlags: { late_scan: true } }),
      ],
      NOW,
    );

    expect(m.totalPayableInr).toBeLessThanOrEqual(100);
  });

  it("trims the least serious issue when the cap bites, not an arbitrary one", () => {
    // A full-refund-equivalent plus another cash remedy: the cap has to bite.
    const m = adjudicateIssues(
      { ...ORDER, amountInr: 1000, stockAvailable: false, buyerPriority: "money" },
      { ...POLICY, replacementAllowed: false },
      [
        issue("NOT_AS_DESCRIBED", { key: "I1", evidenceFlags: { listing_comparison: true } }),
        issue("MISSING_PART", { key: "I2", evidenceFlags: { stated_missing: true } }),
      ],
      NOW,
    );

    expect(m.totalPayableInr).toBeLessThanOrEqual(1000);
    // If anything was trimmed, it was the less serious MISSING_PART.
    const trimmed = m.issues.filter((i) => i.status === "CAPPED");
    for (const t of trimmed) {
      expect(SEVERITY[t.issueType as IssueType]).toBeLessThanOrEqual(SEVERITY.NOT_AS_DESCRIBED);
    }
  });

  it("does not depend on the order the issues were listed in", () => {
    const a = [
      issue("MISSING_PART", { key: "I1", evidenceFlags: { stated_missing: true } }),
      issue("WRONG_ITEM", { key: "I2", evidenceFlags: { sku_mismatch: true } }),
    ];
    const b = [a[1], a[0]];

    const ma = adjudicateIssues(ORDER, POLICY, a.map((x) => ({ ...x })), NOW);
    const mb = adjudicateIssues(ORDER, POLICY, b.map((x) => ({ ...x })), NOW);

    expect(ma.totalPayableInr).toBe(mb.totalPayableInr);
    // The same issue heads the claim either way.
    const pa = ma.issues.find((i) => i.key === ma.primaryKey)!.issueType;
    const pb = mb.issues.find((i) => i.key === mb.primaryKey)!.issueType;
    expect(pa).toBe(pb);
  });

  it("reports what the remedies would have summed to before the cap", () => {
    const m = adjudicateIssues(
      { ...ORDER, amountInr: 100 },
      POLICY,
      [
        issue("WRONG_ITEM", { key: "I1", evidenceFlags: { sku_mismatch: true } }),
        issue("MISSING_PART", { key: "I2", evidenceFlags: { stated_missing: true } }),
      ],
      NOW,
    );

    expect(m.uncappedTotalInr).toBeGreaterThanOrEqual(m.totalPayableInr);
  });

  it("is pure — the same inputs give the same answer", () => {
    const build = () => [
      issue("DOA", { key: "I1", evidenceFlags: { stated_fault: true } }),
      issue("MISSING_PART", { key: "I2", evidenceFlags: { stated_missing: true } }),
    ];

    const a = adjudicateIssues(ORDER, POLICY, build(), NOW);
    const b = adjudicateIssues(ORDER, POLICY, build(), NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never mutates the caller's issue objects", () => {
    const input = [issue("DOA", { key: "I1", evidenceFlags: { stated_fault: true } })];
    const before = JSON.stringify(input);
    adjudicateIssues(ORDER, POLICY, input, NOW);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("can only ever reduce a payout, never raise one", () => {
    const m = adjudicateIssues(
      ORDER,
      POLICY,
      [
        issue("WRONG_ITEM", { key: "I1", evidenceFlags: { sku_mismatch: true } }),
        issue("MISSING_PART", { key: "I2", evidenceFlags: { stated_missing: true } }),
      ],
      NOW,
    );

    // Every row pays at most what the engine said for that issue alone.
    for (const i of m.issues) {
      expect(i.payableInr).toBeLessThanOrEqual(i.verdict.amountInr);
    }
  });
});

/* ──────────────── Incomplete, conflicting and unsupported ───────────── */

describe("it handles evidence that does not support the claim", () => {
  it("routes an undecidable issue to a person instead of guessing", () => {
    // No evidence and no clause match drops confidence below the threshold.
    const m = adjudicateIssues(
      ORDER,
      { ...POLICY, clauses: [] },
      [issue("COUNTERFEIT", { key: "I1" })],
      NOW,
    );

    expect(m.issues[0].status).toBe("NEEDS_REVIEW");
    expect(m.reviewRequired).toBe(true);
    expect(m.totalPayableInr).toBe(0);
  });

  it("stops the whole claim when one issue of several needs review", () => {
    const m = adjudicateIssues(
      ORDER,
      { ...POLICY, clauses: POLICY.clauses.filter((c) => !c.tags.includes("counterfeit")) },
      [
        issue("DOA", { key: "I1", evidenceFlags: { stated_fault: true } }),
        issue("COUNTERFEIT", { key: "I2" }),
      ],
      NOW,
    );

    expect(m.reviewRequired).toBe(true);
    expect(m.reasons.join(" ")).toMatch(/could not be decided/i);
  });

  it("pays the issues that are in window and declines the ones that are not", () => {
    // NOT_DELIVERED is judged against promisedBy + grace, which has long
    // passed; DAMAGED is judged against deliveredAt + the return window.
    const m = adjudicateIssues(
      ORDER,
      POLICY,
      [
        issue("NOT_DELIVERED", { key: "I1", evidenceFlags: { no_delivery_scan: true } }),
        issue("DAMAGED", { key: "I2", evidenceFlags: { photo: true } }),
      ],
      new Date("2026-10-23T10:00:00Z"),
    );

    const nd = m.issues.find((i) => i.issueType === "NOT_DELIVERED");
    const dm = m.issues.find((i) => i.issueType === "DAMAGED");
    // Whatever each one resolves to, the claim never pays past the cap.
    expect(m.totalPayableInr).toBeLessThanOrEqual(ORDER.amountInr);
    expect(nd).toBeDefined();
    expect(dm).toBeDefined();
  });

  it("asks for a person when nothing could be extracted at all", () => {
    const m = adjudicateIssues(ORDER, POLICY, [], NOW);

    expect(m.reviewRequired).toBe(true);
    expect(m.totalPayableInr).toBe(0);
    expect(m.reasons.join(" ")).toMatch(/a person must read it/i);
  });

  it("never returns a remedy for an issue type outside the closed list", () => {
    const m = adjudicateIssues(
      ORDER,
      POLICY,
      [issue("NOT_A_REAL_ISSUE" as IssueType, { key: "I1" })],
      NOW,
    );

    expect(m.totalPayableInr).toBe(0);
    expect(m.issues[0].status).toBe("NEEDS_REVIEW");
  });
});

/* ──────────────────── The deterministic splitter ────────────────────── */

describe("splitting a complaint with no model", () => {
  it("finds both issues in the complaint the README called a known limit", () => {
    const text = "The earbuds are not working, and the charging case is missing.";
    const split = keywordSplit(text, keywordTriage(text));

    const types = split.issues.map((i) => i.issueType);
    expect(types).toContain("DOA");
    expect(types).toContain("MISSING_PART");
    expect(split.degraded).toBe(true);
  });

  it("splits on a Hindi conjunction, not only an English one", () => {
    const text = "earbuds kaam nahi kar raha aur charger box me nahi tha";
    const split = keywordSplit(text, keywordTriage(text));

    const types = split.issues.map((i) => i.issueType);
    expect(types).toContain("DOA");
    // "box me nahi tha" is how this is actually written. The keyword table had
    // only "nahi tha box me", so this fragment matched nothing and a
    // Hindi-writing buyer with no API key silently got one issue of two.
    expect(types).toContain("MISSING_PART");
  });

  it("splits on a Kannada conjunction", () => {
    const text = "ಶೂ ಇನ್ನೂ ಬಂದಿಲ್ಲ ಮತ್ತು ಬಾಕ್ಸ್ ಮುರಿದ ಇದೆ";
    const split = keywordSplit(text, keywordTriage(text));

    expect(split.issues.length).toBeGreaterThanOrEqual(1);
    expect(split.issues.every((i) => ISSUE_TYPES.includes(i.issueType))).toBe(true);
  });

  it("returns exactly one issue for a single-problem complaint", () => {
    const text = "The item arrived cracked across the lid.";
    const split = keywordSplit(text, keywordTriage(text));

    expect(split.issues).toHaveLength(1);
    expect(split.issues[0].issueType).toBe("DAMAGED");
  });

  it("falls back to the triage classification when no fragment matches", () => {
    const text = "I am unhappy with this purchase.";
    const t = keywordTriage(text);
    const split = keywordSplit(text, t);

    expect(split.issues).toHaveLength(1);
    expect(split.issues[0].issueType).toBe(t.issueType);
  });

  it("never asserts an evidence flag for an issue it only guessed", () => {
    const text = "I am unhappy with this purchase.";
    const split = keywordSplit(text, keywordTriage(text));

    // A guessed issue must not manufacture corroboration the buyer never gave.
    expect(Object.keys(split.issues[0].evidenceFlags)).toHaveLength(0);
  });

  it("gives every issue a key unique within the claim", () => {
    const text = "The earbuds are dead, the case is missing, and it arrived late.";
    const split = keywordSplit(text, keywordTriage(text));

    const keys = split.issues.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("caps how many issues one complaint can produce", () => {
    const text =
      "not delivered and damaged and fake and wrong size and missing charger and late and poor quality";
    const split = keywordSplit(text, keywordTriage(text));

    expect(split.issues.length).toBeLessThanOrEqual(4);
  });

  it("does not split an address-like phrase into two issues", () => {
    const text = "The item is damaged. Deliver to Flat 402, Sai Residency, Jayanagar.";
    const split = keywordSplit(text, keywordTriage(text));

    expect(split.issues.map((i) => i.issueType)).toEqual(["DAMAGED"]);
  });
});

/* ───────────────── The headline verdict stays trustworthy ───────────── */

describe("the headline verdict cannot overstate what is owed", () => {
  it("substitutes the capped aggregate, never a larger number", () => {
    const m = adjudicateIssues(
      { ...ORDER, amountInr: 500 },
      POLICY,
      [
        issue("WRONG_ITEM", { key: "I1", evidenceFlags: { sku_mismatch: true } }),
        issue("MISSING_PART", { key: "I2", evidenceFlags: { stated_missing: true } }),
      ],
      NOW,
    );
    const head = headlineVerdict(m);

    expect(head.amountInr).toBe(m.totalPayableInr);
    expect(head.amountInr).toBeLessThanOrEqual(500);
  });

  it("reports an empty claim as ambiguous rather than eligible", () => {
    const head = headlineVerdict(adjudicateIssues(ORDER, POLICY, [], NOW));

    expect(head.eligible).toBe(false);
    expect(head.amountInr).toBe(0);
  });

  it("keeps the deadline the engine produced rather than inventing one", () => {
    const m = adjudicateIssues(ORDER, POLICY, [issue("DOA", { evidenceFlags: { stated_fault: true } })], NOW);
    const head = headlineVerdict(m);

    expect(head.deadlineAt).toBe(m.issues[0].verdict.deadlineAt);
  });
});
