/**
 * The approval gate, and what happens on each side of it.
 *
 * Nothing in this file runs from an agent turn. An operator calls it, and only
 * then does money move or a letter reach a customer. The gate is the whole
 * reason the agent is allowed to be as autonomous as it is everywhere else.
 */
import { connectDb } from "@/lib/db/connect";
import { Claim, Order, User } from "@/models";
import type { LeanClaim, LeanOrder, LeanUser } from "@/models";
import { emit } from "@/lib/events";
import { recordClaimOutcome } from "@/lib/sellers";
import { openRefund } from "@/lib/refunds";
import { sendMail } from "@/lib/mail/mailer";
import { claimDecision } from "@/lib/mail/templates";
import { now } from "@/lib/clock";
import { transitionClaim } from "@/lib/engines/states";

export type Decision = {
  claimNo: string;
  approve: boolean;
  operatorEmail: string;
  note?: string;
  /** An operator may overrule the engine's remedy; it is recorded as an override. */
  overrideRemedy?: string;
  overrideAmountInr?: number;
};

export type DecisionResult = {
  claimNo: string;
  state: string;
  remedy: string;
  amountInr: number;
  mailStatus: string;
  overridden: boolean;
};

export async function decideClaim(d: Decision): Promise<DecisionResult> {
  await connectDb();
  const nowAt = await now();

  const claim = await Claim.findOne({ claimNo: d.claimNo }).lean<LeanClaim>();
  if (!claim) throw new Error(`No claim ${d.claimNo}`);
  if (claim.approval?.decision) {
    throw new Error(`${d.claimNo} was already ${claim.approval.decision.toLowerCase()}.`);
  }

  const order = await Order.findById(claim.orderId).lean<LeanOrder>();
  const buyer = await User.findById(claim.userId).lean<LeanUser>();
  if (!order || !buyer) throw new Error("The claim is missing its order or buyer.");

  // An override is honoured but recorded: the audit trail must show that a
  // person, not the engine, chose this number.
  const overridden =
    d.approve &&
    ((d.overrideRemedy !== undefined && d.overrideRemedy !== claim.verdict.remedy) ||
      (d.overrideAmountInr !== undefined && d.overrideAmountInr !== claim.verdict.amountInr));

  const remedy = d.approve ? (d.overrideRemedy ?? claim.verdict.remedy) : "NONE";
  // Still invariant, even for a human: the payout cannot exceed the order value.
  const amountInr = d.approve
    ? Math.max(0, Math.min(d.overrideAmountInr ?? claim.verdict.amountInr, order.amountInr))
    : 0;

  const state = d.approve ? "APPROVED" : "REJECTED";

  // Through the state machine: a claim cannot reach APPROVED except from a
  // state the machine allows, so the gate cannot be bypassed by a stray write.
  await transitionClaim(
    claim.claimNo,
    state,
    {
      "approval.decision": d.approve ? "APPROVED" : "REJECTED",
      "approval.decidedBy": d.operatorEmail,
      "approval.decidedAt": nowAt,
      "approval.note": d.note ?? "",
      ...(overridden ? { "verdict.remedy": remedy, "verdict.amountInr": amountInr } : {}),
    },
    {
      actor: `operator:${d.operatorEmail}`,
      reason: d.approve ? `approved ${remedy}` : "rejected",
    },
  );

  await emit({
    type: d.approve ? "claim.approved" : "claim.rejected",
    actor: `operator:${d.operatorEmail}`,
    summary: d.approve
      ? `Approved ${remedy.replace(/_/g, " ")}${amountInr > 0 ? ` ₹${amountInr}` : ""}` +
        (overridden ? ` — OVERRIDE of the engine's ${claim.verdict.remedy} ₹${claim.verdict.amountInr}` : "")
      : `Rejected the claim${d.note ? `: ${d.note}` : ""}`,
    payload: {
      decision: state, remedy, amountInr, note: d.note ?? "",
      overridden,
      engineRemedy: claim.verdict.remedy,
      engineAmountInr: claim.verdict.amountInr,
      authenticity: claim.authenticity,
    },
    claimId: claim._id, orderId: order._id, userId: claim.userId,
  });

  /* ── Execute the remedy ─────────────────────────────────────────── */

  if (d.approve) {
    await executeRemedy({
      claimId: String(claim._id),
      orderId: String(order._id),
      userId: String(claim.userId),
      remedy,
      amountInr,
      orderAmountInr: order.amountInr,
      clauseIds: claim.verdict.clauseIds ?? [],
    });
  } else {
    // A rejected claim counts against the buyer's claim record, which the
    // authenticity engine reads next time. This is the one place that counter
    // is incremented, so it can never drift from the audit trail.
    await User.updateOne({ _id: claim.userId }, { $inc: { rejectedClaims: 1 } });
  }

  /* ── The other half of the loop: the seller hears about it ────────
   *
   * Buyers were already paying for a seller's failure rate in the true-cost
   * comparison, but that rate never moved however badly a seller performed.
   * Recording the outcome here closes it: an upheld claim raises the seller's
   * observed defect rate, which is the number the buyer's next comparison
   * prices in, and a bad enough rate throttles their listings.
   *
   * Recorded at the decision, not at the filing - only a reviewed claim is
   * evidence. A rejected claim is recorded too, as a rejected claim, so the
   * seller can see the platform reviewed it and found nothing against them.
   */
  await recordClaimOutcome({
    orderId: String(order._id),
    sku: claim.sku || undefined,
    upheld: d.approve,
    refundedInr: d.approve ? amountInr : 0,
    claimNo: claim.claimNo,
  });

  /* ── Tell the buyer, in writing, with the clause ────────────────── */

  const mail = claimDecision({
    name: buyer.name,
    claimNo: claim.claimNo,
    orderNo: order.orderNo,
    approved: d.approve,
    remedy,
    amountInr,
    deadlineAt: claim.verdict.deadlineAt ? new Date(claim.verdict.deadlineAt) : null,
    body: claim.draftMessage,
    clauseIds: claim.verdict.clauseIds ?? [],
    operatorNote: d.note ?? "",
  });

  const sent = await sendMail({
    to: buyer.email,
    subject: mail.subject,
    html: mail.html,
    template: d.approve ? "claim_approved" : "claim_rejected",
    claimId: String(claim._id),
    orderId: String(order._id),
  });

  const finalState = d.approve ? "RESOLVED" : "REJECTED";
  await transitionClaim(
    claim.claimNo,
    finalState,
    { resolvedAt: nowAt },
    { actor: "ActionAgent", reason: d.approve ? "remedy executed" : "closed as rejected" },
  );

  await emit({
    type: "claim.resolved",
    actor: "ActionAgent",
    summary: d.approve
      ? `Executed ${remedy.replace(/_/g, " ")}${amountInr > 0 ? ` ₹${amountInr}` : ""} and notified ${buyer.email}`
      : `Closed as rejected and notified ${buyer.email}`,
    payload: { remedy, amountInr, mailStatus: sent.status },
    claimId: claim._id, orderId: order._id, userId: claim.userId,
  });

  return {
    claimNo: claim.claimNo,
    state: finalState,
    remedy,
    amountInr,
    mailStatus: sent.status,
    overridden,
  };
}

