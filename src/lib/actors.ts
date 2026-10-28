/**
 * Who did a thing, and whether a model was involved.
 *
 * The event stream records an actor name on every event, and the names alone
 * do not answer the question the whole architecture turns on: was this
 * decision made by a language model, or by a pure function that a model only
 * fed? "TriageAgent" and "EntitlementEngine" look equally agentic in a log,
 * and one of them chose a refund amount.
 *
 * So each actor is classified once, here, and every surface reads the same
 * classification. It is deliberately not inferred from the name — a rule like
 * "ends in Agent" would be wrong for `GroundingGuard` and would silently
 * misclassify anything added later.
 *
 * The three kinds:
 *
 *  - `model`   — a language or vision model produced this. It reads, writes
 *                prose, classifies or extracts. It never decides money.
 *  - `engine`  — a pure function. Same inputs, same output, no network. These
 *                are the ones that decide eligibility, remedies, amounts,
 *                deadlines and what satisfies a constraint.
 *  - `person`  — a human pressed something.
 *  - `system`  — the platform itself: the clock, the seeder, the mailer.
 */

import { AGENTS } from "@/lib/agent/mandate";

export type ActorKind = "model" | "engine" | "person" | "system";

export type ActorFacts = {
  name: string;
  kind: ActorKind;
  /** What this actor is allowed to do, in one line a non-engineer can read. */
  does: string;
  /**
   * What it is structurally prevented from doing.
   *
   * Only set where the limit is the interesting part. For a model that is
   * always "decide anything about money"; for an engine it is usually
   * "nothing — but it cannot act, only answer".
   */
  cannot?: string;
};

