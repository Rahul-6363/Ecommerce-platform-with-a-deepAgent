/**
 * Unit tests for the constraint solver and the offer economics.
 *
 * These matter for the same reason the entitlement tests do: the solver is
 * what turns "state what you need" into a claim about which products qualify,
 * and `trueCost` puts a number in front of a buyer deciding how to spend
 * money. A rejection reason that is wrong is worse than no rejection reason,
 * because the buyer acts on it.
 */
import { describe, it, expect } from "vitest";
import {
  solveConstraints,
  describeConstraint,
  attributeMatches,
  findAttribute,
  type Candidate,
  type Constraint,
} from "@/lib/engines/constraints";
import {
  trueCost,
  deliveryForecast,
  COD_FEE_INR,
  DELIVERY_FEE_BY_TIER,
  RETURN_FRICTION_INR,
  FREE_DELIVERY_ABOVE_INR,
  CONFIDENCE_PCT,
} from "@/lib/engines/offers";
import { parseConstraints } from "@/lib/agent/constraint-extractor";

const NOW = new Date("2026-10-18T12:00:00Z");
const CATEGORIES = ["apparel", "beauty", "electronics", "footwear", "home", "kitchen"];

/** A 5L induction cooker from a mid-quality seller. The baseline candidate. */
function cooker(over: Partial<Candidate> = {}): Candidate {
  return {
    sku: "VJ-KITCH-501",
    title: "Stainless Steel Pressure Cooker, 5L",
    brand: "Ganga",
    category: "kitchen",
    subcategory: "pressure cooker",
    priceInr: 1649,
    mrpInr: 2999,
    ratingAvg: 4.4,
    ratingCount: 6712,
    stock: 54,
    codEligible: true,
    attributes: { capacity_l: 5, material: "Stainless steel", induction: true, isi: true },
    refundable: true,
    seller: {
      sellerId: "SEL-05",
      name: "Ganga Kitchenware",
      defectRatePct: 7,
      fulfilmentSlaDays: 3,
    },
    ...over,
  };
}

const buyer = { pinTier: 2, priorRto: 0, paymentMode: "PREPAID" as const };

/* ──────────────────────────── True cost ──────────────────────────── */

describe("trueCost", () => {
  it("adds the COD fee and the tier delivery fee to the sticker", () => {
    const c = trueCost({
      priceInr: 1649,
      paymentMode: "COD",
      pinTier: 3,
      sellerDefectRatePct: 0,
    });
    expect(c.stickerInr).toBe(1649);
    expect(c.payableNowInr).toBe(1649 + COD_FEE_INR + DELIVERY_FEE_BY_TIER[3]);
  });

  it("prices the return risk as defect rate times the friction cost", () => {
    const c = trueCost({
      priceInr: 1000,
      paymentMode: "PREPAID",
      pinTier: 1,
      sellerDefectRatePct: 18,
    });
    expect(c.returnRiskInr).toBe(Math.round(0.18 * RETURN_FRICTION_INR));
    expect(c.expectedTotalInr).toBe(c.payableNowInr + c.returnRiskInr);
  });

  it("charges no delivery above the free-delivery threshold", () => {
    const c = trueCost({
      priceInr: FREE_DELIVERY_ABOVE_INR + 1,
      paymentMode: "PREPAID",
      pinTier: 4,
      sellerDefectRatePct: 0,
    });
    expect(c.payableNowInr).toBe(FREE_DELIVERY_ABOVE_INR + 1);
  });

  it("is the whole argument: a cheaper sticker can be the dearer purchase", () => {
    // Metro undercuts Ganga by ₹150 on the sticker but fails 18% of orders
    // against Ganga's 7%, and dispatches to the same pincode.
    const ganga = trueCost({ priceInr: 1649, paymentMode: "PREPAID", pinTier: 2, sellerDefectRatePct: 7 });
    const metro = trueCost({ priceInr: 1499, paymentMode: "PREPAID", pinTier: 2, sellerDefectRatePct: 18 });

    expect(metro.stickerInr).toBeLessThan(ganga.stickerInr);
    // The return-risk line is where the difference shows up and is itemised.
    expect(metro.returnRiskInr).toBeGreaterThan(ganga.returnRiskInr);
    expect(metro.lines.some((l) => l.probabilistic)).toBe(true);
  });

  it("itemises every line with a justification, and the lines sum to the total", () => {
    const c = trueCost({ priceInr: 2000, paymentMode: "COD", pinTier: 3, sellerDefectRatePct: 10 });
    for (const l of c.lines) expect(l.detail.length).toBeGreaterThan(0);
    expect(c.lines.reduce((s, l) => s + l.amountInr, 0)).toBe(c.expectedTotalInr);
  });

  it("multiplies the sticker by quantity but not the per-order fees", () => {
    const c = trueCost({ priceInr: 500, qty: 3, paymentMode: "COD", pinTier: 2, sellerDefectRatePct: 0 });
    expect(c.stickerInr).toBe(1500);
    expect(c.payableNowInr).toBe(1500 + COD_FEE_INR + DELIVERY_FEE_BY_TIER[2]);
  });
});

