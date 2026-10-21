/**
 * Case and order state machines.
 *
 * Ported from Rakshak, which put it well: a state machine that silently
 * accepts anything is not a state machine. Every transition is declared here
 * and checked at the point of change, so a bug that would move a claim from
 * RESOLVED back to INTAKE throws instead of quietly corrupting the record.
 *
 * This matters because the whole audit story rests on claim state: if a claim
 * can reach APPROVED without passing the gate, the gate proves nothing.
 */
import type { ClaimState, OrderStatus } from "@/lib/types";

/** claim state -> the states it may legally move to. */
export const CLAIM_TRANSITIONS: Record<ClaimState, ClaimState[]> = {
  INTAKE: ["TRIAGED", "HUMAN_HANDOFF"],
  TRIAGED: ["ADJUDICATED", "HUMAN_HANDOFF"],
  ADJUDICATED: ["AWAITING_APPROVAL", "HUMAN_HANDOFF", "REJECTED"],
  // The gate. Everything that moves money or leaves the platform passes here.
  AWAITING_APPROVAL: ["APPROVED", "REJECTED", "HUMAN_HANDOFF", "ESCALATED_T1"],
  APPROVED: ["EXECUTING", "RESOLVED", "ESCALATED_T1", "HUMAN_HANDOFF"],
  EXECUTING: ["RESOLVED", "ESCALATED_T1", "HUMAN_HANDOFF"],
  // Escalation is the autonomous path: reversible, internal, no money moves.
  ESCALATED_T1: ["ESCALATED_T2", "RESOLVED", "HUMAN_HANDOFF"],
  ESCALATED_T2: ["RESOLVED", "HUMAN_HANDOFF"],
  // A human can always reopen a handoff by deciding it.
  HUMAN_HANDOFF: ["APPROVED", "REJECTED", "RESOLVED"],
  // Terminal.
  RESOLVED: [],
  REJECTED: [],
};

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PLACED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PACKED", "CANCELLED"],
  PACKED: ["DISPATCHED", "CANCELLED"],
  DISPATCHED: ["IN_TRANSIT", "OUT_FOR_DELIVERY", "RTO"],
  IN_TRANSIT: ["OUT_FOR_DELIVERY", "RTO"],
  OUT_FOR_DELIVERY: ["DELIVERED", "IN_TRANSIT", "RTO"],
  // A delivered order can still fail: that is what a DOA or DAMAGED claim is.
  DELIVERED: ["RTO"],
  CANCELLED: [],
  RTO: [],
};

export const TERMINAL_CLAIM_STATES: ClaimState[] = ["RESOLVED", "REJECTED"];

export class IllegalTransition extends Error {
  constructor(
    readonly kind: "claim" | "order",
    readonly from: string,
    readonly to: string,
    allowed: string[],
  ) {
    super(
      `illegal ${kind} transition ${from} → ${to}; allowed from ${from}: ` +
        (allowed.length ? allowed.join(", ") : "none (terminal)"),
    );
    this.name = "IllegalTransition";
  }
}

function assertTransition<S extends string>(
  table: Record<S, S[]>,
  kind: "claim" | "order",
  from: string,
  to: string,
): S {
  if (!(from in table)) throw new IllegalTransition(kind, from, to, []);
  if (!(to in table)) throw new IllegalTransition(kind, from, to, table[from as S]);
  const allowed = table[from as S];
  if (!allowed.includes(to as S)) throw new IllegalTransition(kind, from, to, allowed);
  return to as S;
}

export function assertClaimTransition(from: string, to: string): ClaimState {
  return assertTransition(CLAIM_TRANSITIONS, "claim", from, to);
}

export function assertOrderTransition(from: string, to: string): OrderStatus {
  return assertTransition(ORDER_TRANSITIONS, "order", from, to);
}

export function isTerminalClaim(state: string): boolean {
  return (TERMINAL_CLAIM_STATES as string[]).includes(state);
}

/** Can this transition happen? For a UI that wants to hide a dead control. */
export function canClaimTransition(from: string, to: string): boolean {
  try {
    assertClaimTransition(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * The declared machine, for display. The operator desk renders this so the
 * lifecycle is visible rather than folklore.
 */
export function claimMachine() {
  return Object.entries(CLAIM_TRANSITIONS).map(([state, next]) => ({
    state,
    next,
    terminal: next.length === 0,
    gate: state === "AWAITING_APPROVAL",
  }));
}

/* ───────────────────── The enforced write path ───────────────────── */

/**
 * Move a claim to a new state, refusing an illegal transition.
 *
 * One chokepoint, for the same reason the tool registry is one: a rule checked
 * in seven places is a rule enforced in six. Callers pass extra fields to set
 * alongside the state, so this replaces the ad-hoc `updateOne` rather than
 * being an extra step someone can forget.
 */
export async function transitionClaim(
  claimNo: string,
  to: ClaimState,
  extra: Record<string, unknown> = {},
  opts: { actor?: string; reason?: string } = {},
): Promise<{ from: string; to: ClaimState }> {
  // Imported lazily: states.ts is a pure module that the engines tests load
  // without a database, and a top-level import would drag Mongoose in.
  const { connectDb } = await import("@/lib/db/connect");
  const { Claim } = await import("@/models");
  const { emit } = await import("@/lib/events");

  await connectDb();
  const current = await Claim.findOne({ claimNo }).select("state _id orderId userId").lean<{
    _id: unknown; state: string; orderId: unknown; userId: unknown;
  }>();
  if (!current) throw new Error(`No claim ${claimNo}`);

  const from = current.state;
  // A no-op is allowed: re-running a step should not throw.
  if (from !== to) assertClaimTransition(from, to);

  await Claim.updateOne({ claimNo }, { $set: { state: to, ...extra } });

  if (from !== to) {
    await emit({
      type: "claim.state_changed",
      actor: opts.actor ?? "system",
      summary: `${claimNo}: ${from} → ${to}${opts.reason ? ` (${opts.reason})` : ""}`,
      payload: { from, to, reason: opts.reason ?? "" },
      claimId: current._id as never,
      orderId: current.orderId as never,
      userId: current.userId as never,
    });
  }

  return { from, to };
}
