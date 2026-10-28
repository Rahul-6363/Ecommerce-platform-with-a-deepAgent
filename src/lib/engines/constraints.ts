/**
 * Constraint solver — a PURE DETERMINISTIC FUNCTION. No model call inside.
 *
 * Search-then-filter makes the buyer translate a real need into someone
 * else's checkboxes, then scroll two hundred results to see whether it worked.
 * This inverts it: the buyer states hard constraints, and every candidate is
 * either admitted with each constraint shown satisfied, or rejected with the
 * named constraint it failed and the value that failed it.
 *
 * **The rejections are the feature.** No platform tells you why a product was
 * excluded, so you can never trust that the filter did what you asked. A
 * result that says "12 were not kitchen, 4 were over budget, 1 has no
 * induction base, 1 arrives two days late" is a result you can act on without
 * checking it yourself.
 *
 * Division of labour, the same one the rest of this platform uses: a language
 * model turns a sentence into constraints (it is good at that and the output
 * is shown to the buyer for correction), and this function enforces them (it
 * never guesses, and the same inputs always give the same answer).
 */
import {
  deliveryForecast,
  isoDay,
  parseDate,
  trueCost,
  type DeliveryForecast,
  type TrueCost,
} from "@/lib/engines/offers";

/* ────────────────────────── The constraint language ────────────────────────── */

export const CONSTRAINT_KINDS = [
  "category",
  "max_price",
  "min_price",
  "brand",
  "min_rating",
  "in_stock",
  "attribute",
  "arrive_by",
  "payment_mode",
  "max_true_cost",
  "max_seller_defect_rate",
] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export type Constraint =
  | { kind: "category"; value: string }
  | { kind: "max_price"; value: number }
  | { kind: "min_price"; value: number }
  | { kind: "brand"; value: string }
  | { kind: "min_rating"; value: number }
  | { kind: "in_stock"; value: true }
  | { kind: "attribute"; key: string; value: string | number | boolean }
  | { kind: "arrive_by"; value: string }
  | { kind: "payment_mode"; value: "COD" | "PREPAID" }
  | { kind: "max_true_cost"; value: number }
  | { kind: "max_seller_defect_rate"; value: number };

/** What the buyer sees on screen as the constraint they stated. */
export function describeConstraint(c: Constraint): string {
  switch (c.kind) {
    case "category":
      return `category is ${c.value}`;
    case "max_price":
      return `price at or under ₹${c.value.toLocaleString("en-IN")}`;
    case "min_price":
      return `price at or above ₹${c.value.toLocaleString("en-IN")}`;
    case "brand":
      return `brand is ${c.value}`;
    case "min_rating":
      return `rated ${c.value}★ or better`;
    case "in_stock":
      return "in stock now";
    case "attribute":
      return `${humanKey(c.key)} is ${formatValue(c.value)}`;
    case "arrive_by":
      return `arrives by ${isoDay(parseDate(c.value) ?? new Date(c.value))}`;
    case "payment_mode":
      return c.value === "COD" ? "payable cash on delivery" : "prepaid";
    case "max_true_cost":
      return `true cost at or under ₹${c.value.toLocaleString("en-IN")}`;
    case "max_seller_defect_rate":
      return `seller defect rate at or under ${c.value}%`;
  }
}

/* ──────────────────────────── Inputs and outputs ──────────────────────────── */

/** One candidate offer: a product from a specific seller. */
export type Candidate = {
  sku: string;
  title: string;
  brand: string;
  category: string;
  subcategory?: string;
  priceInr: number;
  mrpInr?: number;
  ratingAvg: number;
  ratingCount?: number;
  stock: number;
  codEligible: boolean;
  attributes: Record<string, unknown>;
  imageUrl?: string;
  imageEmoji?: string;
  accentHex?: string;
  /** The seller offering it, with the two fields the economics need. */
  seller: {
    sellerId: string;
    name: string;
    city?: string;
    ratingAvg?: number;
    defectRatePct: number;
    fulfilmentSlaDays: number;
  };
  /** Whether the governing policy allows a replacement at all. */
  refundable?: boolean;
  /**
   * How well this product answers the need the buyer described, from the
   * candidate sweep. Higher is better; 0 means it matched nothing in
   * particular.
   *
   * This exists because ranking purely on cost is wrong the moment the buyer
   * states a need rather than a product. "A gift for my mother who has back
   * pain" put a face oil above the orthopaedic pillow, because the face oil
   * was cheaper - technically the correct answer to a question nobody asked.
   */
  relevance?: number;
};

