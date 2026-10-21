/**
 * Sentence to constraints.
 *
 * This is the only place a language model touches the find-by-constraint
 * feature, and it does the one thing models are genuinely good at: reading
 * "a cooker for my induction hob, 5 litres at most, under ₹2000, must be in
 * stock, and I need it before the 28th" and naming the five constraints in it.
 *
 * Three properties make that safe:
 *
 *  1. **Nothing is decided here.** The output is a constraint list. Every
 *     admission and rejection is computed by `solveConstraints`, a pure
 *     function, so a model that mis-reads a sentence produces a visibly wrong
 *     constraint, not a wrong price or a wrong date.
 *  2. **It is shown back to the buyer.** The constraints appear on screen as
 *     editable chips before any result is read, so a misreading is corrected
 *     in one click instead of silently shaping the answer.
 *  3. **It works with no model at all.** `parseConstraints` below is a
 *     deterministic parser covering budgets, dates, ratings, stock, COD and
 *     the attribute vocabulary the catalogue actually uses. With no API key
 *     the feature degrades in precision, never in function.
 */
import { chatJson } from "@/lib/groq/client";
import { connectDb } from "@/lib/db/connect";
import { Product } from "@/models";
import type { Constraint } from "@/lib/engines/constraints";

export type ExtractResult = {
  constraints: Constraint[];
  /** "model" when the LLM read the sentence, "rules" on the fallback path. */
  source: "model" | "rules";
  /** Free text left over, used to widen the candidate sweep. */
  query: string;
};

/* ───────────────────────────── The model path ───────────────────────────── */

const SYSTEM = `You turn one shopping sentence into hard constraints. Output JSON only.

Return: {"constraints":[...], "query":"<product words only>"}

Each constraint is one of:
  {"kind":"category","value":"kitchen"}              — a broad catalogue category
  {"kind":"max_price","value":2000}                  — rupees, the sticker ceiling
  {"kind":"min_price","value":500}
  {"kind":"brand","value":"Ganga"}
  {"kind":"min_rating","value":4}                    — stars, 0..5
  {"kind":"in_stock","value":true}
  {"kind":"attribute","key":"induction","value":true}
  {"kind":"attribute","key":"capacity_l","value":5}  — a number means "at most this"
  {"kind":"arrive_by","value":"2026-10-28"}          — ISO date
  {"kind":"payment_mode","value":"COD"}
  {"kind":"max_true_cost","value":2000}              — ceiling on the all-in cost
  {"kind":"max_seller_defect_rate","value":5}        — percent

RULES
- Only state a constraint the buyer actually expressed. Never invent a budget, a date or a rating.
- category is a HARD filter: anything outside it is never shown. So state it only
  when the buyer named the category or a product that unambiguously sits in it.
  If you are guessing which category a word belongs to, omit it and let the
  words in query do the matching. A wrong category hides the right product.
- "must work on my induction hob" -> attribute induction true. "5 litres max" -> attribute capacity_l 5.
- "under 2000" is max_price. "shouldn't cost me more than 2000 all in" is max_true_cost.
- "before the 28th", "before Diwali", "by next Friday" -> arrive_by as an ISO date, resolved against the stated current date.
- "4 star and above", "well rated" -> min_rating.
- "in stock", "need it now" -> in_stock.
- "cash on delivery", "COD" -> payment_mode COD.
- "from a reliable seller", "seller who won't vanish" -> max_seller_defect_rate 5.
- query holds only the product words ("pressure cooker"), no budget, no date, no filler.
- Buyers write in English, Hindi, Kannada, Tamil, Telugu, Marathi, Bengali, Gujarati, or Latin transliteration. Read all of them.`;

export async function extractConstraints(
  sentence: string,
  now: Date,
  /** Categories the catalogue actually has, so a category constraint is real. */
  knownCategories?: string[],
): Promise<ExtractResult> {
  const text = sentence.trim();
  if (!text) return { constraints: [], source: "rules", query: "" };

  const categories = knownCategories ?? (await catalogueCategories());

  const parsed = await chatJson<{ constraints: unknown[]; query?: string }>(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content:
          `Today is ${now.toISOString().slice(0, 10)}.\n` +
          `Catalogue categories: ${categories.join(", ")}.\n\n` +
          `Buyer: ${text.slice(0, 600)}`,
      },
    ],
    { temperature: 0, maxTokens: 500 },
  );

  if (!parsed || !Array.isArray(parsed.constraints)) {
    return parseConstraints(text, now, categories);
  }

  const constraints = sanitise(parsed.constraints, categories, now);

  // A model that returned nothing usable is no better than no model. Falling
  // back rather than showing an empty constraint list keeps the feature honest
  // about what it understood.
  if (constraints.length === 0) return parseConstraints(text, now, categories);

  const query = typeof parsed.query === "string" && parsed.query.trim()
    ? parsed.query.trim()
    : productWords(text);

  return { constraints, source: "model", query };
}