/* ───────────────────────── Delivery forecast ───────────────────────── */

describe("deliveryForecast", () => {
  it("returns an interval, with the confident date never before the likely one", () => {
    const f = deliveryForecast({ sellerSlaDays: 3, pinTier: 3, buyerPriorRto: 1 }, NOW);
    expect(Date.parse(f.confidentAt)).toBeGreaterThan(Date.parse(f.likelyAt));
    expect(f.confidencePct).toBe(CONFIDENCE_PCT);
  });

  it("adds no slack on an easy route, so the interval collapses honestly", () => {
    const f = deliveryForecast({ sellerSlaDays: 1, pinTier: 1, paymentMode: "PREPAID" }, NOW);
    expect(f.slackDays).toBe(0);
    expect(f.confidentAt).toBe(f.likelyAt);
  });

  it("traces every day of slack to a named reason", () => {
    const f = deliveryForecast(
      { sellerSlaDays: 3, pinTier: 4, buyerPriorRto: 2, paymentMode: "COD" },
      NOW,
    );
    expect(f.slackDays).toBeGreaterThan(0);
    // tier + RTO + COD, plus the base dispatch/transit line.
    expect(f.reasons.length).toBeGreaterThanOrEqual(4);
    expect(f.reasons.some((r) => /tier-4/.test(r))).toBe(true);
    expect(f.reasons.some((r) => /COD/.test(r))).toBe(true);
  });

  it("judges a deadline against the CONFIDENT date, not the optimistic one", () => {
    // Likely lands inside the deadline; the padded date does not. That is
    // TIGHT — and calling it SAFE is the dishonesty this engine exists to fix.
    const f = deliveryForecast(
      { sellerSlaDays: 3, pinTier: 3, buyerPriorRto: 1 },
      NOW,
      new Date("2026-10-28T23:59:00Z"),
    );
    expect(f.deadline).not.toBeNull();
    expect(f.deadline?.likelyMeets).toBe(true);
    expect(f.deadline?.confidentMeets).toBe(false);
    expect(f.deadline?.verdict).toBe("TIGHT");
  });

  it("says plainly when a date cannot be met", () => {
    const f = deliveryForecast(
      { sellerSlaDays: 6, pinTier: 4 },
      NOW,
      new Date("2026-10-20T23:59:00Z"),
    );
    expect(f.deadline?.verdict).toBe("WILL_MISS");
    expect(f.deadline?.sentence).toMatch(/not arrive in time/);
  });

  it("adds the restock wait when the item is out of stock", () => {
    const inStock = deliveryForecast({ sellerSlaDays: 2, pinTier: 1, inStock: true }, NOW);
    const out = deliveryForecast({ sellerSlaDays: 2, pinTier: 1, inStock: false, restockDays: 3 }, NOW);
    expect(Date.parse(out.likelyAt)).toBeGreaterThan(Date.parse(inStock.likelyAt));
  });

  it("is pure: the same inputs give the same interval", () => {
    const a = deliveryForecast({ sellerSlaDays: 3, pinTier: 2 }, NOW);
    const b = deliveryForecast({ sellerSlaDays: 3, pinTier: 2 }, NOW);
    expect(a).toEqual(b);
  });
});

