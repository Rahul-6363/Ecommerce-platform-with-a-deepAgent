/**
 * The finder — the impure shell around the pure constraint solver.
 *
 * Responsibilities, deliberately narrow:
 *
 *  - Build the candidate set: every product that could plausibly match,
 *    expanded into one candidate per seller offering it.
 *  - Hand that set, the constraints and the buyer's context to
 *    `solveConstraints`, which does all the deciding.
 *  - Nothing else. No filtering that the solver should be doing, because a
 *    product quietly dropped here is a product with no rejection reason —
 *    and the rejection reasons are the whole point.
 *
 * The one filter applied before the solver is a *widening* one: a keyword
 * sweep so the candidate set is the plausible slice of the catalogue rather
 * than all of it. Everything narrowing happens in the solver, on the record.
 */
import { connectDb } from "@/lib/db/connect";
import { Offer, Policy, Product, Seller } from "@/models";
import type { LeanOffer, LeanPolicy, LeanSeller } from "@/models";
import { escapeRe } from "@/lib/text";
import { effectiveDefectRates } from "@/lib/sellers";
import {
  solveConstraints,
  type BuyerContext,
  type Candidate,
  type Constraint,
  type SolveResult,
} from "@/lib/engines/constraints";

export type FinderInput = {
  constraints: Constraint[];
  buyer: BuyerContext;
  /** Free text used only to widen the candidate sweep, never to reject. */
  query?: string;
  /**
   * What the buyer actually typed or said, before anything was stripped out.
   *
   * `query` holds the product words only - the extractor removes the filler so
   * the keyword search is not diluted. But a need is expressed in exactly that
   * filler: "listen TO music while running" survives as "listen music while
   * running", which no longer matches the phrase a product declares it solves.
   * Need matching therefore reads the original sentence, and keyword matching
   * keeps using the stripped query.
   */
  sentence?: string;
  now: Date;
  /** Cap on products swept, before the per-seller expansion. */
  limit?: number;
};

export type FinderResult = SolveResult & {
  /** How many distinct products and sellers were in play. */
  scope: { products: number; offers: number; sellers: number };
};

export async function findOffers(input: FinderInput): Promise<FinderResult> {
  await connectDb();

  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 40), 1), 80);
  const products = await sweep(
    input.query ?? "",
    input.sentence ?? "",
    input.constraints,
    limit,
  );

  if (products.length === 0) {
    const empty = solveConstraints(
      [],
      input.constraints,
      input.buyer,
      input.now,
      `${input.sentence ?? ""} ${input.query ?? ""}`.trim(),
    );
    // No candidates: nothing to rank, but the caller still needs the shape.
    return { ...empty, scope: { products: 0, offers: 0, sellers: 0 } };
  }

  const skus = products.map((p) => p.sku);
  const [offers, sellers, policies, observedRates] = await Promise.all([
    Offer.find({ sku: { $in: skus }, active: true }).lean<LeanOffer[]>(),
    Seller.find({}).lean<LeanSeller[]>(),
    Policy.find({ policyId: { $in: [...new Set(products.map((p) => p.policyId))] } })
      .select("policyId replacementAllowed")
      .lean<LeanPolicy[]>(),
    // The rate the platform has actually observed, blended toward the seller's
    // declared rate while the sample is small. This is what closes the loop:
    // an upheld claim raises a seller's rate, which raises the true cost the
    // next buyer sees, which costs that seller comparisons.
    effectiveDefectRates(),
  ]);

  const sellerById = new Map(sellers.map((s) => [s.sellerId, s]));
  const replaceable = new Map(policies.map((p) => [p.policyId, p.replacementAllowed]));

  const candidates: Candidate[] = [];
  const sellersSeen = new Set<string>();

  for (const p of products) {
    // The product's own seller is its default offer; `Offer` rows are the
    // alternatives beside it. Both go through the solver identically — the
    // default is not privileged.
    const listings: { sellerId: string; priceInr: number; stock: number; cod: boolean; sla: number | null }[] = [
      {
        sellerId: p.sellerId,
        priceInr: p.priceInr,
        stock: p.stock ?? 0,
        cod: Boolean(p.codEligible),
        sla: null,
      },
      ...offers
        .filter((o) => o.sku === p.sku)
        .map((o) => ({
          sellerId: o.sellerId,
          priceInr: o.priceInr,
          stock: o.stock ?? 0,
          cod: Boolean(o.codEligible),
          sla: o.fulfilmentSlaDays,
        })),
    ];

    for (const l of listings) {
      const seller = sellerById.get(l.sellerId);
      if (!seller) continue; // an offer from a seller we have no record of is not comparable
      sellersSeen.add(l.sellerId);

      candidates.push({
        sku: p.sku,
        title: p.title,
        brand: p.brand,
        category: p.category,
        subcategory: p.subcategory,
        priceInr: l.priceInr,
        mrpInr: p.mrpInr,
        ratingAvg: p.ratingAvg,
        ratingCount: p.ratingCount,
        stock: l.stock,
        codEligible: l.cod,
        attributes: (p.attributes ?? {}) as Record<string, unknown>,
        imageUrl: p.imageUrl,
        imageEmoji: p.imageEmoji,
        accentHex: p.accentHex,
        refundable: replaceable.get(p.policyId) !== false,
        // Carried from the sweep so the solver can rank a product that answers
        // the need above a cheaper one that does not.
        relevance: (p as { relevance?: number }).relevance ?? 0,
        seller: {
          sellerId: seller.sellerId,
          name: seller.name,
          city: seller.city,
          ratingAvg: seller.ratingAvg,
          defectRatePct: observedRates.get(seller.sellerId) ?? seller.defectRatePct ?? 0,
          // A listing may dispatch faster than the seller's general SLA.
          fulfilmentSlaDays: l.sla ?? seller.fulfilmentSlaDays ?? 4,
        },
      });
    }
  }

  // The need is handed to the solver so it can distinguish "nothing matched
  // what you described" from "you described nothing". Both produce candidates
  // with zero relevance, and only one of them is a match.
  const solved = solveConstraints(
    candidates,
    input.constraints,
    input.buyer,
    input.now,
    `${input.sentence ?? ""} ${input.query ?? ""}`.trim(),
  );

  return {
    ...solved,
    scope: {
      products: products.length,
      offers: candidates.length,
      sellers: sellersSeen.size,
    },
  };
}