const ACTORS: Record<string, ActorFacts> = {
  /* ── Models: they read and write, and decide nothing ───────────────── */
  ShoppingAgent: {
    name: "Shopping agent",
    kind: "model",
    does: "Holds the conversation, works out what you need, and calls tools to search and fill the cart.",
    cannot: "Place an order. That tool refuses an agent turn outright.",
  },
  ConstraintAgent: {
    name: "Constraint reader",
    kind: "model",
    does: "Turns one sentence into hard conditions — a budget, a date, an attribute.",
    cannot: "Decide which offers satisfy them. It only writes the list down.",
  },
  AddressAgent: {
    name: "Address reader",
    kind: "model",
    does: "Splits a dictated address into a street, a landmark and a town.",
    cannot: "Save it. The pincode and phone come from the parser, and the buyer confirms.",
  },
  TriageAgent: {
    name: "Triage agent",
    kind: "model",
    does: "Reads a complaint in any of eight languages and classifies what went wrong.",
    cannot: "Decide whether it is covered, or for how much.",
  },
  PolicyAgent: {
    name: "Policy reader",
    // `AGENTS` declares usesModel: false — it matches clauses by tag rather
    // than asking a model to interpret them.
    kind: "engine",
    does: "Finds the clauses that bear on a claim and quotes them.",
    cannot: "Interpret them into an outcome. The engine does that.",
  },
  ActionAgent: {
    name: "Action agent",
    kind: "model",
    does: "Writes the message the buyer receives, from the decision the engine already made.",
    cannot: "Change the amount or the remedy it is writing about.",
  },
  Orchestrator: {
    name: "Orchestrator",
    kind: "model",
    does: "Writes the plan, then rewrites it when a step fails or a tool dies.",
    cannot: "Skip a gated step. The registry refuses it whatever the plan says.",
  },
  TrackerAgent: {
    name: "Deadline watcher",
    // `AGENTS` declares usesModel: false, and it is right: this is the clock.
    // It wakes on a timer, compares promised dates against now, and escalates
    // inside the platform. The prose a buyer reads about a late parcel is
    // written elsewhere, by a model.
    kind: "engine",
    does: "Watches promised dates, wakes itself on a timer, and escalates a parcel whose deadline has lapsed.",
    cannot: "Decide a remedy, or contact the buyer. It escalates internally and stops.",
  },
  MailAgent: {
    name: "Mailer",
    kind: "model",
    does: "Writes the email body for a decision that has already been approved.",
  },

  /* ── Engines: pure functions. These are the ones that decide ───────── */
  ConstraintSolver: {
    name: "Constraint solver",
    kind: "engine",
    does: "Admits only offers that satisfy every stated condition, and records why each other one failed.",
    cannot: "Be talked into an exception. It has no model in it.",
  },
  EntitlementEngine: {
    name: "Entitlement engine",
    kind: "engine",
    does: "Decides eligibility, remedy, amount and deadline, and cites the clause it used.",
    cannot: "Be reached by a model. It takes facts and returns a verdict.",
  },
  RiskAgent: {
    name: "Risk scorer",
    kind: "engine",
    does: "Scores a parcel's chance of failing before dispatch, from the payment mode, the pincode, the address and your history.",
    cannot: "Act on its own above a threshold. An intervention that costs you something is proposed, not done.",
  },
  FraudAnalyst: {
    name: "Authenticity scorer",
    // A model: it reads the photographs. The scoring that follows is
    // arithmetic, but the thing that says what is in the frame is a vision
    // model, and `AGENTS.usesModel` is the authority here.
    kind: "model",
    does: "Reads the photographs, then weighs them against the courier record and the buyer's claim history.",
    cannot: "Reject a claim. A suspicious score routes it to a person, never to an automatic no.",
  },
  SellerStandingEngine: {
    name: "Seller standing",
    kind: "engine",
    does: "Moves a seller's observed defect rate when a claim against them is upheld.",
    cannot: "Count a rejected claim, or suspend a seller. Suspension is referred to a person.",
  },
  GroundingGuard: {
    name: "Grounding guard",
    kind: "engine",
    does: "Checks every sentence a model wrote against the facts it was given, and rejects anything unsupported.",
    cannot: "Be bypassed. A rejected draft is rewritten or escalated.",
  },
  VerifierAgent: {
    name: "Draft verifier",
    kind: "engine",
    does: "Checks the written message against the policy clause it claims to rest on.",
  },
  ConstraintParser: {
    name: "Constraint parser",
    kind: "engine",
    does: "Reads conditions from a sentence without a model, so the feature still works when none is reachable.",
  },
  AddressParser: {
    name: "Address parser",
    kind: "engine",
    does: "Reads the pincode, phone and landmark from a dictated address, and derives the city, state and delivery tier.",
    cannot: "Be overruled by the model on the digits. A misread pincode misroutes the parcel.",
  },

  /* ── People and the platform ───────────────────────────────────────── */
  Buyer: { name: "You", kind: "person", does: "Approve, confirm, or decline." },
  buyer: { name: "You", kind: "person", does: "Approve, confirm, or decline." },
  operator: {
    name: "Operator",
    kind: "person",
    does: "Approves anything that moves money, and reviews every claim the system would not decide alone.",
  },
  system: {
    name: "Platform",
    kind: "system",
    does: "The clock, the seeder and the outbox. Not a decision-maker.",
  },
};

/** The default for an actor nobody has classified, so the UI never breaks. */
const UNKNOWN: ActorFacts = {
  name: "Unclassified",
  kind: "system",
  does: "Not yet classified. Add it to src/lib/actors.ts.",
};

export function actorFacts(actor: string): ActorFacts {
  const raw = (actor ?? "").trim();

  // `AGENTS` already declares `usesModel` for every agent the registry knows,
  // and it is the authority the mandate check itself uses. Where both have an
  // opinion the mandate wins, so this file cannot drift into claiming a model
  // is a pure function — the single most consequential label on the page.
  const spec = AGENTS[raw];
  const local = ACTORS[raw];
  if (spec && local) {
    const kind: ActorKind = spec.usesModel ? "model" : "engine";
    return kind === local.kind ? local : { ...local, kind };
  }
  if (local) return local;

  // Approvals record who approved: `operator:ops@vaanijya.in`. The person is
  // the point, not their address, so the prefix is what classifies them.
  const prefix = raw.split(":")[0];
  if (prefix && ACTORS[prefix]) {
    return prefix === "operator"
      ? { ...ACTORS.operator, name: raw.slice(raw.indexOf(":") + 1) || "Operator" }
      : ACTORS[prefix];
  }

  return UNKNOWN;
}

