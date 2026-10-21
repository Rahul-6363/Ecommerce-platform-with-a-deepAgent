import { describe, it } from "vitest";
import { keywordTriage } from "@/lib/agent/triage";

describe("debug", () => {
  it("late complaint", () => {
    for (const s of [
      "The bottles were delivered four days after the promised date.",
      "the book was delivered 3 days late, after the promised date",
      "delivered late",
    ]) {
      const t = keywordTriage(s);
      console.log(`"${s}"\n  -> ${t.issueType} (2nd: ${t.secondaryIssue}) conf=${t.confidence} :: ${t.reasoning}`);
    }
  });
});
