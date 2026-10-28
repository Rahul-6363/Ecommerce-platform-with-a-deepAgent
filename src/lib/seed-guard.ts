/**
 * Guard rails around a destructive seed.
 *
 * `seed()` deletes every collection before rebuilding, which is exactly right
 * for a demo and catastrophic against a database holding real registered
 * accounts and real orders. The old sign-in page offered to run it to anyone
 * while the user table was empty, and nothing stopped it running later.
 *
 * So the destructive path is gated here rather than at each call site, for the
 * same reason the tool registry is one chokepoint: a rule checked in four
 * places is a rule enforced in three.
 *
 * Three refusals, in order of how much damage they prevent:
 *
 *  1. **Never in production without an explicit opt-in.** `NODE_ENV` alone is
 *     not enough, because a staging box runs production builds too. A seed in
 *     production requires `ALLOW_DESTRUCTIVE_SEED=true` to be set deliberately
 *     by whoever operates the database.
 *  2. **Never over registered accounts.** If any user exists that the seed
 *     did not create, the database belongs to real people. That check is on
 *     the data, not the environment, so it holds on a developer machine that
 *     happens to point at a shared cluster.
 *  3. **Never silently.** A refusal says which rule fired and what to do,
 *     because a seed that fails with "forbidden" is a seed someone will work
 *     around.
 */
import { connectDb } from "@/lib/db/connect";
import { User } from "@/models";
import { USERS } from "@/lib/seed-data";
import { env } from "@/lib/env";

/** Emails the seed itself creates. Anything else is a real registration. */
export const DEMO_EMAILS: ReadonlySet<string> = new Set(
  USERS.map((u) => u.email.toLowerCase()),
);

export type SeedVerdict =
  | { allowed: true; reason: string; realAccounts: number }
  | { allowed: false; reason: string; realAccounts: number };

/**
 * May the destructive seed run against the database this process is connected
 * to?
 *
 * Returns a verdict rather than throwing, so a route can answer 403 with the
 * reason and the setup CLI can print it.
 */
export async function canSeed(
  opts: { force?: boolean } = {},
): Promise<SeedVerdict> {
  await connectDb();

  // Accounts the seed did not create. One is enough to stop it.
  const realAccounts = await User.countDocuments({
    email: { $nin: [...DEMO_EMAILS] },
  });

  const explicitlyAllowed =
    (process.env.ALLOW_DESTRUCTIVE_SEED ?? "").toLowerCase() === "true";

  if (env.app.isProd && !explicitlyAllowed) {
    return {
      allowed: false,
      realAccounts,
      reason:
        "Refusing to seed: this is a production build. Seeding deletes every " +
        "collection, including registered accounts and their orders. Set " +
        "ALLOW_DESTRUCTIVE_SEED=true on the server if you genuinely mean to " +
        "wipe this database.",
    };
  }

  if (realAccounts > 0 && !opts.force) {
    return {
      allowed: false,
      realAccounts,
      reason:
        `Refusing to seed: ${realAccounts} account(s) here were created by ` +
        "registration, not by the seed. Seeding would delete them and every " +
        "order, claim and refund attached to them. Re-run with --force if this " +
        "is a scratch database.",
    };
  }

  return {
    allowed: true,
    realAccounts,
    reason:
      realAccounts > 0
        ? `Allowed by an explicit --force over ${realAccounts} registered account(s).`
        : "Allowed: no registered accounts would be lost.",
  };
}

/**
 * Is persistence actually configured?
 *
 * Without `MONGODB_URI` the platform starts an in-process MongoDB, which is
 * ideal locally and a trap in production: registration appears to work and
 * every account vanishes on the next restart. In production that is reported
 * as a failure rather than left to be discovered by a buyer whose order
 * disappeared.
 */
export function persistenceStatus(): {
  persistent: boolean;
  fatal: boolean;
  message: string;
} {
  if (env.mongo.isExternal) {
    return { persistent: true, fatal: false, message: "External MongoDB configured." };
  }
  if (env.app.isProd) {
    return {
      persistent: false,
      fatal: true,
      message:
        "MONGODB_URI is not set and this is a production build. The in-process " +
        "database loses every account and order when the server restarts, so " +
        "registration would silently not persist. Configure MONGODB_URI.",
    };
  }
  return {
    persistent: false,
    fatal: false,
    message:
      "No MONGODB_URI: running on an in-process MongoDB. Data resets when the " +
      "server restarts, which is fine for local development.",
  };
}
