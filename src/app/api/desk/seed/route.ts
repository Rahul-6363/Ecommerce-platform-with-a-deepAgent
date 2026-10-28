import { seed } from "@/lib/seed";
import { connectDb } from "@/lib/db/connect";
import { User } from "@/models";
import { requireOperator } from "@/lib/auth/session";
import { canSeed, persistenceStatus } from "@/lib/seed-guard";
import { handler, fail } from "@/lib/api";
import { env } from "@/lib/env";

/**
 * Re-seed the demo database.
 *
 * This used to be open while the user table was empty, so a first run needed
 * no credentials. That convenience is gone: seeding deletes every collection,
 * and an unauthenticated endpoint that can do that is not something to leave
 * reachable. Database setup now belongs to `npm run setup`, which runs on the
 * machine that owns the database.
 *
 * What remains here is the demo control: an operator re-seeding to reset a
 * demonstration. It is refused in production unless ALLOW_DESTRUCTIVE_SEED is
 * set, and refused over registered accounts unless forced.
 */
export async function GET() {
  return handler(async () => {
    await requireOperator();
    const verdict = await canSeed();
    return { ...verdict, persistence: persistenceStatus() };
  });
}

export async function POST(req: Request) {
  return handler(async () => {
    await requireOperator();
    await connectDb();

    // `force` is accepted from an operator but never in production, where the
    // environment gate above is the one that matters.
    const body = await req.json().catch(() => ({}) as Record<string, unknown>);
    const force = body?.force === true && !env.app.isProd;

    const verdict = await canSeed({ force });
    if (!verdict.allowed) {
      return fail(verdict.reason, 403, {
        realAccounts: verdict.realAccounts,
        persistence: persistenceStatus(),
      });
    }

    const report = await seed({ force: true });
    return { ...report, registeredAccountsPreserved: false };
  });
}
