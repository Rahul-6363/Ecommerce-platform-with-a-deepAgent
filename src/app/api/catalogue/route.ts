/**
 * The catalogue, filtered and sorted on the server.
 *
 * Deliberately server-side. With 72 products a client could filter in the
 * browser, but then the price and stock a buyer sees would be whatever the
 * browser was last told — and `/api/checkout` would have to trust it. Every
 * number here is read from the database on each request, which is what lets
 * checkout re-read the price rather than accept one from a form.
 *
 * Public on purpose: browsing needs no account. Nothing here is per-buyer, so
 * there is nothing to scope to a session.
 */
import { connectDb } from "@/lib/db/connect";
import { Product } from "@/models";
import { handler } from "@/lib/api";
import { escapeRe } from "@/lib/text";

/** The sorts the UI offers, and what each one means in the database. */
const SORTS: Record<string, Record<string, 1 | -1>> = {
  popular: { ratingCount: -1 },
  price_low: { priceInr: 1 },
  price_high: { priceInr: -1 },
  rating: { ratingAvg: -1, ratingCount: -1 },
  discount: { mrpInr: -1 },
  // Newest is by SKU rather than createdAt: the seed writes everything in one
  // pass, so createdAt would be meaningless and the ordering arbitrary.
  newest: { sku: -1 },
};

export async function GET(req: Request) {
  return handler(async () => {
    await connectDb();
    const u = new URL(req.url);

    const q = (u.searchParams.get("q") ?? "").trim();
    const category = (u.searchParams.get("category") ?? "").trim();
    const sort = u.searchParams.get("sort") ?? "popular";
    const minPrice = Number.parseInt(u.searchParams.get("minPrice") ?? "", 10);
    const maxPrice = Number.parseInt(u.searchParams.get("maxPrice") ?? "", 10);
    const inStockOnly = u.searchParams.get("inStock") === "1";
    const codOnly = u.searchParams.get("cod") === "1";
    const brand = (u.searchParams.get("brand") ?? "").trim();

    const limit = Math.min(Number.parseInt(u.searchParams.get("limit") ?? "60", 10) || 60, 100);
    const offset = Math.max(Number.parseInt(u.searchParams.get("offset") ?? "0", 10) || 0, 0);

    const filter: Record<string, unknown> = { active: true };
    if (category && category !== "all") filter.category = category;
    if (brand) filter.brand = brand;
    // Stock is a real filter, not a badge: an out-of-stock product that looks
    // purchasable is the commonest way a storefront wastes someone's time.
    if (inStockOnly) filter.stock = { $gt: 0 };
    if (codOnly) filter.codEligible = true;

    if (Number.isFinite(minPrice) || Number.isFinite(maxPrice)) {
      const price: Record<string, number> = {};
      if (Number.isFinite(minPrice)) price.$gte = minPrice;
      if (Number.isFinite(maxPrice)) price.$lte = maxPrice;
      filter.priceInr = price;
    }

    if (q) {
      const terms = q.split(/[\s,]+/).filter((t) => t.length >= 2).slice(0, 6);
      if (terms.length) {
        // Each term may match any of these fields. `solves` is included so a
        // buyer who types a need rather than a product name still finds
        // something here — the same vocabulary `/find` matches against.
        filter.$or = terms.flatMap((t) => {
          const re = new RegExp(escapeRe(t), "i");
          return [
            { title: re }, { tags: re }, { brand: re },
            { description: re }, { subcategory: re }, { solves: re },
          ];
        });
      }
    }

    const sortBy = SORTS[sort] ?? SORTS.popular;

    const [rows, total, categoryRows, brandRows, priceBand] = await Promise.all([
      Product.find(filter).sort(sortBy).skip(offset).limit(limit).lean(),
      Product.countDocuments(filter),
      // Counts per category, so the navigation can say how many are in each
      // rather than offering a category that turns out to be empty.
      Product.aggregate<{ _id: string; n: number }>([
        { $match: { active: true } },
        { $group: { _id: "$category", n: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      Product.distinct("brand", { active: true }),
      // The real price range, so a price filter's bounds come from the data
      // rather than from a guessed constant that goes stale.
      Product.aggregate<{ _id: null; min: number; max: number }>([
        { $match: { active: true } },
        { $group: { _id: null, min: { $min: "$priceInr" }, max: { $max: "$priceInr" } } },
      ]),
    ]);

    return {
      count: rows.length,
      total,
      offset,
      limit,
      hasMore: offset + rows.length < total,
      categories: categoryRows.map((c) => ({ name: c._id, count: c.n })),
      brands: (brandRows as string[]).sort(),
      priceRange: priceBand[0]
        ? { min: priceBand[0].min, max: priceBand[0].max }
        : { min: 0, max: 0 },
      sorts: Object.keys(SORTS),
      products: rows.map((p) => ({
        sku: p.sku, title: p.title, brand: p.brand, category: p.category,
        subcategory: p.subcategory, description: p.description,
        priceInr: p.priceInr, mrpInr: p.mrpInr,
        discountPct: p.mrpInr > 0 ? Math.round((1 - p.priceInr / p.mrpInr) * 100) : 0,
        ratingAvg: p.ratingAvg, ratingCount: p.ratingCount,
        stock: p.stock, inStock: (p.stock ?? 0) > 0,
        imageUrl: p.imageUrl ?? "", imageEmoji: p.imageEmoji, accentHex: p.accentHex,
        attributes: p.attributes ?? {}, boxContents: p.boxContents ?? [],
        solves: p.solves ?? [],
        codEligible: p.codEligible,
      })),
    };
  });
}
