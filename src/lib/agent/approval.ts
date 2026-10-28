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
  /**
   * Decide individual issues on a multi-issue claim.
   *
   * Keyed by the issue `key`. An issue left out of this map follows the
   * claim-level `approve`, so the existing single-decision call still works
   * unchanged on a multi-issue claim.
   *
   * This exists because approving a two-issue claim as one unit forces the
   * operator to be wrong about one of them: a genuine dead unit alongside a
   * missing-accessory claim they do not believe used to mean paying both or
   * rejecting both.
   */
  issueDecisions?: Record<string, { approve: boolean; note?: string; amountInr?: number }>;
};

export type DecisionResult = {
  claimNo: string;
  state: string;
  remedy: string;
  amountInr: number;
  mailStatus: string;
  overridden: boolean;
  /** Per-issue outcomes on a multi-issue claim. Empty for a single issue. */
  issues: {
    key: string;
    issueType: string;
    decision: "APPROVED" | "REJECTED";
    approvedInr: number;
    note: string;
  }[];
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

  /* ── Per-issue settlement ────────────────────────────────────────────
   *
   * A multi-issue claim is settled issue by issue, so one can be rejected
   * while another is paid. Three rules, in order:
   *
   *  1. An issue with no explicit decision follows the claim-level one, which
   *     keeps every existing single-decision caller working unchanged.
   *  2. An operator amount is honoured but re-capped. A person may overrule
   *     the engine; they may not exceed the order value, and that is enforced
   *     here rather than trusted — the same invariant the engine holds.
   *  3. The aggregate is capped again across the issues actually approved.
   *     The engine already capped its own total, but an operator raising two
   *     issues independently could otherwise sum past the order value.
   */
  const claimIssues = claim.issues ?? [];
  const settled: {
    key: string;
    issueType: string;
    decision: "APPROVED" | "REJECTED";
    approvedInr: number;
    note: string;
  }[] = [];

  let issueTotal = 0;

  if (claimIssues.length > 0) {
    // Most serious first so that if the aggregate cap bites, it trims the
    // least serious issue — never whichever one happens to be stored first.
    const ordered = [...claimIssues].sort((a, b) => b.payableInr - a.payableInr);

    for (const issue of ordered) {
      const explicit = d.issueDecisions?.[issue.key];
      const approveThis = explicit ? explicit.approve : d.approve;

      if (!approveThis) {
        settled.push({
          key: issue.key,
          issueType: issue.issueType,
          decision: "REJECTED",
          approvedInr: 0,
          note: explicit?.note ?? d.note ?? "",
        });
        continue;
      }

      // Start from what the engine said was payable on this issue, which is
      // already net of the subsumption and cap rules.
      const requested = Math.max(0, Math.trunc(explicit?.amountInr ?? issue.payableInr));
      const room = Math.max(0, order.amountInr - issueTotal);
      const approvedInr = Math.min(requested, room);

      issueTotal += approvedInr;
      settled.push({
        key: issue.key,
        issueType: issue.issueType,
        decision: "APPROVED",
        approvedInr,
        note: explicit?.note ?? d.note ?? "",
      });
    }
  }

  // An operator who approved the claim but rejected every individual issue on
  // it has rejected the claim. Recording that as APPROVED would make the state
  // disagree with the per-issue rows, and the claim pays nothing either way.
  const anyIssueApproved = settled.some((x) => x.decision === "APPROVED");
  const effectiveApprove =
    d.approve && !(settled.length > 0 && d.issueDecisions && !anyIssueApproved);

  // Still invariant, even for a human: the payout cannot exceed the order value.
  // On a multi-issue claim the amount paid is the sum of the issues actually
  // approved, so rejecting one issue genuinely reduces what moves.
  const amountInr = effectiveApprove
    ? claimIssues.length > 0 && d.issueDecisions
      ? issueTotal
      : Math.max(0, Math.min(d.overrideAmountInr ?? claim.verdict.amountInr, order.amountInr))
    : 0;

  const state = effectiveApprove ? "APPROVED" : "REJECTED";

  // Through the state machine: a claim cannot reach APPROVED except from a
  // state the machine allows, so the gate cannot be bypassed by a stray write.
  await transitionClaim(
    claim.claimNo,
    state,
    {
      "approval.decision": effectiveApprove ? "APPROVED" : "REJECTED",
      "approval.decidedBy": d.operatorEmail,
      "approval.decidedAt": nowAt,
      "approval.note": d.note ?? "",
      ...(overridden ? { "verdict.remedy": remedy, "verdict.amountInr": amountInr } : {}),
    },
    {
      actor: `operator:${d.operatorEmail}`,
      reason: effectiveApprove ? `approved ${remedy}` : "rejected",
    },
  );

  await emit({
    type: effectiveApprove ? "claim.approved" : "claim.rejected",
    actor: `operator:${d.operatorEmail}`,
    summary: effectiveApprove
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

  /* ── Record each issue's own outcome ─────────────────────────────── */

  if (settled.length > 0) {
    for (const x of settled) {
      await Claim.updateOne(
        { claimNo: claim.claimNo, "issues.key": x.key },
        {
          $set: {
            "issues.$.resolution": {
              decision: x.decision,
              decidedBy: d.operatorEmail,
              decidedAt: nowAt,
              note: x.note,
              approvedInr: x.approvedInr,
            },
          },
        },
      );
    }

    if (claimIssues.length > 1) {
      for (const x of settled) {
        await emit({
          type: "claim.issue_decided",
          actor: `operator:${d.operatorEmail}`,
          summary:
            `${claim.claimNo} ${x.key} (${x.issueType}): ${x.decision.toLowerCase()}` +
            (x.approvedInr > 0 ? ` ₹${x.approvedInr}` : ""),
          payload: { ...x, claimNo: claim.claimNo },
          claimId: claim._id, orderId: order._id, userId: claim.userId,
        });
      }

      await emit({
        type: "claim.issues_adjudicated",
        actor: `operator:${d.operatorEmail}`,
        summary:
          `${settled.filter((x) => x.decision === "APPROVED").length} of ${settled.length} ` +
          `issues approved on ${claim.claimNo}, paying ₹${issueTotal} of a ₹${order.amountInr} cap`,
        payload: {
          settled,
          totalApprovedInr: issueTotal,
          capInr: order.amountInr,
          engineTotalInr: claim.totalPayableInr ?? claim.verdict.amountInr,
        },
        claimId: claim._id, orderId: order._id, userId: claim.userId,
      });
    }
  }

  /* ── Execute the remedy ─────────────────────────────────────────── */

  if (effectiveApprove) {
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
    upheld: effectiveApprove,
    refundedInr: effectiveApprove ? amountInr : 0,
    claimNo: claim.claimNo,
  });

  /* ── Tell the buyer, in writing, with the clause ────────────────── */

  const mail = claimDecision({
    name: buyer.name,
    claimNo: claim.claimNo,
    orderNo: order.orderNo,
    approved: effectiveApprove,
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
    template: effectiveApprove ? "claim_approved" : "claim_rejected",
    claimId: String(claim._id),
    orderId: String(order._id),
  });

  const finalState = effectiveApprove ? "RESOLVED" : "REJECTED";
  await transitionClaim(
    claim.claimNo,
    finalState,
    { resolvedAt: nowAt },
    { actor: "ActionAgent", reason: effectiveApprove ? "remedy executed" : "closed as rejected" },
  );

  await emit({
    type: "claim.resolved",
    actor: "ActionAgent",
    summary: effectiveApprove
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
    issues: settled,
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
