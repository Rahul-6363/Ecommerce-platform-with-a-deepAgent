import { connectDb } from "@/lib/db/connect";
import { Product } from "@/models";
import { handler } from "@/lib/api";
import { escapeRe } from "@/lib/text";

export async function GET(req: Request) {
  return handler(async () => {
    await connectDb();
    const u = new URL(req.url);
    const q = (u.searchParams.get("q") ?? "").trim();
    const category = (u.searchParams.get("category") ?? "").trim();
    const sort = u.searchParams.get("sort") ?? "popular";
    const limit = Math.min(Number.parseInt(u.searchParams.get("limit") ?? "60", 10) || 60, 100);

    const filter: Record<string, unknown> = { active: true };
    if (category && category !== "all") filter.category = category;
    if (q) {
      const terms = q.split(/[\s,]+/).filter((t) => t.length >= 2).slice(0, 6);
      if (terms.length) {
        filter.$or = terms.flatMap((t) => {
          const re = new RegExp(escapeRe(t), "i");
          return [{ title: re }, { tags: re }, { brand: re }, { description: re }, { subcategory: re }];
        });
      }
    }

    const sortBy: Record<string, 1 | -1> =
      sort === "price_low" ? { priceInr: 1 }
      : sort === "price_high" ? { priceInr: -1 }
      : sort === "rating" ? { ratingAvg: -1, ratingCount: -1 }
      : { ratingCount: -1 };

    const rows = await Product.find(filter).sort(sortBy).limit(limit).lean();
    const categories = await Product.distinct("category", { active: true });

    return {
      count: rows.length,
      categories: categories.sort(),
      products: rows.map((p) => ({
        sku: p.sku, title: p.title, brand: p.brand, category: p.category,
        subcategory: p.subcategory, description: p.description,
        priceInr: p.priceInr, mrpInr: p.mrpInr,
        discountPct: p.mrpInr > 0 ? Math.round((1 - p.priceInr / p.mrpInr) * 100) : 0,
        ratingAvg: p.ratingAvg, ratingCount: p.ratingCount,
        stock: p.stock, inStock: (p.stock ?? 0) > 0,
        imageEmoji: p.imageEmoji, accentHex: p.accentHex,
        attributes: p.attributes ?? {}, boxContents: p.boxContents ?? [],
        codEligible: p.codEligible,
      })),
    };
  });
}
