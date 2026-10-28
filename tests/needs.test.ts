/**
 * Need-based matching.
 *
 * The constraint solver was only half the problem. A buyer who says "something
 * for my mother's back pain" names no budget, no spec and no product — and the
 * literal keyword sweep returned nothing for it, even though the orthopaedic
 * pillow was in the catalogue the whole time. That sends the buyer straight
 * back to guessing product names, which is the behaviour this whole feature
 * exists to remove.
 *
 * These tests pin the three things that fix it, because each one broke at
 * least once while being built:
 *
 *  - needs are matched against the buyer's ORIGINAL sentence, not the stripped
 *    keyword query ("listen TO music" survives stripping as "listen music",
 *    which no longer matches the seeded phrase),
 *  - a phrase hit against a product's declared `solves` outweighs a synonym
 *    guess, which outweighs a single word,
 *  - relevance is tiered RELATIVE to the best match, not against a fixed
 *    score, because what counts as a high score depends on sentence length.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { seed } from "@/lib/seed";
import { findOffers } from "@/lib/finder";
import { expandNeeds, ngrams } from "@/lib/finder";
import { relevanceStep } from "@/lib/engines/constraints";

const NOW = new Date("2026-10-18T12:00:00Z");
const BUYER = { pinTier: 1, priorRto: 0, paymentMode: "PREPAID" as const };

beforeAll(async () => {
  await connectDb();
  await seed({ force: true });
}, 180_000);

afterAll(async () => {
  await disconnectDb();
});

/** Rank the catalogue for a stated need, with no hard constraints. */
async function forNeed(sentence: string, query: string) {
  return findOffers({ constraints: [], buyer: BUYER, query, sentence, now: NOW });
}

describe("a described need finds the right product", () => {
  // Each case is a need a real buyer would state, and the product that answers
  // it. None of these name the product, which is the point.
  const cases: { sentence: string; query: string; expect: RegExp }[] = [
    {
      sentence: "I need a gift for my mother who has back pain",
      query: "gift mother",
      expect: /memory foam pillow/i,
    },
    {
      sentence: "want to listen to music while running",
      query: "listen music running",
      expect: /earbuds/i,
    },
    {
      sentence: "something to cook rice for my family quickly",
      query: "cook rice family",
      expect: /pressure cooker/i,
    },
    { sentence: "my hair is falling a lot", query: "hair falling", expect: /shampoo/i },
    {
      sentence: "my phone dies on long train journeys",
      query: "phone train journey",
      expect: /power bank/i,
    },
    {
      sentence: "I want to watch cricket on a big screen",
      query: "watch cricket big screen",
      expect: /led tv/i,
    },
    {
      sentence: "I need something to carry hot tea to the office",
      query: "carry hot tea office",
      expect: /bottle/i,
    },
    {
      sentence: "going trekking in the monsoon, need footwear",
      query: "trekking monsoon footwear",
      expect: /hiking boots/i,
    },
  ];

  for (const c of cases) {
    it(`"${c.sentence}" → ${c.expect.source}`, async () => {
      const r = await forNeed(c.sentence, c.query);
      expect(r.satisfied.length).toBeGreaterThan(0);
      expect(r.satisfied[0].candidate.title).toMatch(c.expect);
    }, 90_000);
  }
});

describe("relevance outranks price when a need is described", () => {
  it("puts the pillow above a cheaper face oil for back pain", async () => {
    // The regression this was written for: the face oil is ₹57 cheaper and was
    // being recommended, because a fixed relevance cutoff tied the two and
    // price broke the tie. The buyer asked about back pain.
    const r = await forNeed("I need a gift for my mother who has back pain", "gift mother");
    const top = r.satisfied[0];
    expect(top.candidate.title).toMatch(/pillow/i);

    const faceOil = r.satisfied.find((o) => /face oil/i.test(o.candidate.title));
    expect(faceOil).toBeTruthy();
    // Confirms the ordering really is relevance-over-price, not luck.
    expect(faceOil!.cost.expectedTotalInr).toBeLessThan(top.cost.expectedTotalInr);
    expect(top.candidate.relevance!).toBeGreaterThan(faceOil!.candidate.relevance!);
  }, 90_000);

  it("says in words that relevance drove the recommendation", async () => {
    const r = await forNeed("my hair is falling a lot", "hair falling");
    expect(r.satisfied[0].rankReason).toMatch(/best match for what you described/i);
  }, 90_000);

  it("ranks the matching product first even when a cheaper one qualifies", async () => {
    // "pressure cooker" is itself a need signal, so a cooker must outrank a
    // cheaper water bottle that merely shares the kitchen category. Ranking on
    // cost alone here is exactly the failure mode — the buyer said cooker.
    const r = await findOffers({
      constraints: [{ kind: "category", value: "kitchen" }],
      buyer: BUYER,
      query: "pressure cooker",
      sentence: "pressure cooker",
      now: NOW,
    });
    expect(r.satisfied[0].candidate.title).toMatch(/pressure cooker/i);

    const bottle = r.satisfied.find((o) => /bottle/i.test(o.candidate.title));
    expect(bottle).toBeTruthy();
    expect(bottle!.cost.expectedTotalInr).toBeLessThan(r.satisfied[0].cost.expectedTotalInr);
  }, 90_000);

  it("falls back to pure cost ranking when nothing signals a need", async () => {
    // No query and no sentence: the only input is a category, so every
    // candidate is equally on-target and the cheapest all-in offer must lead.
    const r = await findOffers({
      constraints: [{ kind: "category", value: "kitchen" }],
      buyer: BUYER,
      query: "",
      sentence: "",
      now: NOW,
    });
    const costs = r.satisfied.map((o) => o.cost.expectedTotalInr);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
  }, 90_000);

  it("lets cost decide between two comparably relevant offers", async () => {
    // Same SKU from several sellers: identical relevance, so the cheapest
    // all-in offer must come first.
    const r = await forNeed("something to cook rice for my family", "cook rice family");
    const same = r.satisfied.filter((o) => o.candidate.sku === r.satisfied[0].candidate.sku);
    if (same.length > 1) {
      const costs = same.map((o) => o.cost.expectedTotalInr);
      expect(costs).toEqual([...costs].sort((a, b) => a - b));
    }
  }, 90_000);
});

