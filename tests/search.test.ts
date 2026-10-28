import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { seed } from "@/lib/seed";
import { callTool } from "@/lib/agent/tools";
import { User } from "@/models";
import type { LeanUser } from "@/models";

let userId: string;
beforeAll(async () => {
  await connectDb(); await seed({ force: true });
  const u = await User.findOne({ email: "arjun@example.in" }).lean<LeanUser>();
  userId = String(u!._id);
}, 180_000);
afterAll(async () => { await disconnectDb(); });

const find = async (args: Record<string, unknown>) => {
  const r = await callTool("search_catalogue", args, { userId, agent: "ShoppingAgent" });
  return r.ok ? (r.data as { results: { title: string }[] }).results : [];
};

describe("search tolerates a category that is really a phrase", () => {
  // Regression: a model passes the buyer's words ("pressure cooker") where the
  // catalogue value is "kitchen". An exact match returned nothing, so the agent
  // told the buyer a product it stocks does not exist.
  it("finds the cooker when category is 'pressure cooker'", async () => {
    const r = await find({ query: "5L pressure cooker induction", category: "pressure cooker" });
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((x) => /pressure cooker/i.test(x.title))).toBe(true);
  }, 60_000);

  it("finds shoes when category is 'running shoes'", async () => {
    const r = await find({ query: "running shoes", category: "running shoes" });
    expect(r.some((x) => /shoe|sneaker/i.test(x.title))).toBe(true);
  }, 60_000);

  it("still honours a real category exactly", async () => {
    const r = await find({ query: "shoes", category: "footwear" });
    expect(r.length).toBeGreaterThan(0);
  }, 60_000);

  it("a real category still excludes other categories", async () => {
    const r = await find({ query: "cooker earbuds shoes", category: "kitchen" });
    expect(r.every((x) => !/earbud|shoe/i.test(x.title))).toBe(true);
  }, 60_000);
});
