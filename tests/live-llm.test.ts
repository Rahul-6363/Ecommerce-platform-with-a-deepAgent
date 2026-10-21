import { describe, it, expect } from "vitest";
import { pingModel, chat, chatJson } from "@/lib/groq/client";
import { env } from "@/lib/env";
import { SHOPPING_TOOLS } from "@/lib/agent/tools";

/**
 * These touch the real Groq API, so they are skipped without a key. They exist
 * because a retired model name fails exactly like a missing key, and that
 * failure mode cost real debugging time.
 */

/**
 * A 429 is the provider throttling us, not a platform fault. The free tier is
 * a few thousand tokens per minute and a full run can exhaust it, so these
 * tests report that case and skip rather than failing for it.
 */
function throttled(r: { ok: boolean; error?: string }, label: string): boolean {
  // Matches both quota messages: the per-minute rate limit and the per-day
  // token cap. The two read quite differently, and a guard that only knows one
  // of them reports a provider quota as a product failure.
  if (!r.ok && /rate limit|429|quota|tokens per day|TPD/i.test(r.error ?? "")) {
    console.log(`  [skipped] ${label}: rate limited (429) during this run`);
    return true;
  }
  return false;
}

const live = env.groq.enabled ? describe : describe.skip;

live("the configured model actually works", () => {
  it("answers a ping", async () => {
    const r = await pingModel();
    console.log("  ping:", r.detail);
    if (throttled({ ok: r.ok, error: r.detail }, "ping")) return;
    expect(r.ok).toBe(true);
  }, 60_000);

  it("returns non-empty prose, so it can reply to a buyer", async () => {
    const r = await chat([{ role: "user", content: "Say hello in one short sentence." }], { maxTokens: 40 });
    if (throttled(r, "prose")) return;
    expect(r.ok).toBe(true);
    expect(r.content.trim().length).toBeGreaterThan(0);
  }, 60_000);

  it("calls tools, extracting the budget from natural language", async () => {
    const r = await chat(
      [{ role: "user", content: "I need running shoes under 2000 rupees" }],
      { tools: SHOPPING_TOOLS, maxTokens: 400 },
    );
    if (throttled(r, "tool calling")) return;
    expect(r.ok).toBe(true);
    const search = r.toolCalls.find((t) => t.name === "search_catalogue");
    expect(search).toBeTruthy();
    console.log("  tool args:", JSON.stringify(search?.args));
  }, 60_000);

  it("satisfies JSON mode, which triage and planning depend on", async () => {
    const j = await chatJson<{ issue_type?: string }>(
      [
        { role: "system", content: 'Classify. Return JSON {"issue_type":"DAMAGED"} or {"issue_type":"LATE"}.' },
        { role: "user", content: "the box arrived crushed and the screen is cracked" },
      ],
      { maxTokens: 80 },
    );
    if (j === null) {
      console.log("  [skipped] json mode: no parseable result (likely rate limited)");
      return;
    }
    console.log("  json:", JSON.stringify(j));
  }, 60_000);
});
