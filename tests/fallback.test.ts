import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { seed } from "@/lib/seed";
import { runShoppingTurn } from "@/lib/agent/shopping";
import { AgentSession, User } from "@/models";
import type { LeanUser } from "@/models";
import { nanoid } from "nanoid";

let userId: string;
let savedKey: string | undefined;

beforeAll(async () => {
  // These tests are about the deterministic path, so the model is removed for
  // the duration regardless of what is configured. Asserting on the fallback
  // while a real key is present tests nothing.
  savedKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;

  await connectDb();
  await seed();
  const u = await User.findOne({ email: "arjun@example.in" }).lean<LeanUser>();
  userId = String(u!._id);
}, 120_000);

afterAll(async () => {
  if (savedKey) process.env.GROQ_API_KEY = savedKey;
  await disconnectDb();
});

/**
 * These run with no GROQ key, so they exercise the deterministic fallback —
 * which is exactly the path that produced the wrong results in the bug report.
 */
describe("the fallback keeps the session's requirements", () => {
  it("honours a budget and category stated on the first turn", async () => {
    const s = `t-${nanoid(6)}`;
    const r = await runShoppingTurn(s, userId, "I need running shoes under 2000", "en");

    expect(r.degraded).toBe(true);
    const search = r.toolCalls.find((c) => c.name === "search_catalogue");
    expect(search?.args.max_price_inr).toBe(2000);
    expect(search?.args.category).toBe("footwear");
    // Nothing outside the budget, and nothing from another category.
    expect(r.reply).not.toMatch(/Saree|Pressure Cooker|Earbuds/i);
  }, 60_000);

  it("carries them into a follow-up that states no constraint of its own", async () => {
    const s = `t-${nanoid(6)}`;
    await runShoppingTurn(s, userId, "I need running shoes under 2000", "en");

    // This is the message from the bug report: no budget, no category.
    const r = await runShoppingTurn(s, userId, "Need help with this order.", "en");

    const search = r.toolCalls.find((c) => c.name === "search_catalogue");
    expect(search?.args.max_price_inr).toBe(2000);
    expect(search?.args.category).toBe("footwear");

    // The exact regression: a saree and a cooker for someone who wants shoes.
    expect(r.reply).not.toMatch(/Saree/i);
    expect(r.reply).not.toMatch(/Pressure Cooker/i);
    expect(r.reply).not.toMatch(/Earbuds/i);
  }, 60_000);

  it("states what it actually searched for, so a wrong answer is debuggable", async () => {
    const s = `t-${nanoid(6)}`;
    await runShoppingTurn(s, userId, "chappal under 1000", "en");
    const r = await runShoppingTurn(s, userId, "anything else?", "en");
    expect(r.reply).toMatch(/footwear/i);
    expect(r.reply).toMatch(/1,000|1000/);
  }, 60_000);

  it("never recommends a product above the stated budget", async () => {
    const s = `t-${nanoid(6)}`;
    const r = await runShoppingTurn(s, userId, "shoes under 900", "en");
    const prices = [...r.reply.matchAll(/₹([\d,]+)/g)]
      .map((m) => Number.parseInt(m[1].replace(/,/g, ""), 10))
      // The closing line mentions no price, but the budget echo does.
      .filter((n) => n !== 900);
    for (const p of prices) expect(p).toBeLessThanOrEqual(900);
  }, 60_000);
});

describe("the fallback survives a bad category and a noisy message", () => {
  // Regression: the model records the buyer's phrasing ("running shoes") as
  // the category, but search_catalogue matches the category field exactly, so
  // passing it through filtered out every product and the agent reported that
  // nothing matched while the shoes sat in the catalogue.
  it("finds shoes even when the stored category is a phrase, not a category", async () => {
    const s = `t-${nanoid(6)}`;
    await runShoppingTurn(s, userId, "I need good running shoes under 2000", "en");

    const sess = await AgentSession.findOne({ sessionId: s });
    sess!.requirements = { category: "running shoes", budget_inr: 2000 };
    await sess!.save();

    const r = await runShoppingTurn(s, userId, "Need help with this order.", "en");
    const search = r.toolCalls.find((c) => c.name === "search_catalogue");

    // Either resolved to the real category, or dropped — never passed through.
    expect(["footwear", undefined]).toContain(search?.args.category);
    expect(r.reply).not.toMatch(/could not find anything/i);
    expect(r.reply).toMatch(/Stride Pro|Canvas Sneakers|Kolhapuri|Trail Grip/i);
  }, 60_000);

  it("strips noise words so they do not widen the search", async () => {
    const s = `t-${nanoid(6)}`;
    await runShoppingTurn(s, userId, "chappal under 1000", "en");
    const r = await runShoppingTurn(s, userId, "Need help with this order please", "en");
    const q = String(r.toolCalls.find((c) => c.name === "search_catalogue")?.args.query ?? "");

    for (const noise of ["need", "help", "with", "this", "order", "please", "under"]) {
      expect(q.toLowerCase().split(/\s+/)).not.toContain(noise);
    }
    expect(q).toMatch(/chappal/i);
  }, 60_000);

  it("does not put the budget digits into the query text", async () => {
    const s = `t-${nanoid(6)}`;
    const r = await runShoppingTurn(s, userId, "shoes under 2000", "en");
    const call = r.toolCalls.find((c) => c.name === "search_catalogue");
    expect(String(call?.args.query ?? "")).not.toMatch(/2000/);
    expect(call?.args.max_price_inr).toBe(2000);
  }, 60_000);
});
