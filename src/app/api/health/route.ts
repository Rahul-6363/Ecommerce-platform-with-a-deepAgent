import { capabilities, env } from "@/lib/env";
import { pingModel } from "@/lib/groq/client";
import { verifyMail } from "@/lib/mail/mailer";
import { connectDb } from "@/lib/db/connect";
import { Product, User } from "@/models";
import { handler } from "@/lib/api";

/**
 * What is actually live.
 *
 * `?deep=1` makes one real call to each provider, so the badge reflects a
 * working key rather than a key-shaped string.
 */
export async function GET(req: Request) {
  return handler(async () => {
    const deep = new URL(req.url).searchParams.get("deep") === "1";

    let dbStatus: { ok: boolean; detail: string };
    let seeded = false;
    try {
      await connectDb();
      const [users, products] = await Promise.all([
        User.countDocuments(),
        Product.countDocuments(),
      ]);
      seeded = users > 0 && products > 0;
      dbStatus = {
        ok: true,
        detail: seeded
          ? `${users} users, ${products} products`
          : "connected but empty — run the seed",
      };
    } catch (err) {
      dbStatus = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    return {
      capabilities: capabilities(),
      seeded,
      database: { ...dbStatus, external: env.mongo.isExternal },
      ...(deep
        ? { model: await pingModel(), mail: await verifyMail() }
        : {}),
    };
  });
}