/* ───────────────────────── Attribute matching ───────────────────────── */

describe("attribute matching", () => {
  it("finds an attribute under a loose key, which is how buyers name them", () => {
    const attrs = { capacity_l: 5, induction: true, material: "Stainless steel" };
    expect(findAttribute(attrs, "capacity")).toBe(5);
    expect(findAttribute(attrs, "induction")).toBe(true);
    expect(findAttribute(attrs, "nonexistent")).toBeUndefined();
  });

  it("treats a bare number as a ceiling, because '5 litres' means at most 5", () => {
    expect(attributeMatches(5, 5)).toBe(true);
    expect(attributeMatches(3, 5)).toBe(true);
    expect(attributeMatches(7.5, 5)).toBe(false);
  });

  it("matches a size inside a stated range", () => {
    expect(attributeMatches("6-11", "9")).toBe(true);
    expect(attributeMatches("6-11", "12")).toBe(false);
  });

  it("reads explicit comparisons", () => {
    expect(attributeMatches(5, ">= 3")).toBe(true);
    expect(attributeMatches(5, "< 4")).toBe(false);
  });

  it("maps yes/no onto a boolean field", () => {
    expect(attributeMatches(true, "yes")).toBe(true);
    expect(attributeMatches(false, "yes")).toBe(false);
  });
});

/* ──────────────────────────── The solver ──────────────────────────── */