export type BuyerContext = {
  pinTier: number;
  priorRto?: number;
  paymentMode?: "COD" | "PREPAID";
};

/** A constraint that a candidate satisfied, with the value that satisfied it. */
export type Satisfaction = {
  constraint: string;
  kind: ConstraintKind;
  /** The candidate's actual value, so the buyer can check the claim. */
  evidence: string;
};

/** A constraint a candidate failed. One of these is why it is not on screen. */
export type Rejection = {
  constraint: string;
  kind: ConstraintKind;
  /** What the candidate had instead. */
  actual: string;
};

export type SolvedOffer = {
  candidate: Candidate;
  satisfied: Satisfaction[];
  cost: TrueCost;
  forecast: DeliveryForecast;
  /** Rank position after sorting. 1 is the recommendation. */
  rank: number;
  /** Why this one is ranked where it is, in one sentence. */
  rankReason: string;
};

export type RejectedOffer = {
  candidate: Candidate;
  /** Every constraint it failed, not just the first — the buyer may want to relax one. */
  failed: Rejection[];
  /** The constraint it failed that is cheapest for the buyer to relax, if any. */
  primary: Rejection;
};

export type SolveResult = {
  /** The constraints as enforced, echoed back so the buyer can correct them. */
  constraints: { kind: ConstraintKind; text: string }[];
  considered: number;
  satisfied: SolvedOffer[];
  rejected: RejectedOffer[];
  /** Rejections grouped by constraint, which is the headline the buyer reads. */
  rejectionSummary: { kind: ConstraintKind; constraint: string; count: number }[];
  /** Present when nothing satisfied everything: which constraint to relax, and what it would admit. */
  relaxation: null | {
    kind: ConstraintKind;
    constraint: string;
    wouldAdmit: number;
    sentence: string;
  };
  /** One sentence stating the outcome. Written here so every surface agrees. */
  headline: string;
  /**
   * True when the buyer described a need and nothing in the catalogue matched
   * it, so every offer below is being offered *despite* that.
   *
   * This is the difference between "here are 10 options" and "we do not sell
   * laptops, but here is what else is in electronics". Without it a zero
   * relevance score is indistinguishable from a search that stated only hard
   * constraints and described no need at all, and the result gets announced as
   * a match — which is the one thing this engine must never do.
   */
  needUnmatched: boolean;
  /**
   * Products that matched the words the buyer typed but were thrown out by a
   * category they never stated.
   *
   * A category constraint is a hard filter, and when a model guesses it from a
   * word like "bag" the right product can be excluded silently — the buyer
   * sees twenty laptops and no sign that a laptop bag existed. Reporting the
   * count is not a fix for the guess, but a hidden exclusion the buyer cannot
   * see is the part that makes it a trap.
   */
  hiddenByCategory: number;
};

/* ──────────────────────────────── The solver ──────────────────────────────── */

/**
 * Admit only candidates that satisfy every constraint; explain every rejection.
 *
 * Pure: `now` is passed in rather than read, so a result is reproducible and
 * the same call in a test gives the same dates months later.
 */
