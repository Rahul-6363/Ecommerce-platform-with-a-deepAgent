/**
 * Bounded authority, as data.
 *
 * This table is displayed in the operator UI and enforced in
 * `registry.call()`. A rule written only into a prompt is a request, not a
 * constraint: a model can be talked out of it. These are checked in code
 * before a tool runs, so the worst a confused model can do is get refused.
 */

export type Capability =
  | "read"
  | "compute"
  | "draft"
  | "reversible_courier"
  | "internal_escalation"
  | "cart_write"
  | "reject"
  | "plan";

export type AgentSpec = {
  job: string;
  usesModel: boolean;
  may: Capability[];
  /** What it is allowed to do with nobody approving. */
  unapproved: string;
};

export const AGENTS: Record<string, AgentSpec> = {
  Orchestrator: {
    job: "Decompose a goal into a plan; replan when a tool fails",
    usesModel: true,
    may: ["plan", "read"],
    unapproved: "Planning and reading only",
  },
  ShoppingAgent: {
    job: "Understand a spoken or typed requirement in any language, search the catalogue, assemble a cart",
    usesModel: true,
    may: ["read", "compute", "cart_write", "draft"],
    unapproved: "Search and fill the cart — placing the order needs the buyer to confirm",
  },
  TriageAgent: {
    job: "Complaint text or voice transcript to issue type, evidence flags and buyer priority",
    usesModel: true,
    may: ["read"],
    unapproved: "Reading and classifying — reading is reversible",
  },
  PolicyAgent: {
    job: "Retrieve the policy, match clauses, call checkEntitlement",
    usesModel: false,
    may: ["read", "compute"],
    unapproved: "Reads and the engines — it only computes",
  },
  // Named separately from PolicyAgent because the two do different things and
  // the audit trail should say which: the agent fetches clauses, this decides
  // the remedy and the amount. It holds nothing but read and compute, so it
  // cannot act on its own verdict.
  EntitlementEngine: {
    job: "Decide eligibility, remedy, amount and deadline from the policy and the facts",
    usesModel: false,
    may: ["read", "compute"],
    unapproved: "Returns a verdict and cites the clause — it never pays anyone",
  },
  FraudAnalyst: {
    job: "Inspect the evidence and score how well it supports the allegation",
    usesModel: true,
    may: ["read", "compute"],
    unapproved: "Scores and demands review — it can never reject a buyer by itself",
  },
  RiskAgent: {
    job: "Score dispatched parcels, propose the cheapest intervention",
    usesModel: false,
    may: ["read", "compute", "reversible_courier"],
    unapproved: "Reversible courier actions only",
  },
  ActionAgent: {
    job: "Draft letters and claims; execute what an operator approved",
    usesModel: true,
    may: ["read", "draft"],
    unapproved: "Drafting only — anything that leaves the system waits",
  },
  VerifierAgent: {
    job: "Check every sentence of a draft against a clause or a courier row before it is sent",
    usesModel: false,
    may: ["read", "compute", "reject"],
    unapproved: "Reject and demand a rewrite — it only ever refuses",
  },
  TrackerAgent: {
    job: "Watch deadlines, wake itself up, assemble evidence, escalate inside the platform",
    usesModel: false,
    may: ["read", "compute", "internal_escalation"],
    unapproved: "Internal escalation — this is the autonomous one",
  },
};

/** Which capability each tool requires. */
export const TOOL_CAPABILITY: Record<string, Capability> = {
  // Reads
  search_catalogue: "read",
  get_product: "read",
  get_order: "read",
  get_tracking: "read",
  get_policy: "read",
  get_buyer_profile: "read",
  list_my_orders: "read",
  // Pure engines
  check_entitlement: "compute",
  solve_constraints: "compute",
  risk_score: "compute",
  assess_authenticity: "compute",
  // Cart
  add_to_cart: "cart_write",
  remove_from_cart: "cart_write",
  view_cart: "read",
  // Reversible courier actions — safe enough to do unprompted
  reschedule_delivery: "reversible_courier",
  redirect_to_pickup: "reversible_courier",
  hold_shipment: "reversible_courier",
  // Everything that leaves the system or moves money
  place_order: "draft",
  ask_buyer: "draft",
  convert_cod_to_prepaid: "draft",
  submit_claim: "draft",
  send_message: "draft",
  issue_refund: "draft",
  // Internal
  schedule_followup: "compute",
  escalate: "internal_escalation",
};

/**
 * Tools that stop at the approval gate no matter which agent asks.
 *
 * Note what is in here: messaging the buyer and moving money. The person who
 * approves is therefore neither the buyer nor the seller — they sit between
 * them, which is the only position from which the decision is fair.
 */
export const APPROVAL_REQUIRED = new Set([
  "ask_buyer",
  "convert_cod_to_prepaid",
  "submit_claim",
  "send_message",
  "issue_refund",
]);

/**
 * `place_order` is the one exception that is gated on the *buyer*, not an
 * operator: the agent may fill a cart on its own, but a human must press the
 * button that spends their money.
 */
export const BUYER_CONFIRM_REQUIRED = new Set(["place_order"]);

export function may(agent: string, tool: string): boolean {
  const spec = AGENTS[agent];
  if (!spec) return false;
  const needed = TOOL_CAPABILITY[tool] ?? "read";
  return spec.may.includes(needed);
}

/** Rendered verbatim in the operator UI, so the authority model is visible. */
export function mandatePanel() {
  return Object.entries(AGENTS).map(([agent, spec]) => ({
    agent,
    ...spec,
    tools: Object.entries(TOOL_CAPABILITY)
      .filter(([, cap]) => spec.may.includes(cap))
      .map(([tool]) => tool),
  }));
}

/** Budgets. Exhausting any of these routes to a human, never to a loop. */
export const BUDGETS = {
  maxSteps: 12,
  maxReplans: 2,
  maxEscalationTiers: 2,
  // 4 steps: search → get_product for detail → (one more read) → answer.
  // Each step re-sends the system prompt, the tool schema and every prior tool
  // result, so a step costs more as the loop runs — but 3 was too tight and
  // left questions answered with a generic prompt instead of the facts.
  maxToolCallsPerTurn: 4,
} as const;
