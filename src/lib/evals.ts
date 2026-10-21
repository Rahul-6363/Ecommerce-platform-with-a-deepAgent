/**
 * The eval suite, ported from Rakshak.
 *
 * Each scenario asserts one claim about the system that a reviewer could
 * otherwise only take on trust. They run against the real pipeline — the same
 * engines, registry and gate the storefront uses — so a pass here means the
 * behaviour actually holds, not that a mock agreed with itself.
 *
 * Two things worth noting about the design:
 *
 *  - A scenario can be marked `knownLimitation`. It is reported separately as
 *    KNOWN LIMIT rather than counted as a pass or hidden as a failure. A suite
 *    that reports 100% by omitting the hard case is not telling you anything.
 *  - The expectations are about *outcomes a person cares about* — the remedy,
 *    the amount, whether it stopped for a human — not internal shapes.
 */

export type Expect = {
  issueType?: string;
  remedy?: string;
  eligible?: boolean;
  amountInr?: number;
  maxAmountInr?: number;
  state?: string;
  clauseMatched?: boolean;
  deadlineDays?: number;
  /** Risk scenarios. */
  band?: "LOW" | "MEDIUM" | "HIGH";
  interventionAction?: string | null;
  /** Chaos scenarios. */
  toolFailed?: boolean;
  replanned?: boolean;
  /** Autonomy scenarios. */
  wokeUp?: boolean;
  escalatedToTier?: number;
  humanPresent?: boolean;
  /** Authenticity scenarios. */
  authenticityVerdict?: string;
  reviewRequired?: boolean;
  /** Known-limitation scenarios. */
  issuesDetected?: number;
};

export type Scenario = {
  id: number;
  name: string;
  kind: "case" | "risk" | "autonomy" | "chaos" | "authenticity";
  /** Which seeded order to run against. */
  orderNo?: string;
  buyerEmail?: string;
  complaint?: string;
  lang?: string;
  /** Attach a synthetic photograph so the evidence path is exercised. */
  withPhoto?: boolean;
  /** Push the simulated clock forward before asserting. */
  advanceHours?: number;
  /** Make a named tool fail, to force a replan. */
  breakTool?: string;
  knownLimitation?: string;
  expect: Expect;
};