export function solveConstraints(
  candidates: Candidate[],
  constraints: Constraint[],
  buyer: BuyerContext,
  now: Date,
  /**
   * What the buyer said they needed, if they described one.
   *
   * Only its presence is used, never its text: the matching already happened
   * upstream and arrived as `candidate.relevance`. It is here so the solver
   * can tell "nothing matched the need" from "no need was given", which look
   * identical from the scores alone.
   */
  need = "",
): SolveResult {
  const paymentMode =
    (constraints.find((c) => c.kind === "payment_mode") as { value: "COD" | "PREPAID" } | undefined)
      ?.value ?? buyer.paymentMode ?? "PREPAID";

  const arriveBy = parseDate(
    (constraints.find((c) => c.kind === "arrive_by") as { value: string } | undefined)?.value,
  );

  const satisfied: SolvedOffer[] = [];
  const rejected: RejectedOffer[] = [];

  for (const candidate of candidates) {
    // Economics first: `max_true_cost` and `arrive_by` are checked against
    // computed values, so they have to exist before the constraints are tested.
    const cost = trueCost({
      priceInr: candidate.priceInr,
      paymentMode,
      pinTier: buyer.pinTier,
      sellerDefectRatePct: candidate.seller.defectRatePct,
      refundable: candidate.refundable,
    });

    const forecast = deliveryForecast(
      {
        sellerSlaDays: candidate.seller.fulfilmentSlaDays,
        pinTier: buyer.pinTier,
        paymentMode,
        buyerPriorRto: buyer.priorRto,
        inStock: candidate.stock > 0,
      },
      now,
      arriveBy,
    );

    const failed: Rejection[] = [];
    const passed: Satisfaction[] = [];

    for (const c of constraints) {
      const outcome = test(c, candidate, cost, forecast, paymentMode);
      if (outcome.ok) passed.push({ constraint: describeConstraint(c), kind: c.kind, evidence: outcome.evidence });
      else failed.push({ constraint: describeConstraint(c), kind: c.kind, actual: outcome.actual });
    }

    if (failed.length === 0) {
      satisfied.push({ candidate, satisfied: passed, cost, forecast, rank: 0, rankReason: "" });
    } else {
      rejected.push({ candidate, failed, primary: pickPrimary(failed) });
    }
  }

  // Rank the survivors.
  //
  // Relevance comes first, in bands rather than by exact score: a product that
  // actually answers the stated need must outrank a cheaper one that does not,
  // but two products that both answer it should then compete on what they cost.
  // Banding gives both - without it, a one-point scoring difference would
  // outweigh a three-hundred-rupee one.
  //
  // Within a band: expected total cost, then the arrival date, then rating.
  // Between two offers that cost the same, the one that arrives sooner is
  // strictly better.
  const bestRelevance = Math.max(0, ...satisfied.map((o) => o.candidate.relevance ?? 0));
  const tiers = relevanceTiers(satisfied);
  satisfied.sort(
    (a, b) =>
      (tiers.get(b) ?? 0) - (tiers.get(a) ?? 0) ||
      // Inside the top tier, a markedly better match still leads: between the
      // pillow and a bedsheet that both mention "gift for mother", the one the
      // buyer actually described wins before price is consulted.
      relevanceStep(b.candidate.relevance) - relevanceStep(a.candidate.relevance) ||
      // A clear margin inside one step still decides, before price does.
      //
      // The step is deliberately coarse so that score wobble does not
      // override a real saving, but it was coarse enough to flatten 49
      // against 41 — and a cheaper winter jacket then outranked the hiking
      // boots for "trekking in the monsoon". A fifth of the leader's score
      // is a difference the buyer would recognise; below that, price wins.
      relevanceMargin(b.candidate.relevance, a.candidate.relevance, bestRelevance) ||
      a.cost.expectedTotalInr - b.cost.expectedTotalInr ||
      Date.parse(a.forecast.confidentAt) - Date.parse(b.forecast.confidentAt) ||
      (b.candidate.ratingAvg ?? 0) - (a.candidate.ratingAvg ?? 0),
  );

  // Relevant products thrown out by the category alone. Counted only where
  // the candidate scored on the buyer's own words, so an unrelated product
  // that merely sits in another category is not reported as "hidden".
  const hiddenByCategory = rejected.filter(
    (r) =>
      r.primary.kind === "category" &&
      (r.candidate.relevance ?? 0) > 0 &&
      r.failed.length === 1,
  ).length;

  // A need was described, offers came back, and not one of them matched it.
  const needUnmatched = need.trim().length > 0 && satisfied.length > 0 && bestRelevance === 0;

  const leader = satisfied[0];
  satisfied.forEach((o, i) => {
    o.rank = i + 1;
    o.rankReason = rankReason(o, leader, i);
  });

  return {
    constraints: constraints.map((c) => ({ kind: c.kind, text: describeConstraint(c) })),
    considered: candidates.length,
    satisfied,
    rejected,
    rejectionSummary: summarise(rejected),
    needUnmatched,
    hiddenByCategory,
    // Offered when nothing satisfied everything, and also when offers came
    // back but none of them is what was asked for: "we have 20 things in
    // apparel" is not an answer to "iron for my shirts", and the way out is
    // the same — name the constraint to drop.
    relaxation:
      satisfied.length === 0 || needUnmatched ? relaxation(rejected, constraints) : null,
    headline: headline(candidates.length, satisfied, rejected, constraints, needUnmatched),
  };
}

