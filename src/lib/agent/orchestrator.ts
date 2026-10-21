/**
 * The orchestrator: plan → execute → verify → replan.
 *
 * Ported from Rakshak, which got the important thing right: the plan is a
 * first-class object, written before any tool runs, stored, and shown on
 * screen. You can watch it rewrite itself when a tool dies.
 *
 * Three properties worth preserving:
 *
 *  - **The plan is data.** A model proposes steps; this validates them against
 *    the real tool registry and rejects any plan that would decide a remedy
 *    without calling the rule engine. An invalid plan falls back to a fixed
 *    sequence rather than running something unchecked.
 *  - **It pauses, it does not fail.** Hitting the approval gate raises `Paused`
 *    and the run state is persisted. An approval posted ten minutes later
 *    resumes at exactly the step that stopped.
 *  - **Budgets, not loops.** 12 steps, 2 replans. Exhausting either routes to
 *    HUMAN_HANDOFF with the reasons attached.
 */
import { chatJson } from "@/lib/groq/client";
import { callTool, type ToolContext, type ToolResult } from "@/lib/agent/tools";
import { BUDGETS, APPROVAL_REQUIRED, TOOL_CAPABILITY } from "@/lib/agent/mandate";
import { emit } from "@/lib/events";

export const MAX_STEPS = BUDGETS.maxSteps;
export const MAX_REPLANS = BUDGETS.maxReplans;

export type PlanStep = {
  id: number;
  title: string;
  tool: string;
  args: Record<string, unknown>;
  why: string;
  needsApproval: boolean;
  status: "pending" | "running" | "done" | "failed" | "skipped" | "awaiting_approval";
  /** Filled in after the step runs, for the trace panel. */
  summary?: string;
  ms?: number;
};

export type Plan = {
  steps: PlanStep[];
  /** "model" when the planner wrote it, "fallback" when we did. */
  source: "model" | "fallback" | "replan" | "replan-fallback";
  goal: string;
};

/** Which agent owns each tool, so every step on screen carries a name. */
export const AGENT_FOR_TOOL: Record<string, string> = {
  get_order: "TriageAgent",
  get_tracking: "TriageAgent",
  get_policy: "PolicyAgent",
  get_buyer_profile: "PolicyAgent",
  // The engine, not the model that fetched the clauses for it. This tool is
  // `checkEntitlement()` — a pure function that decides the remedy, the amount
  // and the deadline — and attributing it to a language model misstates who
  // decided the money.
  check_entitlement: "EntitlementEngine",
  assess_authenticity: "FraudAnalyst",
  risk_score: "RiskAgent",
  reschedule_delivery: "RiskAgent",
  redirect_to_pickup: "RiskAgent",
  hold_shipment: "RiskAgent",
  ask_buyer: "ActionAgent",
  convert_cod_to_prepaid: "ActionAgent",
  submit_claim: "ActionAgent",
  send_message: "ActionAgent",
  issue_refund: "ActionAgent",
  schedule_followup: "TrackerAgent",
  escalate: "TrackerAgent",
  search_catalogue: "ShoppingAgent",
  add_to_cart: "ShoppingAgent",
  __draft__: "ActionAgent",
  __verify__: "VerifierAgent",
};

/**
 * The deterministic plan.
 *
 * Used in degraded mode and whenever the planner returns something unusable.
 * It is a complete, correct path through a claim — the model's job is to do
 * better than this, not to be trusted blindly instead of it.
 */
export function fallbackPlan(orderNo: string, issueType: string): PlanStep[] {
  return [
    {
      id: 1, title: "Read the order", tool: "get_order",
      args: { order_no: orderNo },
      why: "establish the facts before deciding anything",
      needsApproval: false, status: "pending",
    },
    {
      id: 2, title: "Read the courier record", tool: "get_tracking",
      args: { order_no: orderNo },
      why: "check whether the scans corroborate the complaint",
      needsApproval: false, status: "pending",
    },
    {
      id: 3, title: "Retrieve the returns policy", tool: "get_policy",
      args: { order_no: orderNo },
      why: "the remedy must be grounded in a clause, not invented",
      needsApproval: false, status: "pending",
    },
    {
      id: 4, title: "Compute entitlement (rule engine)", tool: "check_entitlement",
      args: { order_no: orderNo, issue_type: issueType },
      why: "eligibility, remedy, amount and deadline come only from here",
      needsApproval: false, status: "pending",
    },
    {
      id: 5, title: "Draft the letter to the buyer", tool: "__draft__",
      args: {},
      why: "every assertion must cite a clause or a courier scan",
      needsApproval: false, status: "pending",
    },
    {
      id: 6, title: "Check the draft against the verdict", tool: "__verify__",
      args: {},
      why: "a model wrote prose about money; it is checked before anyone sees it",
      needsApproval: false, status: "pending",
    },
    {
      id: 7, title: "File the claim", tool: "submit_claim",
      args: { order_no: orderNo },
      why: "files the claim the buyer is entitled to — stops at the approval gate",
      needsApproval: true, status: "pending",
    },
  ];
}

