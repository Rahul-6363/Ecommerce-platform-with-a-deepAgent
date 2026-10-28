import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { disconnectDb } from "@/lib/db/connect";
import { runEvals } from "@/lib/eval-runner";
import { SCENARIOS } from "@/lib/evals";

let savedKey: string | undefined;

// The suite asserts exact remedies and amounts, so it runs on the
// deterministic path. That is the point: these scenarios check the behaviour
// the platform must hold with no model reachable. Run them with a key present
// via the Evals tab on the desk to see the model path instead — the report
// marks itself "degraded: false" there.
beforeAll(() => {
  savedKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
});

afterAll(async () => {
  if (savedKey) process.env.GROQ_API_KEY = savedKey;
  await disconnectDb();
});

describe("the eval suite", () => {
  it("runs every scenario against the real pipeline", async () => {
    const report = await runEvals();

    console.log(`\n  ${report.ran} scenarios in ${(report.ms / 1000).toFixed(1)}s` +
      `${report.degraded ? " (no model key — fallback path)" : ""}\n`);

    for (const r of report.results) {
      const mark = r.status === "PASS" ? "PASS " : r.status === "KNOWN LIMIT" ? "LIMIT" : r.status === "ERROR" ? "ERROR" : "FAIL ";
      console.log(`  ${mark} ${String(r.id).padStart(2)}. ${r.name}`);
      if (r.status === "FAIL" || r.status === "ERROR") {
        if (r.error) console.log(`         error: ${r.error}`);
        for (const c of r.checks.filter((x) => !x.ok)) {
          console.log(`         ✗ ${c.label} — ${c.detail}`);
        }
      }
    }
    console.log(`\n  ${report.passed} passed, ${report.failed} failed, ` +
      `${report.knownLimits} known limit, ${report.errors} errors\n`);

    expect(report.errors).toBe(0);
    expect(report.failed).toBe(0);

    // There is no KNOWN LIMIT scenario any more.
    //
    // Scenario 16 was the multi-issue limitation and it has been fixed rather
    // than hidden: the claim model now holds a per-issue array, each issue is
    // adjudicated by the same entitlement engine, and the aggregate is capped
    // at the order value. It is asserted as an ordinary scenario above.
    //
    // This assertion is kept and inverted so the reporting mechanism cannot
    // rot unnoticed: if a future scenario declares `knownLimitation`, this
    // fails and forces a decision about whether to fix it or document it,
    // which is the behaviour the original assertion existed to protect.
    expect(report.knownLimits).toBe(0);
    expect(SCENARIOS.filter((s) => s.knownLimitation)).toHaveLength(0);

    // Every scenario must actually assert something. A scenario with no
    // checks reports PASS while testing nothing at all.
    for (const r of report.results) {
      expect(r.checks.length, `scenario ${r.id} asserted nothing`).toBeGreaterThan(0);
    }
  }, 600_000);
});