/** Test one constraint against one candidate. */
function test(
  c: Constraint,
  p: Candidate,
  cost: TrueCost,
  forecast: DeliveryForecast,
  paymentMode: "COD" | "PREPAID",
): { ok: true; evidence: string } | { ok: false; actual: string } {
  switch (c.kind) {
    case "category": {
      const want = c.value.toLowerCase();
      const hay = `${p.category} ${p.subcategory ?? ""}`.toLowerCase();
      return hay.includes(want) || want.includes(p.category.toLowerCase())
        ? { ok: true, evidence: p.subcategory ? `${p.category} / ${p.subcategory}` : p.category }
        : { ok: false, actual: `it is ${p.category}` };
    }

    case "max_price":
      return p.priceInr <= c.value
        ? { ok: true, evidence: `₹${p.priceInr.toLocaleString("en-IN")}` }
        : { ok: false, actual: `₹${p.priceInr.toLocaleString("en-IN")} — over by ₹${(p.priceInr - c.value).toLocaleString("en-IN")}` };

    case "min_price":
      return p.priceInr >= c.value
        ? { ok: true, evidence: `₹${p.priceInr.toLocaleString("en-IN")}` }
        : { ok: false, actual: `₹${p.priceInr.toLocaleString("en-IN")}` };

    case "brand":
      return p.brand.toLowerCase() === c.value.toLowerCase()
        ? { ok: true, evidence: p.brand }
        : { ok: false, actual: `it is ${p.brand}` };

    case "min_rating":
      return (p.ratingAvg ?? 0) >= c.value
        ? { ok: true, evidence: `${p.ratingAvg}★ from ${(p.ratingCount ?? 0).toLocaleString("en-IN")} ratings` }
        : { ok: false, actual: `${p.ratingAvg ?? 0}★` };

    case "in_stock":
      return p.stock > 0
        ? { ok: true, evidence: `${p.stock} in stock` }
        : { ok: false, actual: "out of stock" };

    case "attribute": {
      const found = findAttribute(p.attributes, c.key);
      if (found === undefined) {
        return { ok: false, actual: `${humanKey(c.key)} is not stated on this listing` };
      }
      return attributeMatches(found, c.value)
        ? { ok: true, evidence: `${humanKey(c.key)}: ${formatValue(found)}` }
        : { ok: false, actual: `${humanKey(c.key)} is ${formatValue(found)}` };
    }

    case "arrive_by": {
      const d = forecast.deadline;
      if (!d) return { ok: true, evidence: `likely ${isoDay(new Date(forecast.likelyAt))}` };
      // The confident date is the one that has to meet the deadline. A date
      // that only just makes it on the optimistic estimate is not an answer
      // to "I need it before Diwali".
      return d.confidentMeets
        ? {
            ok: true,
            evidence: `${forecast.confidencePct}% confident by ${isoDay(new Date(forecast.confidentAt))}`,
          }
        : {
            ok: false,
            actual: d.likelyMeets
              ? `likely ${isoDay(new Date(forecast.likelyAt))} but only ${forecast.confidencePct}% confident by ` +
                `${isoDay(new Date(forecast.confidentAt))} — too tight to promise`
              : `arrives ${isoDay(new Date(forecast.likelyAt))} at the earliest`,
          };
    }

    case "payment_mode":
      if (c.value === "PREPAID") return { ok: true, evidence: "prepaid is always available" };
      return p.codEligible
        ? { ok: true, evidence: "cash on delivery available" }
        : { ok: false, actual: "this seller does not accept cash on delivery" };

    case "max_true_cost":
      return cost.expectedTotalInr <= c.value
        ? { ok: true, evidence: `₹${cost.expectedTotalInr.toLocaleString("en-IN")} all in` }
        : {
            ok: false,
            actual:
              `₹${cost.expectedTotalInr.toLocaleString("en-IN")} once ` +
              `${paymentMode === "COD" ? "the COD fee, " : ""}delivery and return risk are counted`,
          };

    case "max_seller_defect_rate":
      return p.seller.defectRatePct <= c.value
        ? { ok: true, evidence: `${p.seller.name} fails ${p.seller.defectRatePct}% of orders` }
        : { ok: false, actual: `${p.seller.name} fails ${p.seller.defectRatePct}% of orders` };
  }
}

