import { describe, it, expect, afterAll } from "vitest";
import { disconnectDb } from "@/lib/db/connect";
import { runEvals } from "@/lib/eval-runner";
import { env } from "@/lib/env";

afterAll(async () => { await disconnectDb(); });

/**
 * The same 17 scenarios, but with the model in the loop.
 *
 * `evals.test.ts` strips the key to assert exact remedies on the deterministic
 * path. This one keeps it, because the model path is what a buyer actually
 * meets — and a scenario that passes deterministically but fails with a model
 * is exactly the kind of gap worth knowing about.
 */
/**
 * Opt-in: `npm run test:live`.
 *
 * Left out of the default run because it shares a database and a model quota
 * with the deterministic eval suite. Two suites reseeding the same in-process
 * database while competing for tokens produces failures that belong to the
 * test setup, not the code — which is exactly the kind of noise that makes a
 * suite stop being believed.
 */
const live = env.groq.enabled && process.env.npm_lifecycle_event === "test:live";

(live ? describe : describe.skip)("the eval suite with a live model", () => {
  it("runs, and reports anything the model path breaks", async () => {
    const report = await runEvals();
    console.log(`\n  ${report.passed} passed, ${report.failed} failed, ` +
      `${report.knownLimits} known limit, ${report.errors} errors (degraded=${report.degraded})\n`);

    for (const r of report.results) {
      if (r.status === "FAIL" || r.status === "ERROR") {
        console.log(`  ${r.status} ${r.id}. ${r.name}`);
        if (r.error) console.log(`      error: ${r.error}`);
        for (const c of r.checks.filter((x) => !x.ok)) {
          console.log(`      ✗ ${c.label} — ${c.detail}`);
        }
      }
    }

    expect(report.errors).toBe(0);
    expect(report.knownLimits).toBe(1);
  }, 900_000);
});
