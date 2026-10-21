import { seed } from "@/lib/seed";
import { connectDb } from "@/lib/db/connect";
import { User } from "@/models";
import { requireOperator } from "@/lib/auth/session";
import { handler } from "@/lib/api";

/**
 * Build the database.
 *
 * Open while the database is empty, so a first run needs no credentials —
 * there is no operator account to sign in as yet. Once seeded it requires one.
 */
export async function POST() {
  return handler(async () => {
    await connectDb();
    const existing = await User.countDocuments();
    if (existing > 0) await requireOperator();
    return seed();
  });
}
