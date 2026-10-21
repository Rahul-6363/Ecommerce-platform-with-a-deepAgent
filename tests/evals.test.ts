import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { disconnectDb } from "@/lib/db/connect";
import { runEvals } from "@/lib/eval-runner";

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
    // The known limitation must stay visible, not silently start passing.
    expect(report.knownLimits).toBe(1);
  }, 600_000);
});
