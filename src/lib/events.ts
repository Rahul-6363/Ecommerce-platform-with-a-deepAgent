/**
 * The append-only event stream.
 *
 * One principle holds this system together: **every meaningful step emits a
 * typed event through `emit()`, and the buyer timeline, the operator desk, the
 * audit log and the live SSE feed are all projections of that one stream.**
 * Nothing writes to a UI directly, so the audit trail cannot drift from what
 * the screens showed.
 */
import { connectDb } from "@/lib/db/connect";
import { Event } from "@/models";
import type mongoose from "mongoose";

export type EventType =
  // Shopping / pre-delivery
  | "agent.session_opened" | "agent.turn" | "agent.tool_call" | "agent.requirements_updated"
  // Orchestrator: the plan is a first-class object, so its lifecycle is events.
  | "agent.plan_created" | "agent.plan_step_started" | "agent.replanned"
  | "agent.paused" | "agent.resumed" | "agent.budget_exhausted"
  | "agent.grounding_rejected"
  | "catalogue.searched" | "cart.item_added" | "cart.item_removed"
  // Constraint-solved search: the extraction and the enforcement are separate
  // events because they are separate authorities — a model reads the sentence,
  // a pure function decides what satisfies it.
  | "finder.constraints_extracted" | "finder.solved" | "finder.offer_accepted"
  | "order.placed" | "order.confirmed" | "order.packed" | "order.dispatched"
  | "order.in_transit" | "order.out_for_delivery" | "order.delivered"
  | "order.cancelled" | "order.payment_converted"
  | "shipment.scan" | "shipment.attempt_failed" | "shipment.redirected" | "shipment.held"
  | "risk.scored" | "risk.intervention_proposed" | "risk.intervention_declined"
  // Proactive rescue: the agent that tries to stop a delivery failing before
  // the buyer has to complain. `assessed` and `declined` are emitted even when
  // nothing happens — an agent that only logs when it acts looks like one that
  // always acts, and the restraint is the part worth proving.
  | "rescue.assessed" | "rescue.declined" | "rescue.intervened" | "rescue.queued"
  | "rescue.rescored" | "rescue.handoff" | "rescue.swept"
  // Addresses, because the pincode on one decides the delivery forecast and
  // the dispatch risk — so changing it changes what the platform promised.
  | "address.added" | "address.updated" | "address.default_changed"
  | "address.dictated"
  // Seller accountability: an upheld claim moves the seller's observed defect
  // rate, which is the number the buyer's comparison prices in.
  | "seller.standing_updated" | "seller.listings_restricted" | "seller.listings_restored"
  // Post-delivery / claims
  | "claim.opened" | "claim.voice_transcribed" | "claim.translated"
  | "claim.triaged" | "claim.evidence_added" | "claim.vision_analysed"
  | "claim.authenticity_assessed" | "claim.adjudicated" | "claim.draft_written"
  // Multi-issue: splitting the prose and adjudicating each issue are separate
  // events because they are separate authorities. A model reads one complaint
  // into several problems; the entitlement engine then decides each one and
  // the aggregate cap, which is why the adjudication event is the engine's.
  | "claim.issues_split" | "claim.issues_adjudicated" | "claim.issue_decided"
  | "claim.draft_verified" | "claim.draft_rejected"
  | "claim.approval_requested" | "claim.approved" | "claim.rejected"
  | "claim.executed" | "claim.resolved" | "claim.escalated" | "claim.handoff"
  // Refunds, as their own lifecycle: a buyer asking "where is my money" is
  // asking a question the order's paymentStatus cannot answer.
  | "refund.initiated" | "refund.settled"
  | "claim.deadline_breached" | "claim.state_changed"
  // Platform
  | "mail.sent" | "mail.captured" | "mail.failed"
  | "system.seeded" | "system.clock_advanced" | "system.degraded" | "system.tool_failed"
  // Public registration. Carries no password material and no address:
  // the stream is read on the operator desk, and a new account does not
  // need to publish where someone lives.
  | "auth.registered";

export type EmitInput = {
  type: EventType;
  actor: string;
  summary: string;
  payload?: Record<string, unknown>;
  claimId?: mongoose.Types.ObjectId | string | null;
  orderId?: mongoose.Types.ObjectId | string | null;
  userId?: mongoose.Types.ObjectId | string | null;
  sessionId?: string;
  at?: Date;
};

/**
 * Append one event. `seq` is a monotonic counter so a client can ask for
 * "everything after N" and resume a dropped SSE connection without gaps.
 */
export async function emit(input: EmitInput) {
  await connectDb();
  const last = await Event.findOne().sort({ seq: -1 }).select("seq").lean();
  const seq = ((last?.seq as number | undefined) ?? 0) + 1;

  const doc = await Event.create({
    seq,
    type: input.type,
    actor: input.actor,
    summary: input.summary,
    payload: input.payload ?? {},
    claimId: input.claimId ?? null,
    orderId: input.orderId ?? null,
    userId: input.userId ?? null,
    sessionId: input.sessionId ?? "",
    at: input.at ?? new Date(),
  });

  return doc.toObject();
}

/** Emit several events in order, sharing one correlation set. */
export async function emitAll(
  common: Omit<EmitInput, "type" | "summary" | "payload">,
  items: Pick<EmitInput, "type" | "summary" | "payload">[],
) {
  const out = [];
  for (const it of items) out.push(await emit({ ...common, ...it }));
  return out;
}

export type EventQuery = {
  since?: number;
  claimId?: string;
  orderId?: string;
  userId?: string;
  types?: EventType[];
  limit?: number;
};

export async function readEvents(q: EventQuery = {}) {
  await connectDb();
  const filter: Record<string, unknown> = {};
  if (q.since !== undefined) filter.seq = { $gt: q.since };
  if (q.claimId) filter.claimId = q.claimId;
  if (q.orderId) filter.orderId = q.orderId;
  if (q.userId) filter.userId = q.userId;
  if (q.types?.length) filter.type = { $in: q.types };

  return Event.find(filter)
    .sort({ seq: 1 })
    .limit(Math.min(q.limit ?? 300, 1000))
    .lean();
}

/**
 * The highest seq in the stream.
 *
 * A cursor for "everything after now": the walkthrough runner takes it before
 * a step and reads the gap afterwards, which is how an event gets attributed
 * to the action that caused it.
 */
export async function latestSeq(): Promise<number> {
  await connectDb();
  const last = await Event.findOne().sort({ seq: -1 }).select("seq").lean();
  return last?.seq ?? 0;
}

/** The operator dashboard counters — a projection, never a stored total. */
export async function projectDashboard() {
  await connectDb();
  const rows = await Event.aggregate<{ _id: string; n: number }>([
    { $group: { _id: "$type", n: { $sum: 1 } } },
  ]);
  const byType: Record<string, number> = {};
  for (const r of rows) byType[r._id] = r.n;

  const sum = (...keys: string[]) => keys.reduce((s, k) => s + (byType[k] ?? 0), 0);

  return {
    byType,
    ordersPlaced: sum("order.placed"),
    ordersDelivered: sum("order.delivered"),
    claimsOpened: sum("claim.opened"),
    claimsResolved: sum("claim.resolved"),
    claimsRejected: sum("claim.rejected"),
    escalations: sum("claim.escalated"),
    handoffs: sum("claim.handoff"),
    interventions: sum("risk.intervention_proposed"),
    declined: sum("risk.intervention_declined"),
    mailSent: sum("mail.sent", "mail.captured"),
    agentTurns: sum("agent.turn"),
  };
}