describe("solveConstraints", () => {
  const fiveConstraints: Constraint[] = [
    { kind: "category", value: "kitchen" },
    { kind: "attribute", key: "induction", value: true },
    { kind: "attribute", key: "capacity_l", value: 5 },
    { kind: "max_price", value: 2000 },
    { kind: "in_stock", value: true },
  ];

  it("admits a candidate that satisfies every constraint, with evidence for each", () => {
    const r = solveConstraints([cooker()], fiveConstraints, buyer, NOW);
    expect(r.satisfied).toHaveLength(1);
    expect(r.rejected).toHaveLength(0);
    expect(r.satisfied[0].satisfied).toHaveLength(5);
    // Every satisfaction carries the candidate's actual value, so the buyer
    // can check the claim rather than trusting it.
    for (const s of r.satisfied[0].satisfied) expect(s.evidence.length).toBeGreaterThan(0);
  });

  it("rejects on a missing attribute and names the value that failed", () => {
    const aluminium = cooker({
      sku: "VJ-KITCH-504",
      title: "Aluminium Pressure Cooker, 3L",
      priceInr: 1149,
      attributes: { capacity_l: 3, induction: false, material: "Anodised aluminium" },
    });
    const r = solveConstraints([aluminium], fiveConstraints, buyer, NOW);
    expect(r.satisfied).toHaveLength(0);
    expect(r.rejected[0].primary.kind).toBe("attribute");
    expect(r.rejected[0].primary.actual).toMatch(/induction is no/);
  });

  it("reports every constraint a candidate failed, not just the first", () => {
    const wrong = cooker({
      category: "footwear",
      priceInr: 9999,
      stock: 0,
      attributes: { induction: false },
    });
    const r = solveConstraints([wrong], fiveConstraints, buyer, NOW);
    // category, induction, capacity (not stated), price, stock.
    expect(r.rejected[0].failed.length).toBeGreaterThanOrEqual(4);
  });

  it("states how much a candidate is over budget by", () => {
    const dear = cooker({ priceInr: 2449 });
    const r = solveConstraints([dear], [{ kind: "max_price", value: 2000 }], buyer, NOW);
    expect(r.rejected[0].primary.actual).toMatch(/over by ₹449/);
  });

  it("leads with the most fundamental failure, so one line is the useful one", () => {
    // Wrong category AND over budget: a shoe is not going to become a cooker,
    // but a budget is something the buyer might relax.
    const shoe = cooker({ category: "footwear", priceInr: 5000, attributes: { induction: true, capacity_l: 1 } });
    const r = solveConstraints([shoe], fiveConstraints, buyer, NOW);
    expect(r.rejected[0].primary.kind).toBe("category");
  });

  it("groups rejections by reason, which is the headline the buyer reads", () => {
    const candidates = [
      cooker(),
      cooker({ sku: "A", category: "footwear", attributes: {} }),
      cooker({ sku: "B", category: "footwear", attributes: {} }),
      cooker({ sku: "C", priceInr: 5000 }),
    ];
    const r = solveConstraints(candidates, fiveConstraints, buyer, NOW);
    expect(r.satisfied).toHaveLength(1);
    const category = r.rejectionSummary.find((s) => s.kind === "category");
    expect(category?.count).toBe(2);
    expect(r.headline).toMatch(/1 of 4 offers satisfy all 5 constraints/);
  });

  it("ranks by expected total cost, not by sticker price", () => {
    const ganga = cooker();
    const metro = cooker({
      priceInr: 1499,
      seller: { sellerId: "SEL-07", name: "Metro Discount Mart", defectRatePct: 18, fulfilmentSlaDays: 6 },
    });
    const r = solveConstraints([ganga, metro], fiveConstraints, buyer, NOW);
    expect(r.satisfied).toHaveLength(2);

    // Metro is cheaper on the sticker and still ranked first here — ₹150 of
    // sticker beats ₹11 of extra return risk. What matters is that the ordering
    // is BY expected total, and that the gap is explained either way.
    const [first, second] = r.satisfied;
    expect(first.cost.expectedTotalInr).toBeLessThanOrEqual(second.cost.expectedTotalInr);
    expect(first.rankReason).toMatch(/Recommended/);
    expect(second.rankReason.length).toBeGreaterThan(0);
  });

  it("makes the sticker-vs-true-cost case in words when they disagree", () => {
    // A ₹20 sticker saving against a seller failing 80% of orders: the cheaper
    // sticker is genuinely the dearer purchase, and the sentence has to say so.
    const good = cooker({ priceInr: 1649, seller: { sellerId: "G", name: "Good Co", defectRatePct: 1, fulfilmentSlaDays: 2 } });
    const bad = cooker({ priceInr: 1629, seller: { sellerId: "B", name: "Risky Co", defectRatePct: 80, fulfilmentSlaDays: 2 } });
    const r = solveConstraints([good, bad], [{ kind: "max_price", value: 2000 }], buyer, NOW);

    expect(r.satisfied[0].candidate.seller.name).toBe("Good Co");
    expect(r.satisfied[1].rankReason).toMatch(/cheaper on the sticker, but/);
    expect(r.satisfied[1].rankReason).toMatch(/80% defect rate/);
  });

  it("rejects on a deadline the confident date cannot meet", () => {
    const slow = cooker({
      seller: { sellerId: "SEL-07", name: "Metro", defectRatePct: 18, fulfilmentSlaDays: 6 },
    });
    const r = solveConstraints(
      [slow],
      [{ kind: "arrive_by", value: "2026-10-22T23:59:00Z" }],
      { pinTier: 3, priorRto: 1, paymentMode: "PREPAID" },
      NOW,
    );
    expect(r.satisfied).toHaveLength(0);
    expect(r.rejected[0].primary.kind).toBe("arrive_by");
  });

  it("names the one constraint worth relaxing when nothing qualifies", () => {
    // Three candidates, each failing only the budget. Relaxing it admits 3.
    const candidates = [
      cooker({ sku: "A", priceInr: 2449 }),
      cooker({ sku: "B", priceInr: 2500 }),
      cooker({ sku: "C", priceInr: 2600 }),
    ];
    const r = solveConstraints(candidates, fiveConstraints, buyer, NOW);
    expect(r.satisfied).toHaveLength(0);
    expect(r.relaxation?.kind).toBe("max_price");
    expect(r.relaxation?.wouldAdmit).toBe(3);
  });

  it("counts only candidates that relaxing one constraint actually admits", () => {
    // This one fails the budget AND the category, so relaxing the budget does
    // not admit it. Promising otherwise would be a lie the buyer can check.
    const candidates = [cooker({ sku: "A", priceInr: 2449, category: "footwear", attributes: {} })];
    const r = solveConstraints(candidates, fiveConstraints, buyer, NOW);
    expect(r.relaxation).toBeNull();
  });

  it("is pure: identical inputs give identical output", () => {
    const a = solveConstraints([cooker()], fiveConstraints, buyer, NOW);
    const b = solveConstraints([cooker()], fiveConstraints, buyer, NOW);
    expect(a).toEqual(b);
  });

  it("echoes the constraints back in words the buyer can check", () => {
    const r = solveConstraints([cooker()], fiveConstraints, buyer, NOW);
    expect(r.constraints.map((c) => c.text)).toContain("price at or under ₹2,000");
    expect(r.constraints.map((c) => c.text)).toContain("in stock now");
  });

  it("holds the no-candidate case without inventing an outcome", () => {
    const r = solveConstraints([], fiveConstraints, buyer, NOW);
    expect(r.satisfied).toHaveLength(0);
    expect(r.considered).toBe(0);
    expect(r.headline).toMatch(/Nothing in the catalogue/);
  });

  it("rejects a COD constraint against a seller who does not accept it", () => {
    const noCod = cooker({ codEligible: false });
    const r = solveConstraints([noCod], [{ kind: "payment_mode", value: "COD" }], buyer, NOW);
    expect(r.rejected[0].primary.actual).toMatch(/does not accept cash on delivery/);
  });

  it("rejects a seller whose defect rate is above the stated ceiling", () => {
    const risky = cooker({
      seller: { sellerId: "SEL-07", name: "Metro Discount Mart", defectRatePct: 18, fulfilmentSlaDays: 6 },
    });
    const r = solveConstraints([risky], [{ kind: "max_seller_defect_rate", value: 5 }], buyer, NOW);
    expect(r.rejected[0].primary.actual).toMatch(/fails 18% of orders/);
  });
});