export const SCENARIOS: Scenario[] = [
  /* ── Entitlement: the remedy ladder ─────────────────────────────── */
  {
    id: 1,
    name: "Dead on arrival, inside the window, replacement stock available",
    kind: "case",
    orderNo: "ORD-DEMO002",
    buyerEmail: "arjun@example.in",
    complaint: "The earbuds arrived completely dead, they will not power on at all.",
    withPhoto: true,
    expect: {
      issueType: "DOA", remedy: "REPLACEMENT", eligible: true,
      clauseMatched: true, amountInr: 0, state: "AWAITING_APPROVAL",
    },
  },
  {
    id: 2,
    name: "Damaged in transit with a photograph",
    kind: "case",
    orderNo: "ORD-DEMO002",
    buyerEmail: "arjun@example.in",
    complaint: "The case arrived cracked right across the lid, damaged in transit.",
    withPhoto: true,
    expect: { issueType: "DAMAGED", eligible: true, clauseMatched: true },
  },
  {
    id: 3,
    name: "Non-delivery on an overdue COD parcel, buyer prefers speed",
    kind: "case",
    orderNo: "ORD-DEMO001",
    buyerEmail: "lakshmi@example.in",
    complaint: "ಶೂ ಇನ್ನೂ ಬಂದಿಲ್ಲ, ಸಿಕ್ಕಿಲ್ಲ",
    expect: {
      issueType: "NOT_DELIVERED",
      // Her profile prefers speed, so the goods remedy must win over cash.
      remedy: "RESHIP", eligible: true, amountInr: 0, clauseMatched: true,
    },
  },
  {
    id: 4,
    name: "Missing accessory from the box",
    kind: "case",
    orderNo: "ORD-DEMO003",
    buyerEmail: "murugan@example.in",
    complaint: "The gasket and the safety valve were missing from the cooker box.",
    expect: { issueType: "MISSING_PART", clauseMatched: true },
  },
  {
    id: 5,
    name: "Delivered late on a policy with no late compensation: an honest no",
    kind: "case",
    orderNo: "ORD-DEMO006",
    buyerEmail: "arjun@example.in",
    complaint: "The bottles were delivered four days after the promised date.",
    expect: {
      // The kitchen policy sets lateCompensation false and carries no LATE
      // clause, so there is genuinely nothing to pay. The engine must say so
      // rather than reaching for the nearest remedy it can find.
      issueType: "LATE", eligible: false, amountInr: 0,
    },
  },
  {
    id: 17,
    name: "Delivered late on a policy that does pay, credit capped at Rs 200",
    kind: "case",
    orderNo: "ORD-DEMO007",
    buyerEmail: "priya@example.in",
    complaint: "The TV was delivered five days after the promised date.",
    expect: {
      issueType: "LATE", remedy: "STORE_CREDIT", eligible: true,
      // 5% of a 21999 order is 1100, so the Rs 200 cap must bind.
      amountInr: 200, clauseMatched: true,
    },
  },

  /* ── Honest refusals ─────────────────────────────────────────────── */
  {
    id: 6,
    name: "Claim raised 35 days after delivery against a 10-day window",
    kind: "case",
    orderNo: "ORD-DEMO005",
    buyerEmail: "priya@example.in",
    complaint: "The bedsheet is torn along the seam.",
    withPhoto: true,
    expect: { eligible: false, remedy: "NONE", amountInr: 0 },
  },
  {
    id: 7,
    name: "Courier recorded DELIVERED, buyer says it never came",
    kind: "case",
    orderNo: "ORD-DEMO004",
    buyerEmail: "priya@example.in",
    complaint: "मेरा सामान अभी तक नहीं मिला, कभी नहीं आया",
    expect: {
      // Both parties may be honest. The system must not pick a side.
      state: "HUMAN_HANDOFF",
    },
  },

  /* ── Language coverage ───────────────────────────────────────────── */
  {
    id: 8,
    name: "Complaint in Tamil, native script",
    kind: "case",
    orderNo: "ORD-DEMO003",
    buyerEmail: "murugan@example.in",
    complaint: "குக்கர் உடைந்த நிலையில் வந்தது",
    withPhoto: true,
    expect: { issueType: "DAMAGED", clauseMatched: true },
  },
  {
    id: 9,
    name: "Complaint in transliterated Hinglish",
    kind: "case",
    orderNo: "ORD-DEMO002",
    buyerEmail: "arjun@example.in",
    complaint: "Earbuds band hai, kaam nahi kar raha. Photo bhej diya hai.",
    withPhoto: true,
    expect: { issueType: "DOA", eligible: true },
  },

  /* ── Authenticity: the fraud question ────────────────────────────── */
  {
    id: 10,
    name: "Repeat claimant with two rejected claims and no photograph",
    kind: "authenticity",
    orderNo: "ORD-DEMO003",
    buyerEmail: "murugan@example.in",
    complaint: "The cooker is completely broken and cracked all over.",
    withPhoto: false,
    expect: {
      // Suspicion must rise, and it must ask a person — never auto-reject.
      reviewRequired: true,
    },
  },
  {
    id: 11,
    name: "First-time claimant with a corroborated photograph",
    kind: "authenticity",
    orderNo: "ORD-DEMO002",
    buyerEmail: "arjun@example.in",
    complaint: "The right earbud is dead and the case is cracked.",
    withPhoto: true,
    expect: { eligible: true },
  },

  /* ── Prevention: the risk engine ─────────────────────────────────── */
  {
    id: 12,
    name: "COD to a tier-3 pincode with no landmark and a prior return",
    kind: "risk",
    orderNo: "ORD-DEMO001",
    expect: { band: "HIGH", interventionAction: "ask_buyer" },
  },
  {
    id: 13,
    name: "Prepaid metro parcel with a complete address",
    kind: "risk",
    orderNo: "ORD-DEMO002",
    expect: {
      band: "LOW",
      // Declining to act is the behaviour under test.
      interventionAction: null,
    },
  },

  /* ── Adaptation: a tool dies mid-plan ────────────────────────────── */
  {
    id: 14,
    name: "Chaos: a required tool fails, the plan rewrites around it",
    kind: "chaos",
    orderNo: "ORD-DEMO002",
    buyerEmail: "arjun@example.in",
    complaint: "The earbuds are dead on arrival, they will not switch on.",
    withPhoto: true,
    // get_policy, not get_tracking. The plan validator rejects any plan that
    // reaches a remedy without get_policy, so this tool is guaranteed to be in
    // the plan — whereas a planner free to skip tracking makes the injected
    // failure untestable, which is how this scenario silently stopped proving
    // anything once a real model started writing the plans.
    breakTool: "get_policy",
    expect: { toolFailed: true, replanned: true },
  },

  /* ── Autonomy: the deadline lapses with nobody watching ──────────── */
  {
    id: 15,
    name: "Approved remedy breaches its SLA, the tracker escalates alone",
    kind: "autonomy",
    orderNo: "ORD-DEMO002",
    buyerEmail: "arjun@example.in",
    complaint: "The earbuds arrived dead, they will not power on.",
    withPhoto: true,
    advanceHours: 24 * 8,
    expect: { wokeUp: true, escalatedToTier: 1, humanPresent: false },
  },

  /* ── A limitation we report rather than hide ─────────────────────── */
  {
    id: 16,
    name: "KNOWN LIMIT: two distinct issues in one complaint",
    kind: "case",
    orderNo: "ORD-DEMO002",
    buyerEmail: "arjun@example.in",
    complaint: "The earbuds are dead and the charging case is also missing from the box.",
    knownLimitation:
      "Triage returns a single issueType. A complaint carrying two distinct issues " +
      "is classified as the stronger one only, so the missing accessory is not " +
      "separately remedied. The secondary issue is recorded, but the remedy covers " +
      "one of them. Fixing this properly needs multi-issue case splitting, which " +
      "would change the claim model, so it is reported rather than papered over.",
    expect: { issuesDetected: 2 },
  },
];

export type ScenarioResult = {
  id: number;
  name: string;
  kind: Scenario["kind"];
  status: "PASS" | "FAIL" | "KNOWN LIMIT" | "ERROR";
  checks: { label: string; ok: boolean; detail: string }[];
  /** What the run actually produced, for the report. */
  observed: Record<string, unknown>;
  error?: string;
  knownLimitation?: string;
  ms: number;
};

export type EvalReport = {
  ran: number;
  passed: number;
  failed: number;
  knownLimits: number;
  errors: number;
  results: ScenarioResult[];
  /** True when no model key was present, so this exercised the fallback path. */
  degraded: boolean;
  startedAt: string;
  ms: number;
};