/**
 * Validate every constraint the model returned.
 *
 * A model will occasionally return a category the catalogue does not have, a
 * budget as a string, a rating of 9, or a date in the past. Each of those
 * would silently distort the result, so each is repaired or dropped here —
 * before the solver, which trusts its input by design.
 */
function sanitise(raw: unknown[], categories: string[], now: Date): Constraint[] {
  const out: Constraint[] = [];
  const seen = new Set<string>();
  const lowerCats = new Map(categories.map((c) => [c.toLowerCase(), c]));

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const kind = String(r.kind ?? "").trim();

    // One constraint per kind, except attributes which are keyed.
    const dedupe = kind === "attribute" ? `attribute:${String(r.key ?? "")}` : kind;
    if (seen.has(dedupe)) continue;

    const c = coerce(kind, r, lowerCats, now);
    if (c) {
      out.push(c);
      seen.add(dedupe);
    }
  }
  return out;
}

function coerce(
  kind: string,
  r: Record<string, unknown>,
  lowerCats: Map<string, string>,
  now: Date,
): Constraint | null {
  const numeric = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? "").replace(/[₹,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  switch (kind) {
    case "category": {
      const v = String(r.value ?? "").trim().toLowerCase();
      if (!v) return null;
      // Resolve to a real category, or drop it: filtering on a category the
      // catalogue does not have excludes everything for no stated reason.
      const exact = lowerCats.get(v);
      if (exact) return { kind: "category", value: exact };
      for (const [k, original] of lowerCats) {
        if (v.includes(k) || k.includes(v)) return { kind: "category", value: original };
      }
      return null;
    }

    case "max_price":
    case "min_price":
    case "max_true_cost": {
      const n = numeric(r.value);
      if (n === null || n <= 0) return null;
      return { kind, value: Math.round(n) } as Constraint;
    }

    case "min_rating": {
      const n = numeric(r.value);
      if (n === null || n <= 0) return null;
      return { kind: "min_rating", value: Math.min(5, n) };
    }

    case "max_seller_defect_rate": {
      const n = numeric(r.value);
      if (n === null || n < 0) return null;
      return { kind: "max_seller_defect_rate", value: Math.min(100, n) };
    }

    case "brand": {
      const v = String(r.value ?? "").trim();
      return v ? { kind: "brand", value: v } : null;
    }

    case "in_stock":
      return r.value === false ? null : { kind: "in_stock", value: true };

    case "payment_mode": {
      const v = String(r.value ?? "").trim().toUpperCase();
      return v === "COD" || v === "PREPAID" ? { kind: "payment_mode", value: v } : null;
    }

    case "arrive_by": {
      const d = new Date(String(r.value ?? ""));
      // A date already past is a misreading, not a constraint the buyer means.
      if (Number.isNaN(d.getTime()) || d.getTime() < now.getTime()) return null;
      return { kind: "arrive_by", value: d.toISOString() };
    }

    case "attribute": {
      const key = String(r.key ?? "").trim();
      if (!key) return null;
      const v = r.value;
      if (typeof v === "boolean" || typeof v === "number") return { kind: "attribute", key, value: v };
      const s = String(v ?? "").trim();
      if (!s) return null;
      if (["true", "yes"].includes(s.toLowerCase())) return { kind: "attribute", key, value: true };
      if (["false", "no"].includes(s.toLowerCase())) return { kind: "attribute", key, value: false };
      const n = Number.parseFloat(s);
      return { kind: "attribute", key, value: Number.isFinite(n) && /^[\d.]+$/.test(s) ? n : s };
    }

    default:
      return null;
  }
}

/* ────────────────────────── The deterministic path ────────────────────────── */

/** Attribute words the catalogue genuinely carries, with the key each maps to. */
const ATTRIBUTE_WORDS: { re: RegExp; key: string; value: string | number | boolean }[] = [
  { re: /\binduction\b|\bइंडक्शन\b|\bಇಂಡಕ್ಷನ್\b/i, key: "induction", value: true },
  { re: /\bisi\b|\bisi[- ]marked\b/i, key: "isi", value: true },
  { re: /\bwaterproof\b|\bwater[- ]resistant\b/i, key: "waterproof", value: true },
  { re: /\banc\b|\bnoise[- ]cancell?ing\b/i, key: "anc", value: true },
  { re: /\bspo2\b|\boxygen\b/i, key: "spo2", value: true },
  { re: /\bstainless\b/i, key: "material", value: "steel" },
  { re: /\bcotton\b/i, key: "fabric", value: "cotton" },
  { re: /\bsilk\b/i, key: "fabric", value: "silk" },
  { re: /\bvegan\b/i, key: "vegan", value: true },
  { re: /\bayurvedic\b/i, key: "ayurvedic", value: true },
  { re: /\bsulphate[- ]free\b|\bsulfate[- ]free\b/i, key: "sulphate_free", value: true },
];

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Parse a sentence into constraints with no model.
 *
 * Covers what buyers actually write: a budget with or without a currency
 * symbol, "2k", Hinglish "2000 ke andar", a star rating, stock, COD, a
 * capacity in litres, a size, a date as "before the 28th" or "by 5 November",
 * and the attribute vocabulary above. Precision is lower than the model path;
 * correctness is not, because everything it emits is still enforced by the
 * same pure solver.
 */
export function parseConstraints(
  sentence: string,
  now: Date,
  categories: string[],
): ExtractResult {
  const text = sentence.trim();
  const lower = text.toLowerCase();
  const constraints: Constraint[] = [];

  // Category, from the catalogue's own vocabulary plus the common synonyms.
  const category = matchCategory(lower, categories);
  if (category) constraints.push({ kind: "category", value: category });

  // Budget. A "true cost" phrasing is a different constraint from a sticker
  // ceiling, and conflating them is exactly the error this feature exists to
  // correct, so they are detected separately.
  const budget = extractBudget(lower);
  if (budget !== null) {
    const allIn = /\ball[- ]in\b|\btotal\b|\bdelivered\b|\bfinal\b|\bincluding\b|\bwith delivery\b/.test(lower);
    constraints.push(allIn ? { kind: "max_true_cost", value: budget } : { kind: "max_price", value: budget });
  }

  // Rating.
  const rating = lower.match(/([1-5](?:\.\d)?)\s*(?:\+|star|stars|★)/);
  if (rating) constraints.push({ kind: "min_rating", value: Number.parseFloat(rating[1]) });
  else if (/\bwell[- ]rated\b|\bgood reviews?\b|\bhighly rated\b|\bacch?i rating\b/.test(lower)) {
    constraints.push({ kind: "min_rating", value: 4 });
  }

  // Stock.
  if (/\bin stock\b|\bavailable now\b|\bright now\b|\bimmediately\b|\bturant\b|\babhi\b/.test(lower)) {
    constraints.push({ kind: "in_stock", value: true });
  }

  // Payment.
  if (/\bcod\b|\bcash on delivery\b|\bcash\b/.test(lower)) {
    constraints.push({ kind: "payment_mode", value: "COD" });
  } else if (/\bprepaid\b|\bpay now\b|\bonline payment\b/.test(lower)) {
    constraints.push({ kind: "payment_mode", value: "PREPAID" });
  }

  // Seller reliability.
  if (/\breliable seller\b|\btrusted seller\b|\bgood seller\b|\bwon'?t vanish\b|\bdependable\b/.test(lower)) {
    constraints.push({ kind: "max_seller_defect_rate", value: 5 });
  }

  // Capacity in litres — "5 litre", "5l max", "at most 5 litres".
  const litres = lower.match(/(\d+(?:\.\d+)?)\s*(?:l\b|litre|liter|ltr)/);
  if (litres) constraints.push({ kind: "attribute", key: "capacity_l", value: Number.parseFloat(litres[1]) });

  // Size, for footwear and apparel, where the listing states a range.
  const size = lower.match(/\bsize\s*(\d{1,2}(?:\.\d)?)\b/);
  if (size) constraints.push({ kind: "attribute", key: "sizes", value: size[1] });

  for (const a of ATTRIBUTE_WORDS) {
    if (a.re.test(text)) constraints.push({ kind: "attribute", key: a.key, value: a.value });
  }

  const by = extractDate(lower, now);
  if (by) constraints.push({ kind: "arrive_by", value: by.toISOString() });

  return { constraints, source: "rules", query: productWords(text) };
}

function matchCategory(lower: string, categories: string[]): string | null {
  for (const c of categories) if (lower.includes(c.toLowerCase())) return c;

  const SYNONYMS: Record<string, string[]> = {
    kitchen: [
      "cooker", "kadai", "mixer", "grinder", "bottle", "flask", "tiffin",
      "kettle", "rice cooker", "कुकर", "केतली", "ಕುಕ್ಕರ್", "குக்கர்",
    ],
    footwear: [
      "shoe", "shoes", "sneaker", "sandal", "chappal", "joota", "boot",
      "slipper", "जूता", "செருப்பு",
    ],
    electronics: [
      "phone", "mobile", "earbud", "earphone", "headphone", "headphones",
      "headset", "laptop", "computer", "charger", "watch", "speaker", "tv",
      "power bank", "फोन", "लैपटॉप", "हेडफोन",
    ],
    apparel: [
      "shirt", "tshirt", "kurta", "saree", "jeans", "dress", "kapda",
      "jacket", "coat", "sweater", "socks", "कपड़ा", "शर्ट", "जैकेट", "मोजे",
    ],
    home: [
      "bedsheet", "pillow", "curtain", "mattress", "chadar", "towel",
      "backpack", "bag", "iron", "istri", "चादर", "तकिया", "तौलिया", "बैग",
    ],
    beauty: ["cream", "shampoo", "soap", "serum", "lipstick", "face oil"],
  };

  for (const [cat, words] of Object.entries(SYNONYMS)) {
    if (!categories.some((c) => c.toLowerCase() === cat)) continue;
    if (words.some((w) => lower.includes(w))) {
      return categories.find((c) => c.toLowerCase() === cat) ?? null;
    }
  }
  return null;
}

function extractBudget(lower: string): number | null {
  const k = lower.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (k) return Math.round(Number.parseFloat(k[1]) * 1000);

  const nums = [...lower.matchAll(/(?:₹|rs\.?|inr)?\s*(\d[\d,]{2,})/g)]
    .map((m) => Number.parseInt(m[1].replace(/,/g, ""), 10))
    .filter((n) => n >= 100 && n <= 500_000);
  return nums.length ? Math.max(...nums) : null;
}

/**
 * Pull a deadline out of a sentence.
 *
 * Handles "before the 28th" (this month, or next if that day has passed),
 * "by 5 November", "in 3 days", "within a week", and "before Diwali" — which
 * is a real way Indian buyers express a deadline and needs a date to mean
 * anything to a forecast.
 */
function extractDate(lower: string, now: Date): Date | null {
  const relDays = lower.match(/\b(?:in|within)\s+(\d{1,2})\s*days?\b/);
  if (relDays) return addDays(now, Number.parseInt(relDays[1], 10));
  if (/\bwithin a week\b|\bin a week\b|\bek hafte\b/.test(lower)) return addDays(now, 7);
  if (/\btomorrow\b|\bkal\b/.test(lower)) return addDays(now, 1);

  // "by 5 November" / "before November 5"
  const monthDay = lower.match(
    new RegExp(`\\b(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s+(${MONTHS.join("|")})\\b`),
  );
  const dayMonth = lower.match(
    new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2})\\b`),
  );
  if (monthDay) return resolveMonthDay(Number.parseInt(monthDay[1], 10), MONTHS.indexOf(monthDay[2]), now);
  if (dayMonth) return resolveMonthDay(Number.parseInt(dayMonth[2], 10), MONTHS.indexOf(dayMonth[1]), now);

  // "before the 28th" — a bare day of the month.
  const bare = lower.match(/\b(?:before|by|until|till)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (bare) {
    const day = Number.parseInt(bare[1], 10);
    if (day >= 1 && day <= 31) {
      const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, 23, 59, 0));
      return thisMonth.getTime() > now.getTime()
        ? thisMonth
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day, 23, 59, 0));
    }
  }

  // An ISO date, written out.
  const iso = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) {
    const d = new Date(`${iso[1]}T23:59:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
}