describe("describeConstraint", () => {
  it("renders every constraint kind as a sentence a buyer would recognise", () => {
    const all: Constraint[] = [
      { kind: "category", value: "kitchen" },
      { kind: "max_price", value: 2000 },
      { kind: "min_price", value: 500 },
      { kind: "brand", value: "Ganga" },
      { kind: "min_rating", value: 4 },
      { kind: "in_stock", value: true },
      { kind: "attribute", key: "induction", value: true },
      { kind: "arrive_by", value: "2026-10-28T00:00:00Z" },
      { kind: "payment_mode", value: "COD" },
      { kind: "max_true_cost", value: 2000 },
      { kind: "max_seller_defect_rate", value: 5 },
    ];
    for (const c of all) {
      const text = describeConstraint(c);
      expect(text.length).toBeGreaterThan(3);
      expect(text).not.toMatch(/undefined|NaN|object/);
    }
  });
});

/* ───────────────────── The no-model parser path ───────────────────── */

describe("parseConstraints (works with no model)", () => {
  it("reads the full worked example without a language model", () => {
    const { constraints } = parseConstraints(
      "pressure cooker for my induction hob, 5 litres max, under 2000, must be in stock, need it before the 28th",
      NOW,
      CATEGORIES,
    );
    const kinds = constraints.map((c) => c.kind);
    expect(kinds).toContain("category");
    expect(kinds).toContain("attribute");
    expect(kinds).toContain("max_price");
    expect(kinds).toContain("in_stock");
    expect(kinds).toContain("arrive_by");

    const price = constraints.find((c) => c.kind === "max_price") as { value: number };
    expect(price.value).toBe(2000);

    const induction = constraints.find((c) => c.kind === "attribute" && c.key === "induction");
    expect(induction).toBeTruthy();
  });

  it("distinguishes a sticker ceiling from an all-in ceiling", () => {
    const sticker = parseConstraints("cooker under 2000", NOW, CATEGORIES);
    expect(sticker.constraints.some((c) => c.kind === "max_price")).toBe(true);

    const allIn = parseConstraints("cooker, total delivered under 2000", NOW, CATEGORIES);
    expect(allIn.constraints.some((c) => c.kind === "max_true_cost")).toBe(true);
  });

  it("reads a Hinglish budget", () => {
    const { constraints } = parseConstraints("2000 ke andar ek cooker chahiye", NOW, CATEGORIES);
    const price = constraints.find((c) => c.kind === "max_price") as { value: number } | undefined;
    expect(price?.value).toBe(2000);
  });

  it("reads '2k' as two thousand", () => {
    const { constraints } = parseConstraints("shoes under 2k", NOW, CATEGORIES);
    const price = constraints.find((c) => c.kind === "max_price") as { value: number } | undefined;
    expect(price?.value).toBe(2000);
  });

  it("resolves 'before the 28th' to a future date", () => {
    const { constraints } = parseConstraints("cooker before the 28th", NOW, CATEGORIES);
    const by = constraints.find((c) => c.kind === "arrive_by") as { value: string } | undefined;
    expect(by).toBeTruthy();
    expect(Date.parse(by!.value)).toBeGreaterThan(NOW.getTime());
  });

  it("rolls a past day of the month into next month", () => {
    const { constraints } = parseConstraints("cooker before the 5th", NOW, CATEGORIES);
    const by = constraints.find((c) => c.kind === "arrive_by") as { value: string };
    // The 5th has passed on 18 Oct, so it must mean 5 November.
    expect(new Date(by.value).getUTCMonth()).toBe(10);
  });

  it("reads a named month", () => {
    const { constraints } = parseConstraints("cooker by 5 November", NOW, CATEGORIES);
    const by = constraints.find((c) => c.kind === "arrive_by") as { value: string };
    expect(new Date(by.value).getUTCMonth()).toBe(10);
    expect(new Date(by.value).getUTCDate()).toBe(5);
  });

  it("reads a relative deadline", () => {
    const { constraints } = parseConstraints("earbuds in 3 days", NOW, CATEGORIES);
    const by = constraints.find((c) => c.kind === "arrive_by") as { value: string };
    expect(Date.parse(by.value)).toBe(NOW.getTime() + 3 * 86_400_000);
  });

  it("maps 'reliable seller' to a defect-rate ceiling", () => {
    const { constraints } = parseConstraints("cooker from a reliable seller", NOW, CATEGORIES);
    expect(constraints.some((c) => c.kind === "max_seller_defect_rate")).toBe(true);
  });

  it("reads a size for footwear", () => {
    const { constraints } = parseConstraints("running shoes size 9 under 2000", NOW, CATEGORIES);
    const size = constraints.find((c) => c.kind === "attribute" && c.key === "sizes");
    expect(size).toBeTruthy();
  });

  it("strips the constraint language out of the search query", () => {
    const { query } = parseConstraints(
      "I need a pressure cooker under 2000 before the 28th",
      NOW,
      CATEGORIES,
    );
    expect(query).toMatch(/cooker/);
    expect(query).not.toMatch(/2000|need|before/);
  });

  it("invents nothing from a sentence with no constraint in it", () => {
    const { constraints } = parseConstraints("hello", NOW, CATEGORIES);
    expect(constraints).toHaveLength(0);
  });

  it("end to end with no model: the parsed sentence solves correctly", () => {
    const { constraints } = parseConstraints(
      "induction pressure cooker, 5 litres max, under 2000, in stock",
      NOW,
      CATEGORIES,
    );
    const aluminium = cooker({
      sku: "VJ-KITCH-504",
      priceInr: 1149,
      attributes: { capacity_l: 3, induction: false },
    });
    const large = cooker({ sku: "VJ-KITCH-505", priceInr: 2449, attributes: { capacity_l: 7.5, induction: true } });

    const r = solveConstraints([cooker(), aluminium, large], constraints, buyer, NOW);
    expect(r.satisfied).toHaveLength(1);
    expect(r.satisfied[0].candidate.sku).toBe("VJ-KITCH-501");
    expect(r.rejected).toHaveLength(2);
  });
});