/** Everything classified, for a legend. */
export function allActors(): ActorFacts[] {
  // Deduplicated by display name: `Buyer` and `buyer` are one actor with two
  // spellings in the stream.
  const seen = new Set<string>();
  return Object.values(ACTORS).filter((a) => {
    if (seen.has(a.name)) return false;
    seen.add(a.name);
    return true;
  });
}

/**
 * Which stage of the journey an event belongs to.
 *
 * The stream is chronological, which is right for an audit and wrong for an
 * explanation: a judge watching this wants "choosing / before delivery /
 * after delivery", because that is how the product is described.
 */
export type Stage = "choose" | "order" | "transit" | "claim" | "money" | "platform";

export const STAGE_LABELS: Record<Stage, string> = {
  choose: "Choosing",
  order: "Ordering",
  transit: "Before delivery",
  claim: "After delivery",
  money: "Money",
  platform: "Platform",
};

export function stageOf(type: string): Stage {
  if (type.startsWith("finder.") || type.startsWith("catalogue.") || type.startsWith("cart.")) {
    return "choose";
  }
  // Registration is where a buyer enters the platform, so it files with
  // the choosing stage rather than under "platform" miscellany.
  if (type.startsWith("auth.")) return "choose";
  if (type.startsWith("address.")) return "order";
  if (type.startsWith("order.")) return type === "order.delivered" ? "transit" : "order";
  // Rescue belongs with the parcel in flight, not under "platform": it is
  // about a delivery that has not happened yet.
  if (type.startsWith("shipment.") || type.startsWith("risk.") || type.startsWith("rescue.")) {
    return "transit";
  }
  if (type.startsWith("claim.")) return "claim";
  if (type.startsWith("refund.") || type.startsWith("seller.")) return "money";
  if (type.startsWith("agent.")) return "choose";
  return "platform";
}

/**
 * Whether an event is one of the moments the architecture is about.
 *
 * Used to mark the handful of events a judge should not miss in a long trail:
 * a gate refusing a tool, a draft rejected for being unsupported, a decision
 * referred to a person. Everything else is ordinary traffic.
 */
export function isPivotal(type: string, payload?: Record<string, unknown>): string | null {
  if (type === "agent.tool_call" && payload?.refused) {
    return "A tool was refused — the agent did not hold that capability.";
  }
  if (type === "agent.grounding_rejected") {
    return "A model wrote a sentence the facts did not support, and it was thrown away.";
  }
  if (type === "claim.draft_rejected") {
    return "The written message did not match the policy clause, so it was rewritten.";
  }
  if (type === "claim.approval_requested") {
    return "Money is involved, so it stopped here and waited for a person.";
  }
  if (type === "claim.handoff" || type === "claim.escalated") {
    return "The evidence was not clear enough to decide, so a person took it.";
  }
  if (type === "risk.intervention_proposed") {
    return "A fix that costs the buyer something was proposed, not done.";
  }
  if (type === "agent.replanned") {
    return "A step failed and the plan was rewritten around it.";
  }
  if (type === "seller.listings_restricted") {
    return "A seller's own failures caught up with them.";
  }
  // The restraint is as much the point as the action: an agent that acted on
  // every parcel would be pestering buyers, not preventing failures.
  if (type === "rescue.declined") {
    return "The parcel was healthy, so the agent did nothing and said why.";
  }
  if (type === "rescue.queued") {
    return "The fix would reach the buyer, so it waited for a person.";
  }
  if (type === "rescue.handoff") {
    return "No safe automated action was left, so a person took the parcel.";
  }
  if (type === "claim.issues_split") {
    return "One complaint carried more than one problem, and each was kept separate.";
  }
  if (type === "claim.issues_adjudicated") {
    return "Each issue was priced by the rule engine, and the total capped at the order value.";
  }
  return null;
}