describe("needs combine with hard constraints", () => {
  it("honours a budget while still ranking by need", async () => {
    const r = await findOffers({
      constraints: [{ kind: "max_price", value: 1000 }],
      buyer: BUYER,
      query: "gift mother",
      sentence: "a gift for my mother who has back pain under 1000",
      now: NOW,
    });
    // The pillow is ₹899, so it survives the budget and should still lead.
    expect(r.satisfied[0].candidate.title).toMatch(/pillow/i);
    for (const o of r.satisfied) expect(o.candidate.priceInr).toBeLessThanOrEqual(1000);
  }, 90_000);

  it("still explains every rejection when a need is described", async () => {
    const r = await findOffers({
      constraints: [{ kind: "max_price", value: 500 }],
      buyer: BUYER,
      query: "gift mother",
      sentence: "a gift for my mother who has back pain",
      now: NOW,
    });
    for (const rej of r.rejected) {
      expect(rej.primary.constraint.length).toBeGreaterThan(0);
      expect(rej.primary.actual.length).toBeGreaterThan(0);
    }
  }, 90_000);
});

describe("the need vocabulary itself", () => {
  it("expands a specific need into catalogue terms", () => {
    const terms = expandNeeds("my mother has back pain");
    expect(terms).toContain("orthopaedic");
    expect(terms).toContain("pillow");
  });

  it("suppresses the generic keys once a specific need is present", () => {
    // "gift" and "mother" would drag in a saree and a face oil. With "back
    // pain" also present, the specific need must win outright — this was the
    // bug that buried the pillow.
    const withSpecific = expandNeeds("a gift for my mother who has back pain");
    expect(withSpecific).toContain("orthopaedic");
    expect(withSpecific).not.toContain("saree");

    // With nothing sharper to go on, the generic keys are still useful.
    const genericOnly = expandNeeds("a gift for my mother");
    expect(genericOnly.length).toBeGreaterThan(0);
  });

  it("reads multi-word needs as phrases, not loose words", () => {
    const phrases = ngrams("my mother has back pain");
    expect(phrases).toContain("back pain");
  });

  it("buckets relevance coarsely, so small gaps leave cost in charge", () => {
    // A difference has to be worth about a whole matched phrase (24) before it
    // overrides price.
    expect(relevanceStep(78)).toBeGreaterThan(relevanceStep(27));
    expect(relevanceStep(26)).toBe(relevanceStep(30));
  });

  it("invents nothing from a sentence with no product meaning", async () => {
    const r = await forNeed("hello there", "");
    expect(r.satisfied.length).toBe(0);
  }, 90_000);
});

/* ────────── Scoring bugs that cost the buyer the right product ────────── */

describe("the scorer does not reward coincidence", () => {
  it("does not let a repeated filler word accumulate score", async () => {
    // "carry hot tea to the office" repeats "to", and each copy scored again.
    // A cotton kurta whose stated uses were "hot weather" and "office casual"
    // reached 46 on filler alone and outranked a vacuum flask at 24.
    const r = await forNeed("I need something to carry hot tea to the office", "carry hot tea office");
    expect(r.satisfied[0].candidate.title).toMatch(/bottle/i);
  }, 90_000);

  it("does not match a short word inside a longer one", async () => {
    // "to" matched inside "cotton" and "the" inside "breathable". Whole-word
    // matching is what stops a sentence of common words scoring at all.
    const r = await forNeed("I want a kettle to boil water", "kettle boil water");
    expect(r.satisfied[0].candidate.title).toMatch(/kettle/i);
  }, 90_000);

  it("ranks the product type the buyer named above a cheaper neighbour", async () => {
    // The hiking boots cost ₹3,305 against a ₹1,910 winter jacket, and the
    // jacket won because a coarse relevance step flattened 49 against 41.
    const r = await forNeed("going trekking in the monsoon, need footwear", "trekking monsoon footwear");
    expect(r.satisfied[0].candidate.title).toMatch(/hiking boots/i);
  }, 90_000);

  it("finds the ten products a buyer asks for by their plain name", async () => {
    // Each of these returned either nothing or something unrelated before the
    // catalogue was filled: a laptop search answered with a Bluetooth speaker.
    const wanted: [string, RegExp][] = [
      ["laptop", /laptop/i],
      ["mobile phone", /mobile phone/i],
      ["headphones", /headphones/i],
      ["rice cooker", /rice cooker/i],
      ["electric kettle", /kettle/i],
      ["winter jacket", /jacket/i],
      ["backpack", /backpack/i],
      ["iron", /iron/i],
      ["bath towel", /towel/i],
      ["socks", /socks/i],
    ];
    for (const [query, expected] of wanted) {
      const r = await forNeed(query, query);
      expect(r.satisfied.length, `nothing found for "${query}"`).toBeGreaterThan(0);
      expect(r.satisfied[0].candidate.title, `wrong leader for "${query}"`).toMatch(expected);
    }
  }, 180_000);
});