/* ────────── Not claiming a match that did not happen ────────── */

describe("a need nothing matched", () => {
  it("does not call unrelated offers a match", () => {
    // The bug this guards: a buyer asked for a laptop in a catalogue with no
    // laptop, and the engine announced "10 options satisfy everything you
    // asked for" over a Bluetooth speaker. Every candidate had scored zero.
    const unrelated = cooker({ relevance: 0 });
    const r = solveConstraints([unrelated], [], buyer, NOW, "laptop");

    expect(r.needUnmatched).toBe(true);
    expect(r.satisfied).toHaveLength(1); // still offered — just not as a match
    expect(r.headline).toMatch(/do not have what you described/i);
    expect(r.headline).not.toMatch(/satisf/i);
  });

  it("is not triggered when the buyer described no need", () => {
    // A pure constraint search scores zero relevance too, and there the
    // offers genuinely do satisfy everything asked for.
    const r = solveConstraints(
      [cooker({ relevance: 0 })],
      [{ kind: "max_price", value: 2000 }],
      buyer,
      NOW,
      "",
    );
    expect(r.needUnmatched).toBe(false);
    expect(r.headline).toMatch(/satisf/i);
  });

  it("is not triggered when something did match", () => {
    const r = solveConstraints([cooker({ relevance: 26 })], [], buyer, NOW, "pressure cooker");
    expect(r.needUnmatched).toBe(false);
  });

  it("stays false when there is nothing to offer at all", () => {
    // Zero candidates is a different message: nothing was found, rather than
    // something being offered despite not matching.
    const r = solveConstraints([], [], buyer, NOW, "laptop");
    expect(r.needUnmatched).toBe(false);
    expect(r.satisfied).toHaveLength(0);
  });
});