const PLANNER_SYSTEM = `You plan the actions of a post-purchase e-commerce resolution agent.

Produce JSON: {"steps":[{"id":1,"title":"...","tool":"get_order","args":{},"why":"...","needs_approval":false}]}

RULES
- Gather facts before deciding. A plan that reaches a remedy without BOTH get_policy and check_entitlement is invalid and will be rejected.
- You MUST NOT compute an amount, an eligibility or a deadline yourself. Those come only from check_entitlement.
- Mark needs_approval true for: ask_buyer, convert_cod_to_prepaid, submit_claim, send_message, issue_refund.
- Use "__draft__" to write the buyer's letter and "__verify__" to check it. Put __verify__ immediately after __draft__.
- Keep it to at most {MAX} steps. Every step needs a "why" a human would accept.
- Output JSON only.`;

type RawPlan = { steps?: unknown };

/** Ask for a plan; validate it hard; fall back rather than run something unchecked. */
export async function makePlan(
  goal: string,
  facts: Record<string, unknown>,
  tools: string[],
  ctx: { orderNo: string; issueType: string; claimId?: string; userId?: string },
): Promise<Plan> {
  const parsed = await chatJson<RawPlan>(
    [
      { role: "system", content: PLANNER_SYSTEM.replace("{MAX}", String(MAX_STEPS)) },
      {
        role: "user",
        content: [
          `GOAL: ${goal}`,
          `CASE FACTS: ${JSON.stringify(facts)}`,
          `AVAILABLE TOOLS: ${JSON.stringify(tools)}`,
        ].join("\n"),
      },
    ],
    { temperature: 0.1, maxTokens: 1200 },
  );

  let steps = normalise(parsed);
  let source: Plan["source"] = "model";

  if (steps.length === 0) {
    steps = fallbackPlan(ctx.orderNo, ctx.issueType);
    source = "fallback";
  }

  await emit({
    type: "agent.plan_created",
    actor: "Orchestrator",
    summary:
      `Planned ${steps.length} steps (${source === "model" ? "by the planner" : "deterministic fallback"}): ` +
      steps.map((s) => s.tool).join(" → "),
    payload: { goal, steps, source, facts },
    claimId: ctx.claimId ?? null,
    userId: ctx.userId ?? null,
  });

  return { steps, source, goal };
}

/**
 * Replan around a failure.
 *
 * A plan that still contains the tool we just watched fail is not a replan, so
 * it is rejected and the deterministic route-around is used instead.
 */
export async function replan(
  plan: Plan,
  failure: string,
  failedTool: string,
  done: PlanStep[],
  facts: Record<string, unknown>,
  tools: string[],
  ctx: { orderNo: string; issueType: string; claimId?: string; userId?: string },
): Promise<Plan> {
  const parsed = await chatJson<RawPlan>(
    [
      { role: "system", content: PLANNER_SYSTEM.replace("{MAX}", String(MAX_STEPS)) },
      {
        role: "user",
        content: [
          `GOAL: ${plan.goal}`,
          `CASE FACTS: ${JSON.stringify(facts)}`,
          `ORIGINAL PLAN: ${JSON.stringify(plan.steps.map((s) => ({ tool: s.tool, title: s.title })))}`,
          `WHAT FAILED: ${failure}`,
          `THE TOOL ${failedTool} IS UNAVAILABLE — do not use it again.`,
          `ALREADY DONE (do not repeat): ${JSON.stringify(done.map((s) => s.tool))}`,
          `AVAILABLE TOOLS: ${JSON.stringify(tools.filter((t) => t !== failedTool))}`,
        ].join("\n"),
      },
    ],
    { temperature: 0.1, maxTokens: 1200 },
  );

  let steps = normalise(parsed);
  let source: Plan["source"] = "replan";

  // If the model put the broken tool back in, it did not understand the task.
  if (steps.some((s) => s.tool === failedTool)) steps = [];

  if (steps.length === 0) {
    steps = routeAround(plan.steps, failedTool, done, ctx);
    source = "replan-fallback";
  }

  await emit({
    type: "agent.replanned",
    actor: "Orchestrator",
    summary:
      `${failedTool} failed — rewrote the plan without it ` +
      `(${source === "replan" ? "by the planner" : "deterministic route-around"}): ` +
      steps.map((s) => s.tool).join(" → "),
    payload: { failure, failedTool, steps, source },
    claimId: ctx.claimId ?? null,
    userId: ctx.userId ?? null,
  });

  return { steps, source, goal: plan.goal };
}