/* ──────────────────────── Attribute matching ──────────────────────── */

/**
 * Find an attribute by a loose key.
 *
 * The buyer says "induction"; the listing says `induction: true`. The buyer
 * says "capacity"; the listing says `capacity_l: 5`. An exact key lookup finds
 * neither, and silently reporting "not stated" for an attribute the product
 * clearly has is the failure mode that makes constraint filters untrustworthy.
 */
function findAttribute(attrs: Record<string, unknown>, key: string): unknown {
  const want = normaliseKey(key);
  if (!want) return undefined;

  const entries = Object.entries(attrs ?? {});

  // Exact, then prefix (capacity -> capacity_l), then substring either way.
  for (const [k, v] of entries) if (normaliseKey(k) === want) return v;
  for (const [k, v] of entries) if (normaliseKey(k).startsWith(want)) return v;
  for (const [k, v] of entries) {
    const nk = normaliseKey(k);
    if (nk.includes(want) || want.includes(nk)) return v;
  }
  return undefined;
}

/**
 * Does an attribute value satisfy what the buyer asked for?
 *
 * Handles the three shapes the catalogue actually uses: a boolean flag, a
 * number with an optional comparison, and a string or range like "6-11" that
 * a size has to fall inside.
 */
function attributeMatches(actual: unknown, wanted: string | number | boolean): boolean {
  if (typeof wanted === "boolean") return toBool(actual) === wanted;

  // A numeric want against a numeric actual, including "at most 5 litres"
  // expressed as a bare 5 — a capacity constraint reads as a ceiling.
  if (typeof wanted === "number") {
    const a = toNumber(actual);
    if (a !== null) return a <= wanted || a === wanted;
    return String(actual).toLowerCase().includes(String(wanted));
  }

  const w = String(wanted).trim().toLowerCase();
  if (!w) return false;

  // "yes"/"true"/"no" against a boolean field.
  if (typeof actual === "boolean") {
    if (["yes", "true", "required", "needed"].includes(w)) return actual === true;
    if (["no", "false"].includes(w)) return actual === false;
  }

  // A comparison the buyer wrote out: "<= 5", "under 5", "5l max".
  const cmp = w.match(/^(<=|<|>=|>)\s*([\d.]+)/);
  if (cmp) {
    const a = toNumber(actual);
    const n = Number.parseFloat(cmp[2]);
    if (a !== null && Number.isFinite(n)) {
      if (cmp[1] === "<=") return a <= n;
      if (cmp[1] === "<") return a < n;
      if (cmp[1] === ">=") return a >= n;
      return a > n;
    }
  }

  const actualStr = String(actual).trim().toLowerCase();

  // A size inside a stated range: "9" satisfies "6-11".
  const range = actualStr.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  const wantNum = Number.parseFloat(w);
  if (range && Number.isFinite(wantNum)) {
    return wantNum >= Number.parseFloat(range[1]) && wantNum <= Number.parseFloat(range[2]);
  }

  return actualStr === w || actualStr.includes(w) || w.includes(actualStr);
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1";
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number.parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

function normaliseKey(k: string): string {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function humanKey(k: string): string {
  return String(k)
    .replace(/_(l|ml|g|w|mah|inch|hours|days|years|km)$/i, (_m, u) => ` (${u})`)
    .replace(/_/g, " ")
    .trim();
}

function formatValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/* ──────────────────────── Explaining the outcome ──────────────────────── */

/**
 * Which failure to lead with.
 *
 * A candidate can fail several constraints, and the buyer reads one line. The
 * order here is "how fundamental is this mismatch": a pressure cooker is not
 * going to become a shoe, but a budget or a date is something the buyer may
 * well choose to relax once they know it is what stands in the way.
 */
const PRIMARY_ORDER: ConstraintKind[] = [
  "category",
  "attribute",
  "brand",
  "in_stock",
  "payment_mode",
  "min_rating",
  "max_seller_defect_rate",
  "max_price",
  "min_price",
  "max_true_cost",
  "arrive_by",
];

function pickPrimary(failed: Rejection[]): Rejection {
  for (const kind of PRIMARY_ORDER) {
    const hit = failed.find((f) => f.kind === kind);
    if (hit) return hit;
  }
  return failed[0];
}

function summarise(rejected: RejectedOffer[]): SolveResult["rejectionSummary"] {
  const byKind = new Map<string, { kind: ConstraintKind; constraint: string; count: number }>();
  for (const r of rejected) {
    const key = `${r.primary.kind}:${r.primary.constraint}`;
    const row = byKind.get(key);
    if (row) row.count += 1;
    else byKind.set(key, { kind: r.primary.kind, constraint: r.primary.constraint, count: 1 });
  }
  return [...byKind.values()].sort((a, b) => b.count - a.count);
}

/**
 * Nothing satisfied everything. Name the single constraint that, relaxed,
 * would admit the most products — which is more useful than "no results".
 */
function relaxation(
  rejected: RejectedOffer[],
  constraints: Constraint[],
): SolveResult["relaxation"] {
  if (rejected.length === 0) return null;

  // A candidate is admitted by relaxing constraint K only if K is the *only*
  // thing it failed. Counting every candidate that merely failed K would
  // promise results that relaxing K does not actually deliver.
  const counts = new Map<ConstraintKind, number>();
  for (const r of rejected) {
    if (r.failed.length !== 1) continue;
    const k = r.failed[0].kind;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  const [kind, wouldAdmit] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const c = constraints.find((x) => x.kind === kind);
  if (!c) return null;

  const text = describeConstraint(c);
  return {
    kind,
    constraint: text,
    wouldAdmit,
    sentence:
      `Nothing satisfies all ${constraints.length} constraints. Dropping "${text}" alone ` +
      `would admit ${wouldAdmit} ${wouldAdmit === 1 ? "product" : "products"}.`,
  };
}

/**
 * Group candidates into relevance tiers, relative to the best match.
 *
 * A fixed score threshold does not work here, because what counts as a strong
 * score depends entirely on how much the buyer said. One phrase hit scores 24;
 * a long sentence with several hits scores 80. An absolute cutoff either puts
 * everything in the top tier for a wordy query, or nothing in it for a terse
 * one - and the first of those is a real bug I hit: for "a gift for my mother
 * who has back pain" the pillow scored 78 and a face oil 27, both cleared a
 * fixed cutoff of 24, so they tied and the cheaper face oil was recommended.
 *
 * Scoring relative to the leader fixes that: a candidate at less than half the
 * best score is a visibly looser match and is tiered below it, whatever the
 * absolute numbers. Within a tier, cost decides - which is what the buyer
 * wants between two things that both genuinely answer the question.
 */
/**
 * A coarse bucket of a relevance score, so that a decisively better match
 * outranks a cheaper one, while two comparable matches still compete on price.
 * Rounding to the nearest 24 - one phrase hit - means a difference has to be
 * worth about a whole extra matched phrase before it overrides cost.
 */
/**
 * Which of two relevance scores is clearly better, relative to the leader.
 *
 * Returns a sort value only when the gap is worth more than price. A fixed
 * threshold cannot work here: a long sentence scores everything higher, so
 * "clearly better" has to be read against the best score in the set.
 */
function relevanceMargin(
  a: number | undefined,
  b: number | undefined,
  best: number,
): number {
  if (best <= 0) return 0;
  const gap = (a ?? 0) - (b ?? 0);
  return Math.abs(gap) >= best * 0.15 ? gap : 0;
}

function relevanceStep(relevance: number | undefined): number {
  return Math.round((relevance ?? 0) / 24);
}

function relevanceTiers(offers: SolvedOffer[]): Map<SolvedOffer, number> {
  const best = Math.max(0, ...offers.map((o) => o.candidate.relevance ?? 0));
  const tiers = new Map<SolvedOffer, number>();

  for (const o of offers) {
    const r = o.candidate.relevance ?? 0;
    // No relevance signal at all (a pure constraint search with no need
    // described): every candidate is equally on-target, so cost alone ranks.
    if (best === 0) {
      tiers.set(o, 0);
      continue;
    }
    tiers.set(o, r >= best * 0.5 ? 2 : r > 0 ? 1 : 0);
  }
  return tiers;
}

function rankReason(o: SolvedOffer, leader: SolvedOffer | undefined, index: number): string {
  if (index === 0) {
    const bits: string[] = [];
    // When relevance decided the order, say so: claiming "cheapest" about an
    // offer that is not the cheapest is the kind of small lie that costs the
    // whole page its credibility.
    if (relevanceStep(o.candidate.relevance) >= 1) {
      bits.push("best match for what you described");
    }
    bits.push(`₹${o.cost.expectedTotalInr.toLocaleString("en-IN")} all in`);
    if (o.cost.returnRiskInr > 0) {
      bits.push(`${o.candidate.seller.defectRatePct}% seller defect rate already priced in`);
    }
    return `Recommended: ${bits.join(", ")}.`;
  }

  if (!leader) return "";

  // A less relevant offer is not usefully described by its price gap.
  if (relevanceStep(o.candidate.relevance) < relevanceStep(leader.candidate.relevance)) {
    return `A looser match for what you described, at ₹${o.cost.expectedTotalInr.toLocaleString("en-IN")} all in.`;
  }
  const delta = o.cost.expectedTotalInr - leader.cost.expectedTotalInr;
  const stickerDelta = o.cost.stickerInr - leader.cost.stickerInr;

  // The case worth making on screen: a cheaper sticker that is dearer once the
  // seller's failure rate is counted. That is the whole argument for true cost.
  if (stickerDelta < 0 && delta > 0) {
    return (
      `₹${Math.abs(stickerDelta).toLocaleString("en-IN")} cheaper on the sticker, but ` +
      `₹${delta.toLocaleString("en-IN")} dearer once ${o.candidate.seller.name}'s ` +
      `${o.candidate.seller.defectRatePct}% defect rate is counted.`
    );
  }
  if (delta === 0) return "Same expected cost; arrives later.";
  return `₹${delta.toLocaleString("en-IN")} more than the recommendation.`;
}

function headline(
  considered: number,
  satisfied: SolvedOffer[],
  rejected: RejectedOffer[],
  constraints: Constraint[],
  needUnmatched = false,
): string {
  const n = constraints.length;
  if (considered === 0) return "Nothing in the catalogue matched what you described.";

  // Offers exist, but none of them is the thing that was asked for. Said
  // plainly and first: a buyer who wanted a laptop is not helped by a count of
  // how many speakers satisfied their price ceiling.
  if (needUnmatched) {
    return (
      `We do not have what you described. ${satisfied.length} other ` +
      `${satisfied.length === 1 ? "offer" : "offers"} came close on the rest of ` +
      `what you asked for — judge them yourself.`
    );
  }

  // A pure need with no hard constraint: everything considered trivially
  // qualifies, so the useful statement is what was found and how it is ordered,
  // not a count of constraints nobody stated.
  if (n === 0) {
    return satisfied.length === 0
      ? "Nothing in the catalogue matched what you described."
      : `${satisfied.length} ${satisfied.length === 1 ? "offer" : "offers"} match what you ` +
        `described, ordered by what they will really cost you.`;
  }

  if (satisfied.length === 0) {
    return `0 of ${considered} offers satisfy all ${n} ${n === 1 ? "constraint" : "constraints"}.`;
  }

  const parts = summarise(rejected)
    .slice(0, 4)
    .map((r) => `${r.count} ${shortReason(r)}`);

  return (
    `${satisfied.length} of ${considered} ${considered === 1 ? "offer" : "offers"} ` +
    `satisfy all ${n} ${n === 1 ? "constraint" : "constraints"}` +
    (parts.length ? `. Rejected: ${parts.join(" · ")}.` : ".")
  );
}

/** The compressed rejection label, as it appears in the headline. */
function shortReason(r: { kind: ConstraintKind; constraint: string }): string {
  switch (r.kind) {
    case "category": return "wrong category";
    case "max_price": return "over budget";
    case "min_price": return "under the price floor";
    case "brand": return "another brand";
    case "min_rating": return "rated too low";
    case "in_stock": return "out of stock";
    case "attribute": return `failed ${r.constraint}`;
    case "arrive_by": return "arrive too late";
    case "payment_mode": return "no cash on delivery";
    case "max_true_cost": return "over the true-cost ceiling";
    case "max_seller_defect_rate": return "seller fails too often";
  }
}

export { findAttribute, attributeMatches, pickPrimary, relevanceStep, relevanceTiers };