/**
 * Carry out what was approved. In a real deployment each branch calls a payment
 * or logistics provider; here each one writes the state change it would cause,
 * so the rest of the system (and the audit log) behaves identically.
 */
async function executeRemedy(p: {
  claimId: string;
  orderId: string;
  userId: string;
  remedy: string;
  amountInr: number;
  orderAmountInr: number;
  /** Carried through so the refund row cites the same clauses as the verdict. */
  clauseIds: string[];
}): Promise<void> {
  await connectDb();

  switch (p.remedy) {
    case "FULL_REFUND":
      await Order.updateOne({ _id: p.orderId }, { $set: { paymentStatus: "REFUNDED" } });
      // The order's paymentStatus says a refund happened; it does not say how
      // much, to where, or by when - which is everything the buyer actually
      // wants to know, and the reason they write in to ask. The ledger row
      // carries all three, with a settlement date from the policy SLA.
      await openRefund({
        claimId: p.claimId,
        orderId: p.orderId,
        userId: p.userId,
        remedy: p.remedy,
        amountInr: p.amountInr,
        clauseIds: p.clauseIds,
      });
      break;
    case "PARTIAL_REFUND":
      await Order.updateOne({ _id: p.orderId }, { $set: { paymentStatus: "PARTIAL_REFUND" } });
      await openRefund({
        claimId: p.claimId,
        orderId: p.orderId,
        userId: p.userId,
        remedy: p.remedy,
        amountInr: p.amountInr,
        clauseIds: p.clauseIds,
      });
      break;
    case "STORE_CREDIT":
      await User.updateOne({ _id: p.userId }, { $inc: { storeCreditInr: p.amountInr } });
      // Store credit is money too, and it lands instantly rather than in a
      // bank account - so it gets a row that says exactly that.
      await openRefund({
        claimId: p.claimId,
        orderId: p.orderId,
        userId: p.userId,
        remedy: p.remedy,
        amountInr: p.amountInr,
        clauseIds: p.clauseIds,
      });
      break;
    case "REPLACEMENT":
    case "RESHIP":
    case "PART_SHIPMENT":
      // A goods remedy raises a fresh fulfilment task; no money moves.
      break;
    default:
      break;
  }

  await emit({
    type: "claim.executed",
    actor: "ActionAgent",
    summary:
      p.amountInr > 0
        ? `${p.remedy.replace(/_/g, " ")} of ₹${p.amountInr} executed against order value ₹${p.orderAmountInr}`
        : `${p.remedy.replace(/_/g, " ")} executed — goods remedy, no cash movement`,
    payload: { remedy: p.remedy, amountInr: p.amountInr },
    claimId: p.claimId, orderId: p.orderId, userId: p.userId,
  });
}

/** Every case waiting on a human, newest first. */
export async function pendingApprovals() {
  await connectDb();
  return Claim.find({ state: { $in: ["AWAITING_APPROVAL", "HUMAN_HANDOFF", "ESCALATED_T1", "ESCALATED_T2"] } })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean<LeanClaim[]>();
}
