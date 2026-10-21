import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Model failover, tested without the provider.
 *
 * This matters because the failure it guards against is invisible: when the
 * primary model's daily quota runs out, the agent drops to keyword search and
 * the UI says "running without a model" — which sends you looking at the key.
 * Testing it against the live API is useless, since whether it triggers
 * depends on quota that varies by the hour.
 */
describe("Groq model failover", () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.GROQ_API_KEY = "gsk_test_key_not_real";
    process.env.GROQ_TEXT_MODEL = "primary-model";
    process.env.GROQ_FALLBACK_MODELS = "second-model,third-model";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /** Stub the SDK so each model's behaviour is ours to choose. */
  async function withModels(behaviour: Record<string, "ok" | "quota" | "bad_request">) {
    const tried: string[] = [];
    vi.doMock("groq-sdk", () => ({
      default: class {
        chat = {
          completions: {
            create: async ({ model }: { model: string }) => {
              tried.push(model);
              const how = behaviour[model] ?? "quota";
              if (how === "quota") {
                throw Object.assign(new Error("Rate limit reached: tokens per day (TPD)"), { status: 429 });
              }
              if (how === "bad_request") {
                throw Object.assign(new Error("invalid tool schema"), { status: 400 });
              }
              return {
                choices: [{ message: { content: `answered by ${model}`, tool_calls: [] } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              };
            },
          },
        };
      },
    }));
    const { chat } = await import("@/lib/groq/client");
    return { chat, tried };
  }

  it("uses the primary model when it works", async () => {
    const { chat, tried } = await withModels({ "primary-model": "ok" });
    const r = await chat([{ role: "user", content: "hi" }]);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("answered by primary-model");
    expect(tried).toEqual(["primary-model"]);
  });

  it("falls over to the next model when the primary's quota is spent", async () => {
    const { chat, tried } = await withModels({
      "primary-model": "quota",
      "second-model": "ok",
    });
    const r = await chat([{ role: "user", content: "hi" }]);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("answered by second-model");
    expect(r.model).toBe("second-model");
    expect(tried).toEqual(["primary-model", "second-model"]);
  });

  it("walks the whole chain if it has to", async () => {
    const { chat, tried } = await withModels({
      "primary-model": "quota",
      "second-model": "quota",
      "third-model": "ok",
    });
    const r = await chat([{ role: "user", content: "hi" }]);
    expect(r.ok).toBe(true);
    expect(r.model).toBe("third-model");
    expect(tried).toEqual(["primary-model", "second-model", "third-model"]);
  });

  it("reports failure honestly when every model is exhausted", async () => {
    const { chat, tried } = await withModels({
      "primary-model": "quota", "second-model": "quota", "third-model": "quota",
    });
    const r = await chat([{ role: "user", content: "hi" }]);
    expect(r.ok).toBe(false);
    expect(tried).toHaveLength(3);
    // The message must name the model and the remedy, not just say "429".
    expect(r.error).toMatch(/quota|rate limit/i);
  });

  it("does NOT try other models for a bad request — that is our bug", async () => {
    // A malformed request fails identically everywhere, so retrying it on
    // three models just triples the latency before the same error.
    const { chat, tried } = await withModels({
      "primary-model": "bad_request", "second-model": "ok",
    });
    const r = await chat([{ role: "user", content: "hi" }]);
    expect(r.ok).toBe(false);
    expect(tried).toEqual(["primary-model"]);
  });

  it("honours an explicitly requested model without failing over", async () => {
    // When a caller names a model, substituting a different one silently would
    // be worse than failing.
    const { chat, tried } = await withModels({
      "pinned-model": "quota", "second-model": "ok",
    });
    const r = await chat([{ role: "user", content: "hi" }], { model: "pinned-model" });
    expect(r.ok).toBe(false);
    expect(tried).toEqual(["pinned-model"]);
  });
});