/**
 * The widening sweep.
 *
 * This is the step that decides whether the buyer has to scroll, and the
 * literal version of it was the weakest part of the feature: a regex over
 * title and tags means "something for my mother's back pain" finds nothing,
 * even though the orthopaedic pillow is sitting in the catalogue. The buyer
 * then does what they always do - gives up on describing the need and goes
 * back to guessing product names.
 *
 * So the sweep matches three ways, widest first:
 *
 *  1. **The need vocabulary.** Every product lists the needs it answers in
 *     the buyer's own words (`solves`), and a whole phrase from the query is
 *     matched against it. "back pain" hits the orthopaedic pillow directly.
 *  2. **Expanded terms.** A need is widened through a synonym table ("back
 *     pain" also searches orthopaedic, cervical, posture, support), so a
 *     phrasing nobody thought to seed still lands on the right shelf.
 *  3. **Literal text**, as before, over title, tags, brand, description,
 *     subcategory and category.
 *
 * Everything here only ever *widens* the candidate set. Nothing is narrowed
 * except by the category constraint, because a product dropped here would
 * reach the buyer with no rejection reason - and the reasons are the product.
 */
async function sweep(
  query: string,
  sentence: string,
  constraints: Constraint[],
  limit: number,
) {
  const filter: Record<string, unknown> = { active: true };

  const wantedCategory = (
    constraints.find((c) => c.kind === "category") as { value: string } | undefined
  )?.value;

  // Keyword matching uses the stripped product words plus the category, so the
  // sweep still reaches the right shelf.
  const keywords = `${query} ${wantedCategory ?? ""}`.toLowerCase().trim();

  // Need matching reads only what the BUYER said. The category is deliberately
  // excluded: it is a filter the extractor inferred, not a need the buyer
  // described, and letting it score relevance rewards whichever product
  // happens to list that word. With "kitchen" in the need text a ₹2,617 mixer
  // outranked a ₹647 bottle for no reason the buyer would recognise.
  const needText = `${sentence} ${query}`.toLowerCase().trim();

  const toWords = (text: string) =>
    // Deduplicated: "carry hot tea to the office" repeats "to", and a word
    // counted twice scored twice. That is how a kurta whose stated uses are
    // "hot weather" and "office casual" came to outrank a vacuum flask for a
    // buyer who wanted to carry hot tea to the office.
    [
      ...new Set(
        text
          .split(/[\s,]+/)
          .filter((t) => t.length >= 2 && !SWEEP_STOPWORDS.has(t)),
      ),
    ].slice(0, 10);

  // Two word lists, because searching and scoring want different things.
  //
  // `searchWords` includes the inferred category, so the database sweep still
  // reaches the right shelf. `scoreWords` does not, because a category is a
  // filter rather than a need: scoring it rewards whichever product happens to
  // list that word, which is how a ₹2,617 mixer came to outrank a ₹647 bottle
  // for a buyer who had said nothing but "kitchen".
  const searchWords = toWords(keywords);
  const scoreWords = toWords(`${sentence} ${query}`.toLowerCase().trim());

  // Adjacent word groups, so "back pain" and "cook rice" match a seeded need
  // phrase rather than only the individual words.
  const phrases = ngrams(needText);

  // Synonyms, so an unseeded phrasing still reaches the right shelf.
  const expanded = expandNeeds(needText);

  const clauses: Record<string, unknown>[] = [];

  for (const phrase of [...phrases, ...expanded]) {
    const re = new RegExp(escapeRe(phrase), "i");
    clauses.push({ solves: re }, { tags: re }, { title: re }, { description: re });
  }

  for (const t of searchWords) {
    const re = new RegExp(escapeRe(t), "i");
    clauses.push(
      { title: re }, { tags: re }, { brand: re }, { solves: re },
      { description: re }, { subcategory: re }, { category: re },
    );
  }

  if (clauses.length) filter.$or = clauses;

  // Read wider than the limit, then rank, so the cap drops the least relevant
  // rows rather than whatever the database happened to return first.
  const rows = await Product.find(filter)
    .sort({ ratingCount: -1, ratingAvg: -1 })
    .limit(limit * 2)
    .lean();

  // Scoring is weighted by how much each kind of match actually tells us.
  //
  // A phrase the buyer said matching a phrase someone declared this product
  // solves is near-certain evidence ("back pain" -> the orthopaedic pillow).
  // A synonym match is weaker: the table widened the search on our initiative,
  // not the buyer's. And a single word is weakest of all, because "gift" and
  // "mother" match half the catalogue.
  //
  // Getting these weights wrong is not cosmetic. With phrase and synonym hits
  // scored equally, "a gift for my mother who has back pain" ranked a face oil
  // above the orthopaedic pillow - the synonym table had injected "face oil"
  // from the generic `gift` key, and three weak hits outscored one exact one.
  const scored = rows
    .map((p) => {
      const solves = (p.solves ?? []).join(" | ").toLowerCase();
      const text =
        `${p.title} ${p.brand} ${p.subcategory} ${(p.tags ?? []).join(" ")} ${p.description}`.toLowerCase();
      // The product type, weighted separately from the prose it used to be
      // buried in. "iron", "rice cooker", "socks" — this is the noun a buyer
      // leads with, and scoring it at a description word's +1 is what let
      // "iron for shirts" return socks: "shirts" hit the socks' stated uses
      // while "iron" earned a single point against the iron's own type.
      const kind = `${p.subcategory ?? ""} ${p.category ?? ""} ${p.title}`.toLowerCase();

      /**
       * Does `haystack` contain `needle` as a whole word?
       *
       * Substring matching made short words wildly promiscuous: "to" matched
       * inside "cotton", "the" inside "breathable", and a sentence of common
       * words quietly accumulated a score against products that had nothing
       * to do with it. Phrases are still matched as substrings, because a
       * phrase is specific enough that its boundaries rarely mislead.
       */
      const hasWord = (haystack: string, needle: string) =>
        new RegExp(`(?:^|[^\p{L}\p{N}])${escapeRe(needle)}(?:[^\p{L}\p{N}]|$)`, "u").test(
          haystack,
        );

      let score = 0;

      // The product type named outright. Strongest signal there is: someone
      // who says "kettle" wants a kettle, whatever else the sentence holds.
      for (const n of phrases) {
        if (kind.includes(n)) score += 30;
      }
      for (const w of scoreWords) {
        if (hasWord(kind, w)) score += 14;
      }

      // What the buyer actually said, as a phrase.
      for (const n of phrases) {
        if (solves.includes(n)) score += 24;
        else if (text.includes(n)) score += 6;
      }

      // Terms we inferred on their behalf.
      for (const n of expanded) {
        if (solves.includes(n)) score += 5;
        else if (text.includes(n)) score += 2;
      }

      // Single words the buyer actually used.
      for (const w of scoreWords) {
        if (hasWord(solves, w)) score += 3;
        else if (hasWord(text, w)) score += 1;
      }
      return { p, score };
    })
    .sort((a, b) => b.score - a.score || (b.p.ratingCount ?? 0) - (a.p.ratingCount ?? 0));

  return scored.slice(0, limit).map((x) => ({ ...x.p, relevance: x.score }));
}

