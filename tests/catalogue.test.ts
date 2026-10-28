/**
 * Catalogue integrity.
 *
 * A catalogue is referential data: a product pointing at a seller that does
 * not exist, or a policy with no product using it, fails at the moment a
 * buyer files a claim rather than at seed time. These assertions are cheap and
 * they catch the whole class.
 *
 * The counts are asserted as floors, not exact values, so adding a product
 * does not break the suite — but dropping below the documented size does.
 */
import { describe, it, expect } from "vitest";
import { PRODUCTS, OFFERS, SELLERS, POLICIES } from "@/lib/seed-data";

const SELLER_IDS = new Set(SELLERS.map((s) => s.sellerId));
const POLICY_IDS = new Set(POLICIES.map((p) => p.policyId));
const SKUS = new Set(PRODUCTS.map((p) => p.sku));

describe("the catalogue is big enough to be convincing", () => {
  it("carries at least 50 distinct products", () => {
    expect(PRODUCTS.length).toBeGreaterThanOrEqual(50);
  });

  it("spreads them across at least 10 categories", () => {
    const cats = new Set(PRODUCTS.map((p) => p.category));
    expect(cats.size).toBeGreaterThanOrEqual(10);
  });

  it("gives every category enough products to feel populated", () => {
    const byCat = new Map<string, number>();
    for (const p of PRODUCTS) byCat.set(p.category, (byCat.get(p.category) ?? 0) + 1);
    // A category with one product is a category that looks broken when a
    // buyer opens it, which is the failure this guards.
    for (const [cat, n] of byCat) {
      expect(n, `category "${cat}" has only ${n} product(s)`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("every reference resolves", () => {
  it("points every product at a seller that exists", () => {
    const bad = PRODUCTS.filter((p) => !SELLER_IDS.has(p.sellerId)).map((p) => p.sku);
    expect(bad).toEqual([]);
  });

  it("points every product at a policy that exists", () => {
    // Without this a claim on that product reaches the entitlement engine with
    // no clauses, scores below the confidence floor and routes to a human —
    // which looks like caution and is actually missing data.
    const bad = PRODUCTS.filter((p) => !POLICY_IDS.has(p.policyId)).map((p) => p.sku);
    expect(bad).toEqual([]);
  });

  it("points every competing offer at a real SKU and a real seller", () => {
    expect(OFFERS.filter((o) => !SKUS.has(o.sku)).map((o) => o.sku)).toEqual([]);
    expect(OFFERS.filter((o) => !SELLER_IDS.has(o.sellerId)).map((o) => o.sellerId)).toEqual([]);
  });

  it("has no duplicate SKUs", () => {
    // A duplicate silently overwrites on seed, so the catalogue would be
    // smaller than it reads and one product's price would be another's.
    const dup = PRODUCTS.map((p) => p.sku).filter((x, i, a) => a.indexOf(x) !== i);
    expect(dup).toEqual([]);
  });

  it("leaves no policy unused", () => {
    const unused = POLICIES.filter((pl) => !PRODUCTS.some((p) => p.policyId === pl.policyId));
    expect(unused.map((p) => p.policyId)).toEqual([]);
  });

  it("gives every policy the clause tags the entitlement engine looks for", () => {
    // The engine matches clauses by tag. A policy missing the tag for an issue
    // type returns an ungrounded verdict for that issue.
    for (const pol of POLICIES) {
      const tags = new Set(pol.clauses.flatMap((c) => c.tags));
      for (const needed of ["window", "doa", "damaged", "wrong_item", "missing_part", "not_delivered"]) {
        expect(tags.has(needed), `${pol.policyId} has no "${needed}" clause`).toBe(true);
      }
    }
  });
});

describe("each product record is complete", () => {
  it("has a title, description, brand, price and stock", () => {
    for (const p of PRODUCTS) {
      expect(p.title.length, p.sku).toBeGreaterThan(3);
      expect(p.description.length, p.sku).toBeGreaterThan(20);
      expect(p.brand.length, p.sku).toBeGreaterThan(1);
      expect(p.priceInr, p.sku).toBeGreaterThan(0);
      expect(p.stock, p.sku).toBeGreaterThanOrEqual(0);
    }
  });

  it("never prices a product above its own MRP", () => {
    // A "discount" that is really a markup is the one pricing claim a buyer
    // can check at a glance, so it must hold in the seed data too.
    for (const p of PRODUCTS) {
      expect(p.priceInr, `${p.sku} costs more than its MRP`).toBeLessThanOrEqual(p.mrpInr);
    }
  });

  it("gives every product a subcategory and a non-empty tag list", () => {
    for (const p of PRODUCTS) {
      expect(p.subcategory.length, p.sku).toBeGreaterThan(0);
      expect(p.tags.length, p.sku).toBeGreaterThan(2);
    }
  });

  it("gives every product need-based `solves` metadata", () => {
    // This is what makes a buyer who describes a need findable at all, so a
    // product without it is invisible to the feature that matters most.
    for (const p of PRODUCTS) {
      expect(p.solves.length, `${p.sku} answers no stated need`).toBeGreaterThan(2);
    }
  });

  it("gives every product at least one box-content line", () => {
    // MISSING_PART claims are adjudicated against this list.
    for (const p of PRODUCTS) {
      expect(p.boxContents.length, p.sku).toBeGreaterThan(0);
    }
  });

  it("carries category-appropriate attributes rather than filler", () => {
    for (const p of PRODUCTS) {
      const keys = Object.keys(p.attributes ?? {});
      expect(keys.length, `${p.sku} has no attributes for the solver to match`).toBeGreaterThan(1);
    }
  });

  it("never claims a need with a generic opener a buyer uses for anything", () => {
    // A `solves` phrase is matched as a SUBSTRING at the heaviest weight in
    // the scorer (+24). So a phrase beginning "something to" matched the
    // n-gram "something to" out of "I need something to carry hot tea to the
    // office", and a history book outranked a vacuum flask. The phrase has to
    // describe the need, not echo how a sentence happens to open.
    const openers = ["something to", "anything to", "i need", "i want", "looking for", "my hair", "my phone"];
    const bad: string[] = [];
    for (const p of PRODUCTS) {
      for (const need of p.solves) {
        for (const o of openers) {
          if (need.toLowerCase().includes(o)) bad.push(`${p.sku}: "${need}" contains "${o}"`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("does not let one category claim another category's product need", () => {
    // Overlap within a category is correct and expected: two pressure cookers
    // should both answer "cook rice", and a saree and a pillow can both be a
    // "gift for mother". What breaks ranking is a phrase naming a product
    // TYPE that belongs to a different category — "need footwear" on a
    // raincoat, or "carry hot tea" on a book.
    const typeWords: Record<string, string[]> = {
      footwear: ["shoe", "footwear", "sandal", "boot", "chappal"],
      books: ["book", "notebook", "pen", "read"],
      kitchen: ["cooker", "kadai", "knife", "fryer", "kettle"],
      computers: ["keyboard", "mouse", "monitor", "laptop stand", "webcam"],
    };
    const bad: string[] = [];
    for (const p of PRODUCTS) {
      for (const [cat, words] of Object.entries(typeWords)) {
        if (p.category === cat) continue;
        for (const need of p.solves) {
          for (const w of words) {
            if (new RegExp(`(^|\s)${w}(\s|$)`).test(need.toLowerCase())) {
              bad.push(`${p.sku} (${p.category}) claims "${need}" — a ${cat} need`);
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("competing offers give the comparison something to compare", () => {
  it("lists several SKUs with more than one seller", () => {
    const bySku = new Map<string, number>();
    for (const o of OFFERS) bySku.set(o.sku, (bySku.get(o.sku) ?? 0) + 1);
    const contested = [...bySku.values()].filter((n) => n > 1).length;
    expect(contested).toBeGreaterThanOrEqual(10);
  });

  it("spreads sellers across the reliability range", () => {
    // `trueCost` prices in a seller's defect rate. If every seller were
    // equally reliable the comparison would have nothing to explain.
    const rates = SELLERS.map((s) => s.defectRatePct);
    expect(Math.max(...rates) - Math.min(...rates)).toBeGreaterThanOrEqual(10);
  });

  it("never offers negative stock or a free product", () => {
    for (const o of OFFERS) {
      expect(o.priceInr, o.sku).toBeGreaterThan(0);
      expect(o.stock, o.sku).toBeGreaterThanOrEqual(0);
    }
  });
});
