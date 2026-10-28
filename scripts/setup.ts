/**
 * Database setup and operator provisioning, from the machine that owns the
 * database.
 *
 * This exists because the two operations it performs must not be reachable
 * over HTTP. Seeding deletes every collection; promoting an operator grants
 * the authority to approve refunds. Neither belongs behind a button, and
 * `/desk` deliberately has no "make me an operator" control.
 *
 *   npm run setup                      report what is configured, change nothing
 *   npm run setup -- --seed            build the demo database
 *   npm run setup -- --seed --force    ... even over registered accounts
 *   npm run setup -- --operator a@b.c  promote an existing account to operator
 *   npm run setup -- --operator a@b.c --password 'x'   create one if absent
 *
 * Operator provisioning is deliberately boring: it promotes an account that
 * already registered through the ordinary form, so there is no second account
 * creation path to keep secure. Creating one outright needs a password passed
 * explicitly, which keeps it out of shell history by accident rather than by
 * habit.
 */
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { User } from "@/models";
import { seed } from "@/lib/seed";
import { canSeed, persistenceStatus, DEMO_EMAILS } from "@/lib/seed-guard";
import { hashPassword } from "@/lib/auth/session";
import { env } from "@/lib/env";

type Args = {
  seed: boolean;
  force: boolean;
  operator?: string;
  password?: string;
  demote?: string;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { seed: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") out.seed = true;
    else if (a === "--force") out.force = true;
    else if (a === "--operator") out.operator = argv[++i];
    else if (a === "--password") out.password = argv[++i];
    else if (a === "--demote") out.demote = argv[++i];
  }
  return out;
}

const ok = (s: string) => console.log(`  ok    ${s}`);
const no = (s: string) => console.log(`  FAIL  ${s}`);
const info = (s: string) => console.log(`        ${s}`);

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("\nVaanijya setup\n");

  /* ── What is configured ──────────────────────────────────────────── */

  const persistence = persistenceStatus();
  console.log("Environment");
  info(`NODE_ENV           ${process.env.NODE_ENV ?? "development"}`);
  info(`MONGODB_URI        ${env.mongo.isExternal ? "set" : "NOT SET (in-process database)"}`);
  info(`AUTH_SECRET        ${env.auth.isDefault ? "DEFAULT — insecure, change for production" : "set"}`);
  info(`GROQ_API_KEY       ${env.groq.enabled ? "set" : "not set (deterministic fallback path)"}`);
  info(`SMTP_HOST          ${env.mail.enabled ? "set" : "not set (mail captured to the Outbox)"}`);
  console.log("");

  if (persistence.fatal) {
    no(persistence.message);
    // A production process that cannot persist is misconfigured, not degraded.
    process.exitCode = 1;
  } else if (!persistence.persistent) {
    info(persistence.message);
  } else {
    ok(persistence.message);
  }

  if (env.app.isProd && env.auth.isDefault) {
    no(
      "AUTH_SECRET is still the development default. Every session cookie is " +
        "signed with a value published in this repository — set AUTH_SECRET.",
    );
    process.exitCode = 1;
  }

  await connectDb();

  const total = await User.countDocuments();
  const real = await User.countDocuments({ email: { $nin: [...DEMO_EMAILS] } });
  const operators = await User.countDocuments({ role: "operator" });
  console.log("");
  console.log("Database");
  info(`accounts           ${total} (${real} registered, ${total - real} seeded demo)`);
  info(`operators          ${operators}`);

  /* ── Seeding ─────────────────────────────────────────────────────── */

  if (args.seed) {
    console.log("");
    console.log("Seeding");
    const verdict = await canSeed({ force: args.force });
    if (!verdict.allowed) {
      no(verdict.reason);
      process.exitCode = 1;
    } else {
      info(verdict.reason);
      const report = await seed({ force: true });
      ok(
        `seeded ${report.products} products, ${report.sellers} sellers, ` +
          `${report.policies} policies, ${report.users} demo accounts, ` +
          `${report.orders} demo orders`,
      );
      info(`demo password      ${report.password}`);
      for (const line of report.scenarios) info(`  · ${line}`);
    }
  }

  /* ── Operator provisioning ───────────────────────────────────────── */

  if (args.operator) {
    console.log("");
    console.log("Operator provisioning");
    const email = args.operator.trim().toLowerCase();
    const existing = await User.findOne({ email });

    if (existing) {
      if (existing.role === "operator") {
        info(`${email} is already an operator.`);
      } else {
        await User.updateOne({ _id: existing._id }, { $set: { role: "operator" } });
        ok(`promoted ${email} to operator`);
      }
    } else if (args.password) {
      if (args.password.length < 10) {
        no("Refusing to create an operator with a password under 10 characters.");
        process.exitCode = 1;
      } else {
        await User.create({
          email,
          name: email.split("@")[0],
          passwordHash: await hashPassword(args.password),
          role: "operator",
        });
        ok(`created operator ${email}`);
        info("Change this password after the first sign-in.");
      }
    } else {
      no(
        `No account for ${email}. Either register it through the sign-up form ` +
          "first and re-run this to promote it, or pass --password to create it " +
          "outright.",
      );
      process.exitCode = 1;
    }
  }

  if (args.demote) {
    console.log("");
    const email = args.demote.trim().toLowerCase();
    const r = await User.updateOne({ email }, { $set: { role: "buyer" } });
    if (r.matchedCount === 0) {
      no(`No account for ${email}.`);
      process.exitCode = 1;
    } else {
      ok(`${email} is now a buyer`);
    }
  }

  if (!args.seed && !args.operator && !args.demote) {
    console.log("");
    info("Nothing changed. Pass --seed, --operator <email> or --demote <email>.");
  }

  console.log("");
  await disconnectDb();
}

main().catch(async (err) => {
  console.error("\nsetup failed:", err instanceof Error ? err.message : err, "\n");
  process.exitCode = 1;
  await disconnectDb().catch(() => {});
});