/**
 * Need synonyms.
 *
 * Each key is a phrase a buyer plausibly uses; the values are terms that
 * appear in the catalogue's own vocabulary. Deliberately a table and not a
 * model call: the sweep runs on every search, it has to work with no API key,
 * and a wrong expansion here costs nothing because the solver still rejects
 * anything failing a stated constraint. This only widens what is *considered*.
 */
const NEED_SYNONYMS: Record<string, string[]> = {
  "back pain": ["orthopaedic", "memory foam", "support", "cervical", "posture", "pillow"],
  "neck pain": ["orthopaedic", "cervical", "memory foam", "pillow", "support"],
  "body pain": ["orthopaedic", "memory foam", "support"],
  "shoulder pain": ["orthopaedic", "memory foam", "pillow"],
  "hair fall": ["hair", "shampoo", "bhringraj", "onion", "scalp"],
  // The way people actually write it. "hair fall" was a key and
  // "hair falling" was not, so "my hair is falling a lot" expanded to
  // nothing and the shampoo lost the signal that positions it.
  "hair falling": ["hair", "shampoo", "bhringraj", "onion", "scalp"],
  "falling hair": ["hair", "shampoo", "bhringraj", "onion", "scalp"],
  "losing hair": ["hair", "shampoo", "bhringraj", "onion", "scalp"],
  "hair loss": ["hair", "shampoo", "bhringraj", "onion"],
  dandruff: ["shampoo", "scalp", "hair"],
  "dull skin": ["face oil", "glow", "skincare", "serum", "brightening"],
  pimples: ["face oil", "skincare", "serum"],
  "dark spots": ["pigmentation", "face oil", "serum", "brightening"],
  "cook rice": ["cooker", "pressure cooker", "rice"],
  "cook dal": ["cooker", "pressure cooker"],
  cooking: ["cooker", "mixer", "grinder", "kitchen"],
  "grind masala": ["mixer", "grinder", "chutney"],
  "make batter": ["mixer", "grinder", "wet grinding"],
  "listen to music": ["earbuds", "earphone", "headphone", "speaker", "bluetooth"],
  music: ["earbuds", "speaker", "bluetooth", "audio"],
  "block noise": ["anc", "noise cancelling", "earbuds", "headphones"],
  "noisy office": ["anc", "noise cancelling", "earbuds"],
  calls: ["earbuds", "headphone", "bluetooth"],
  running: ["running", "shoes", "sports", "earbuds"],
  jogging: ["running", "shoes", "sports"],
  walking: ["shoes", "sneaker", "walking"],
  gym: ["shoes", "earbuds", "fitness", "smartwatch"],
  exercise: ["shoes", "fitness", "smartwatch"],
  "track steps": ["smartwatch", "fitness", "tracker"],
  "heart rate": ["smartwatch", "spo2", "fitness"],
  "phone dies": ["power bank", "charger", "battery"],
  "battery backup": ["power bank", "battery", "charger"],
  "power cut": ["power bank", "battery"],
  travel: ["power bank", "bottle", "boots"],
  hiking: ["boots", "hiking", "waterproof"],
  rain: ["waterproof", "boots"],
  monsoon: ["waterproof", "boots"],
  "watch movies": ["tv", "television", "smart tv"],
  "watch cricket": ["tv", "television"],
  "carry water": ["bottle", "flask", "thermos"],
  "hot water": ["bottle", "flask", "thermos", "insulated"],
  // "carry hot tea to the office" is a flask, and without these it matched
  // "hot weather" below and returned a cotton kurta.
  "hot tea": ["bottle", "flask", "thermos", "insulated"],
  "carry tea": ["bottle", "flask", "thermos", "insulated"],
  "carry hot": ["bottle", "flask", "thermos", "insulated"],
  "keep hot": ["bottle", "flask", "thermos", "insulated"],
  "boil water": ["kettle", "electric kettle"],
  "make tea": ["kettle", "electric kettle"],
  "iron clothes": ["iron", "dry iron"],
  "carry laptop": ["backpack", "laptop bag", "bag"],
  "carry books": ["backpack", "bag", "school bag"],
  trekking: ["boots", "hiking", "waterproof"],
  wedding: ["saree", "silk", "ethnic", "kurta"],
  festival: ["saree", "kurta", "ethnic", "chappal"],
  gift: ["saree", "pillow", "smartwatch", "face oil", "bedsheet"],
  "gift for mother": ["saree", "pillow", "face oil", "bedsheet"],
  "gift for father": ["pillow", "smartwatch", "bottle"],
  "gift for parents": ["pillow", "bedsheet", "smartwatch"],
  "new home": ["bedsheet", "pillow", "cooker", "mixer"],
  housewarming: ["bedsheet", "cooker", "mixer"],
  "summer wear": ["cotton", "kurta", "breathable"],
  "hot weather": ["cotton", "kurta", "breathable"],
  "office wear": ["kurta", "jeans", "shirt"],
  college: ["sneaker", "jeans", "canvas"],
  "sleeping problem": ["pillow", "memory foam", "bedsheet"],
  elderly: ["pillow", "orthopaedic", "support"],
  "old parents": ["pillow", "orthopaedic"],
  mother: ["saree", "pillow", "face oil", "cooker"],
  father: ["pillow", "smartwatch", "bottle"],
  family: ["cooker", "tv", "bedsheet"],
  bachelor: ["cooker", "small", "lightweight"],
  hostel: ["cooker", "small", "lightweight", "bottle"],
};