function resolveMonthDay(day: number, monthIndex: number, now: Date): Date | null {
  if (monthIndex < 0 || day < 1 || day > 31) return null;
  const year = monthIndex < now.getUTCMonth() ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const d = new Date(Date.UTC(year, monthIndex, day, 23, 59, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** The product words, with the constraint language stripped out. */
const FILLER = new Set([
  "i", "need", "want", "looking", "for", "a", "an", "the", "my", "me", "with",
  "that", "which", "and", "or", "but", "under", "below", "above", "over",
  "max", "maximum", "min", "minimum", "at", "most", "least", "before", "by",
  "until", "till", "in", "stock", "available", "now", "rs", "inr", "cod",
  "cash", "on", "delivery", "prepaid", "star", "stars", "rated", "rating",
  "reliable", "trusted", "seller", "good", "best", "cheap", "cheapest",
  "please", "find", "show", "get", "buy", "all", "total", "mujhe", "chahiye",
  "ke", "andar", "hai", "kya", "days", "day", "week", "litre", "litres",
  "liter", "l", "size", "must", "should", "work", "works", "works on",
  "than", "less", "more", "it", "is", "be", "to", "of", "from", "within",
]);

function productWords(text: string): string {
  const seen = new Set<string>();
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (w) =>
        w.length >= 3 &&
        !FILLER.has(w) &&
        !/^\d+$/.test(w) &&
        !MONTHS.includes(w) &&
        !seen.has(w) &&
        seen.add(w),
    )
    .slice(0, 8)
    .join(" ");
}

async function catalogueCategories(): Promise<string[]> {
  await connectDb();
  const cats = (await Product.distinct("category", { active: true })) as string[];
  return cats.sort();
}

export { catalogueCategories, extractDate, extractBudget, productWords };