/** Deterministic replan: drop the broken tool, keep the goal reachable. */
function routeAround(
  old: PlanStep[],
  broken: string,
  done: PlanStep[],
  ctx: { orderNo: string; issueType: string },
): PlanStep[] {
  const doneTools = new Set(done.filter((s) => s.status === "done").map((s) => s.tool));
  const steps: PlanStep[] = [];
  let n = 0;

  for (const s of old) {
    if (s.tool === broken) continue;
    // Pseudo-steps always re-run; a real read that already succeeded does not.
    if (doneTools.has(s.tool) && !s.tool.startsWith("__")) continue;
    n += 1;
    steps.push({
      ...s,
      id: n,
      status: "pending",
      why: `${s.why} (replanned: ${broken} is unavailable)`.trim(),
    });
  }

  if (steps.length === 0) {
    // Nothing survived. Keep the two steps that matter: decide, then draft.
    const fb = fallbackPlan(ctx.orderNo, ctx.issueType).filter(
      (s) => s.tool !== broken && (s.tool === "check_entitlement" || s.tool.startsWith("__")),
    );
    return fb.map((s, i) => ({ ...s, id: i + 1 }));
  }

  return steps;
}

/**
 * Validate a proposed plan.
 *
 * This is where a plan is rejected rather than trusted: unknown tools are
 * dropped, the approval flag is forced on for gated tools regardless of what
 * the model claimed, and a plan that computes a remedy without the engine is
 * thrown away whole.
 */
export function normalise(parsed: RawPlan | null): PlanStep[] {
  if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return [];

  const steps: PlanStep[] = [];
  for (const raw of parsed.steps.slice(0, MAX_STEPS)) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const tool = typeof s.tool === "string" ? s.tool : "";

    // Only real tools, or the two pseudo-steps the executor understands.
    const known = tool in TOOL_CAPABILITY || tool === "__draft__" || tool === "__verify__";
    if (!known) continue;

    steps.push({
      id: steps.length + 1,
      title: typeof s.title === "string" && s.title ? s.title : tool,
      tool,
      args: s.args && typeof s.args === "object" ? (s.args as Record<string, unknown>) : {},
      why: typeof s.why === "string" ? s.why : "",
      // The model's own flag is advisory; the registry decides. Setting this
      // from APPROVAL_REQUIRED means a model cannot plan its way past the gate.
      needsApproval: APPROVAL_REQUIRED.has(tool) || s.needs_approval === true,
      status: "pending",
    });
  }

  const tools = new Set(steps.map((s) => s.tool));

  // A plan that decides money without the engine is not a valid plan.
  if (tools.has("check_entitlement") && !tools.has("get_policy")) return [];
  // A plan that files a claim without computing entitlement is worse.
  if (tools.has("submit_claim") && !tools.has("check_entitlement")) return [];

  return steps;
}

/** Raised when the run stops at the approval gate. Not an error. */
export class Paused extends Error {
  constructor(
    readonly stepId: number,
    readonly tool: string,
  ) {
    super(`awaiting approval for ${tool}`);
    this.name = "Paused";
  }
}

export type StepOutcome = {
  step: PlanStep;
  result: ToolResult | null;
  paused: boolean;
};

/**
 * Run one step.
 *
 * Pseudo-steps (`__draft__`, `__verify__`) are handled by the caller, which
 * owns the draft and the verdict; everything else goes through `callTool`, so
 * the mandate and the gate apply identically whether a step came from the model
 * or from the fallback plan.
 */
export async function runStep(
  step: PlanStep,
  ctx: ToolContext,
  substitute: (args: Record<string, unknown>) => Record<string, unknown>,
): Promise<StepOutcome> {
  if (step.tool === "__draft__" || step.tool === "__verify__") {
    return { step, result: null, paused: false };
  }

  const started = Date.now();
  // Each step runs as the agent that owns the tool, not as the Orchestrator.
  // Widening the Orchestrator's mandate to cover every tool it can plan would
  // make the mandate meaningless — the whole point is that the agent holding
  // the capability is the one that acts, and the registry checks that.
  const result = await callTool(step.tool, substitute(step.args), {
    ...ctx,
    agent: AGENT_FOR_TOOL[step.tool] ?? ctx.agent,
  });
  step.ms = Date.now() - started;

  if (!result.ok && result.code === "pending_approval") {
    step.status = "awaiting_approval";
    step.summary = result.error;
    return { step, result, paused: true };
  }

  step.status = result.ok ? "done" : "failed";
  step.summary = result.ok
    ? `ok in ${step.ms}ms`
    : `${result.code}: ${result.error}`;

  return { step, result, paused: false };
}