/** Words that carry no product meaning and only widen the sweep pointlessly. */
const SWEEP_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "his", "her", "who", "has",
  "have", "are", "was", "need", "want", "something", "anything", "some",
  "any", "good", "best", "nice", "very", "much", "more", "please", "would",
  "like", "looking", "find", "get", "buy", "show", "give", "can", "could",
  "there", "their", "them", "what", "which", "while", "from", "into", "out",
  "about", "also", "just", "only", "too", "but", "not", "you", "your", "our",
  "mine", "will", "shall", "may", "might", "one", "two",
]);

/**
 * Adjacent word groups from a sentence, which is how needs are actually
 * phrased: "back pain", "cook rice", "gift for mother".
 */
function ngrams(text: string): string[] {
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const pair = `${words[i]} ${words[i + 1]}`;
    if (pair.length >= 6) out.push(pair);
  }
  for (let i = 0; i < words.length - 2; i++) {
    out.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return [...new Set(out)].slice(0, 14);
}

/**
 * Keys broad enough to match half the catalogue.
 *
 * "gift" and "mother" are real signals when they are all the buyer gave us,
 * and pure noise the moment they also said "back pain" - at which point
 * expanding them drags in a saree and a face oil and buries the thing they
 * actually need. So they apply only when nothing more specific matched.
 */
const GENERIC_NEEDS = new Set([
  "gift", "mother", "father", "family", "travel", "cooking", "music",
  "college", "festival", "wedding", "elderly", "exercise", "gym", "calls",
]);

/** Catalogue terms implied by the needs named in a sentence. */
function expandNeeds(text: string): string[] {
  const specific = new Set<string>();
  const generic = new Set<string>();

  for (const [need, terms] of Object.entries(NEED_SYNONYMS)) {
    if (!text.includes(need)) continue;
    const bucket = GENERIC_NEEDS.has(need) ? generic : specific;
    for (const t of terms) bucket.add(t);
  }

  // A specific need wins outright; the generic keys are the fallback for a
  // sentence that gave us nothing sharper to go on.
  const chosen = specific.size > 0 ? specific : generic;
  return [...chosen].slice(0, 16);
}

export { NEED_SYNONYMS, expandNeeds, ngrams };
