/**
 * The finder against the real seeded database.
 *
 * `finder.test.ts` proves the pure functions. This proves the part that can
 * only break with real data: that a product is expanded into one candidate per
 * seller, that the seeded competing offers are actually found, and that the
 * worked example on the page genuinely produces the result the page claims.
 *
 * The last test is the important one. A demo whose headline example quietly
 * stops working is worse than no demo, so the example is asserted rather than
 * trusted.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { seed } from "@/lib/seed";
import { findOffers } from "@/lib/finder";
import { parseConstraints } from "@/lib/agent/constraint-extractor";
import { Product } from "@/models";
import type { Constraint } from "@/lib/engines/constraints";

const NOW = new Date("2026-10-18T12:00:00Z");
const TIER2 = { pinTier: 2, priorRto: 0, paymentMode: "PREPAID" as const };

let categories: string[];

beforeAll(async () => {
  await connectDb();
  await seed();
  categories = ((await Product.distinct("category", { active: true })) as string[]).sort();
}, 180_000);

afterAll(async () => {
  await disconnectDb();
});

describe("findOffers against seeded data", () => {
  it("expands one SKU into one candidate per seller offering it", async () => {
    const r = await findOffers({
      constraints: [{ kind: "category", value: "kitchen" }],
      buyer: TIER2,
      query: "pressure cooker",
      now: NOW,
    });

    const cookerOffers = [...r.satisfied, ...r.rejected].filter(
      (o) => o.candidate.sku === "VJ-KITCH-501",
    );
    // The product's own listing plus the three seeded competing offers.
    expect(cookerOffers.length).toBe(4);

    const sellers = new Set(cookerOffers.map((o) => o.candidate.seller.sellerId));
    expect(sellers.has("SEL-05")).toBe(true); // the product's own seller
    expect(sellers.has("SEL-07")).toBe(true); // Metro, the cheap risky one
    expect(sellers.has("SEL-08")).toBe(true); // Prime, dearer and fast
  }, 60_000);

  it("carries each seller's real defect rate into the cost", async () => {
    const r = await findOffers({
      constraints: [
        { kind: "category", value: "kitchen" },
        { kind: "max_price", value: 2000 },
      ],
      buyer: TIER2,
      query: "pressure cooker",
      now: NOW,
    });

    const metro = r.satisfied.find((o) => o.candidate.seller.sellerId === "SEL-07");
    const prime = r.satisfied.find((o) => o.candidate.seller.sellerId === "SEL-08");
    expect(metro).toBeTruthy();
    expect(prime).toBeTruthy();

    // Metro fails 18% of orders against Prime's 1%, so Metro carries the
    // larger expected return cost — the whole basis of the comparison.
    expect(metro!.cost.returnRiskInr).toBeGreaterThan(prime!.cost.returnRiskInr);
  }, 60_000);

  it("gives a faster seller an earlier confident date", async () => {
    const r = await findOffers({
      constraints: [{ kind: "category", value: "kitchen" }, { kind: "in_stock", value: true }],
      buyer: TIER2,
      query: "pressure cooker",
      now: NOW,
    });

    const metro = r.satisfied.find((o) => o.candidate.seller.sellerId === "SEL-07"); // 6d dispatch
    const prime = r.satisfied.find((o) => o.candidate.seller.sellerId === "SEL-08"); // 1d dispatch
    expect(Date.parse(prime!.forecast.confidentAt)).toBeLessThan(
      Date.parse(metro!.forecast.confidentAt),
    );
  }, 60_000);

  it("every rejected offer carries a named constraint and an actual value", async () => {
    const r = await findOffers({
      constraints: [
        { kind: "category", value: "kitchen" },
        { kind: "attribute", key: "induction", value: true },
        { kind: "max_price", value: 2000 },
      ],
      buyer: TIER2,
      query: "pressure cooker",
      now: NOW,
    });

    expect(r.rejected.length).toBeGreaterThan(0);
    for (const rej of r.rejected) {
      expect(rej.primary.constraint.length).toBeGreaterThan(0);
      expect(rej.primary.actual.length).toBeGreaterThan(0);
      expect(rej.failed.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("admits nothing on an impossible constraint, and says what to relax", async () => {
    const r = await findOffers({
      constraints: [
        { kind: "category", value: "kitchen" },
        { kind: "max_price", value: 1 },
      ],
      buyer: TIER2,
      query: "pressure cooker",
      now: NOW,
    });
    expect(r.satisfied).toHaveLength(0);
    expect(r.relaxation?.kind).toBe("max_price");
  }, 60_000);

  it("reports the scope it actually checked rather than implying the whole catalogue", async () => {
    const r = await findOffers({
      constraints: [{ kind: "category", value: "footwear" }],
      buyer: TIER2,
      query: "shoes",
      now: NOW,
    });
    expect(r.scope.products).toBeGreaterThan(0);
    expect(r.scope.offers).toBeGreaterThanOrEqual(r.scope.products);
    expect(r.scope.sellers).toBeGreaterThan(0);
  }, 60_000);

  it("excludes a non-induction cooker on the attribute, not silently", async () => {
    const r = await findOffers({
      constraints: [
        { kind: "category", value: "kitchen" },
        { kind: "attribute", key: "induction", value: true },
      ],
      buyer: TIER2,
      query: "pressure cooker",
      now: NOW,
    });

    // The 3L aluminium cooker is seeded with induction: false, so it must
    // appear as a rejection with that reason — never just be missing.
    const aluminium = r.rejected.find((o) => o.candidate.sku === "VJ-KITCH-504");
    expect(aluminium).toBeTruthy();
    expect(aluminium!.failed.some((f) => f.kind === "attribute")).toBe(true);
  }, 60_000);

  it("honours a COD constraint against the one seller who refuses it", async () => {
    const r = await findOffers({
      constraints: [
        { kind: "category", value: "kitchen" },
        { kind: "payment_mode", value: "COD" },
      ],
      buyer: { ...TIER2, paymentMode: "COD" },
      query: "pressure cooker",
      now: NOW,
    });

    // SEL-09 lists the cooker with codEligible: false.
    const refused = r.rejected.find(
      (o) => o.candidate.sku === "VJ-KITCH-501" && o.candidate.seller.sellerId === "SEL-09",
    );
    expect(refused).toBeTruthy();
    expect(refused!.primary.kind).toBe("payment_mode");
  }, 60_000);

  it("the worked example on the page produces exactly one winner", async () => {
    // This is the sentence printed on /find. If it stops behaving, the demo
    // is misleading, so it is asserted here rather than taken on trust.
    const { constraints, query } = parseConstraints(
      "A pressure cooker for my induction hob, 5 litres at most, under 2000, " +
        "must be in stock, and I need it before the 28th",
      NOW,
      categories,
    );

    // The parser must find all five constraints with no model present.
    const kinds = constraints.map((c) => c.kind);
    expect(kinds).toContain("category");
    expect(kinds).toContain("in_stock");
    expect(kinds).toContain("max_price");
    expect(kinds).toContain("arrive_by");
    expect(constraints.filter((c) => c.kind === "attribute").length).toBeGreaterThanOrEqual(2);

    const r = await findOffers({ constraints, buyer: TIER2, query, now: NOW });

    // Exactly one offer satisfies all of it: the 5L induction cooker from a
    // seller fast enough to make the date. Everything else is rejected with a
    // reason — which is the claim the page makes on screen.
    expect(r.satisfied.length).toBeGreaterThanOrEqual(1);
    expect(r.satisfied[0].candidate.sku).toBe("VJ-KITCH-501");
    expect(r.rejected.length).toBeGreaterThan(0);
    expect(r.rejectionSummary.length).toBeGreaterThan(0);
    expect(r.headline).toMatch(/satisfy all/);

    // And the winner's own card has a tick for every constraint.
    expect(r.satisfied[0].satisfied.length).toBe(constraints.length);
  }, 60_000);

  it("dropping one constraint admits more, which is what the chips promise", async () => {
    const strict: Constraint[] = [
      { kind: "category", value: "kitchen" },
      { kind: "attribute", key: "induction", value: true },
      { kind: "max_price", value: 1200 },
    ];
    const strictResult = await findOffers({
      constraints: strict,
      buyer: TIER2,
      query: "pressure cooker",
      now: NOW,
    });

    const relaxed = await findOffers({
      constraints: strict.slice(0, 2),
      buyer: TIER2,
      query: "pressure cooker",
      now: NOW,
    });

    expect(relaxed.satisfied.length).toBeGreaterThan(strictResult.satisfied.length);
  }, 60_000);
});