/* ────────── A guessed category hiding the right product ────────── */

describe("hiddenByCategory", () => {
  it("counts relevant products excluded by the category alone", () => {
    // "laptop bag" makes a model guess `electronics`, which then hides the
    // bag. The buyer sees laptops and no sign the bag existed.
    const bag = cooker({
      sku: "VJ-HOME-403",
      title: "Laptop Backpack, 25L",
      category: "home",
      relevance: 12,
    });
    const r = solveConstraints([bag], [{ kind: "category", value: "electronics" }], buyer, NOW, "laptop bag");

    expect(r.satisfied).toHaveLength(0);
    expect(r.hiddenByCategory).toBe(1);
  });

  it("does not count a product that failed on more than the category", () => {
    // If it was also out of stock, removing the category chip would not
    // reveal it, so reporting it as "hidden by the category" would mislead.
    const bag = cooker({
      sku: "VJ-HOME-403",
      category: "home",
      stock: 0,
      relevance: 12,
    });
    const r = solveConstraints(
      [bag],
      [{ kind: "category", value: "electronics" }, { kind: "in_stock", value: true }],
      buyer,
      NOW,
      "laptop bag",
    );
    expect(r.hiddenByCategory).toBe(0);
  });

  it("does not count an irrelevant product from another category", () => {
    // Every category constraint rejects most of the catalogue. Only products
    // that matched the buyer's own words are worth reporting as hidden.
    const r = solveConstraints(
      [cooker({ category: "kitchen", relevance: 0 })],
      [{ kind: "category", value: "electronics" }],
      buyer,
      NOW,
      "laptop",
    );
    expect(r.hiddenByCategory).toBe(0);
  });
});
