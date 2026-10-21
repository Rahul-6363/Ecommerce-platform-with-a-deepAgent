/**
 * A simulated clock.
 *
 * Deadline-driven autonomy is impossible to demonstrate in real time: nobody
 * waits seven days to watch a refund SLA lapse. So every part of the system
 * that needs the time asks `now()` instead of `new Date()`, and the operator
 * desk can push an offset forward. The watcher then genuinely finds a breached
 * deadline — it is not a scripted animation, the clock really moved.
 *
 * The offset lives in the database, so a server restart does not silently
 * rewind the demo.
 */
import { connectDb } from "@/lib/db/connect";
import { Setting } from "@/models";

const KEY = "clock_offset_ms";

export async function now(): Promise<Date> {
  const offset = await offsetMs();
  return new Date(Date.now() + offset);
}

export async function offsetMs(): Promise<number> {
  await connectDb();
  const row = await Setting.findOne({ key: KEY }).lean();
  const v = Number(row?.value ?? 0);
  return Number.isFinite(v) ? v : 0;
}

/** Push the clock forward. Returns the new simulated time. */
export async function advanceMs(ms: number): Promise<Date> {
  await connectDb();
  const next = (await offsetMs()) + Math.max(0, ms);
  await Setting.findOneAndUpdate({ key: KEY }, { $set: { value: next } }, { upsert: true });
  return new Date(Date.now() + next);
}

export async function advanceDays(days: number): Promise<Date> {
  return advanceMs(days * 86_400_000);
}

/**
 * Jump to just past a specific moment. Used by "skip to the deadline": the
 * clock lands one minute after the deadline, so the breach is unambiguous.
 */
export async function advanceTo(target: Date): Promise<Date> {
  const current = await now();
  const delta = target.getTime() - current.getTime() + 60_000;
  if (delta <= 0) return current;
  return advanceMs(delta);
}

export async function resetClock(): Promise<void> {
  await connectDb();
  await Setting.findOneAndUpdate({ key: KEY }, { $set: { value: 0 } }, { upsert: true });
}

/* ─────────────────────── Chaos: the reviewer's switch ───────────────────────
 *
 * Ported from Rakshak, which framed it well: hand the switch over and let
 * someone break a tool. The plan visibly rewrites and the case still
 * completes, which is only convincing because nothing about the plan is
 * hardcoded.
 *
 * Three modes, because they demonstrate different things:
 *   fail  — the tool errors, so the orchestrator must replan around it
 *   slow  — the tool takes 2.5s, so timeout and budget handling is visible
 *   draft — the first draft omits its citations, so the VERIFIER rejects the
 *           agent's own work on screen and it has to revise. Self-correction.
 */
const CHAOS = "chaos";

export type ChaosMode = "fail" | "slow";
export type ChaosState = Record<string, ChaosMode>;

/** The pseudo-tool name for the drafting step, which is not a registry tool. */
export const UNGROUNDED_DRAFT = "__draft__";

export async function chaosState(): Promise<ChaosState> {
  await connectDb();
  const row = await Setting.findOne({ key: CHAOS }).lean();
  const v = row?.value;
  return v && typeof v === "object" ? (v as ChaosState) : {};
}

export async function setChaos(tool: string, mode: ChaosMode | "off"): Promise<ChaosState> {
  await connectDb();
  const next = await chaosState();
  if (mode === "off") delete next[tool];
  else next[tool] = mode;
  await Setting.findOneAndUpdate({ key: CHAOS }, { $set: { value: next } }, { upsert: true });
  return next;
}

export async function clearChaos(): Promise<void> {
  await connectDb();
  await Setting.findOneAndUpdate({ key: CHAOS }, { $set: { value: {} } }, { upsert: true });
}

/** True when the drafting step should deliberately omit its citations. */
export async function ungroundedDraft(): Promise<boolean> {
  return (await chaosState())[UNGROUNDED_DRAFT] === "fail";
}

/**
 * Which single tool is set to fail.
 *
 * The tool registry takes one broken tool name, so this is the bridge from the
 * richer chaos state to that interface. `slow` is applied inside the registry
 * rather than here, because a delay is not a failure.
 */
export async function brokenTool(): Promise<string> {
  const state = await chaosState();
  for (const [tool, mode] of Object.entries(state)) {
    if (mode === "fail" && tool !== UNGROUNDED_DRAFT) return tool;
  }
  return "";
}

export async function setBrokenTool(tool: string): Promise<void> {
  await clearChaos();
  if (tool) await setChaos(tool, "fail");
}
