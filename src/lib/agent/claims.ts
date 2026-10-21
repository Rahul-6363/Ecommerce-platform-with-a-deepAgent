/**
 * The post-delivery pipeline.
 *
 * A buyer says something is wrong — typed or spoken, in their own language,
 * usually with a photograph. This runs the whole case:
 *
 *   transcribe → triage → read the courier record → inspect the photos
 *   → score authenticity → adjudicate with the rule engine → draft a letter
 *   → verify the letter → stop at the approval gate → email the operator
 *
 * The division of labour is the point. A model reads the complaint and writes
 * the prose. A pure function decides the money. A second pure function decides
 * whether the evidence supports the allegation at all. And a human approves
 * before a rupee moves or a word reaches the customer.
 */
import mongoose from "mongoose";
import { connectDb } from "@/lib/db/connect";
import { Claim, Order, Policy, Product, Seller, Shipment, User } from "@/models";
import type { LeanEvidence, LeanOrder, LeanPolicy, LeanShipment, LeanUser } from "@/models";
import { checkEntitlement } from "@/lib/engines/entitlement";
import { assessAuthenticity } from "@/lib/engines/authenticity";
import { triage, type TriageResult } from "@/lib/agent/triage";
import { verifyDraft, templateDraft } from "@/lib/agent/verifier";
import { chat, seeImage, transcribe, type VisionFindings } from "@/lib/groq/client";
import {
  makePlan, replan, runStep, AGENT_FOR_TOOL, MAX_REPLANS, MAX_STEPS,
  type Plan, type PlanStep,
} from "@/lib/agent/orchestrator";
import { callTool, type ToolContext } from "@/lib/agent/tools";
import { brokenTool, chaosState, ungroundedDraft } from "@/lib/clock";
import { transitionClaim } from "@/lib/engines/states";
import { emit } from "@/lib/events";
import { sendMail } from "@/lib/mail/mailer";
import { claimReceived, operatorApproval } from "@/lib/mail/templates";
import { env } from "@/lib/env";
import { now } from "@/lib/clock";
import { nanoid } from "nanoid";
import type { AuthenticityAssessment, EvidenceFlags, IssueType, Verdict } from "@/lib/types";

export type EvidenceUpload = {
  kind: "image" | "audio";
  filename: string;
  mimeType: string;
  bytes: number;
  dataUrl: string;
  caption?: string;
};

export type ClaimOutcome = {
  claimNo: string;
  state: string;
  triage: TriageResult;
  verdict: Verdict;
  authenticity: AuthenticityAssessment;
  draft: string;
  draftVerified: boolean;
  verifierNotes: string[];
  /** How many drafts the verifier binned before one passed. */
  rejectedDrafts: number;
  visionFindings: (VisionFindings & { filename: string })[];
  degraded: boolean;
  /** The route the agent planned, and how it actually went. */
  plan: { goal: string; source: string; steps: PlanStep[] };
  budget: { stepsUsed: number; replansUsed: number; exhausted: boolean };
};

/** The tools the planner may use on a claim. */
const CLAIM_PLAN_TOOLS = [
  "get_order", "get_tracking", "get_policy", "get_buyer_profile",
  "check_entitlement", "assess_authenticity",
  "__draft__", "__verify__", "submit_claim", "send_message", "schedule_followup",
];

export type PlanExecution = {
  plan: Plan;
  stepsUsed: number;
  replansUsed: number;
  /** The step that hit the approval gate, if any. */
  pausedAt: PlanStep | null;
  /** True when a budget ran out and the case must go to a person. */
  budgetExhausted: boolean;
};

/**
 * Walk the plan: execute → on failure, replan around the dead tool → continue.
 *
 * Reaching the approval gate is not a failure. The step is marked
 * `awaiting_approval`, the loop stops, and the stored plan lets the run resume
 * at exactly that step once a human decides. Exhausting a budget is also not a
 * failure: it routes to a person with the reason attached, never to a loop.
 */
async function executePlan(
  initial: Plan,
  ctx: ToolContext,
  meta: {
    orderNo: string;
    issueType: string;
    claimId: string;
    userId: string;
    facts: Record<string, unknown>;
  },
): Promise<PlanExecution> {
  let plan = initial;
  let stepsUsed = 0;
  let replansUsed = 0;
  const done: PlanStep[] = [];

  // Results from earlier steps, so a later step can reference them.
  const results: Record<string, unknown> = {};
  const substitute = (args: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      // The planner writes "$order_no" and the like; fill them from the facts.
      if (typeof v === "string" && v.startsWith("$")) {
        const key = v.slice(1);
        out[k] = meta.facts[key] ?? results[key] ?? v;
      } else {
        out[k] = v;
      }
    }
    // The order and issue type are always known, whatever the planner wrote.
    if ("order_no" in out && !out.order_no) out.order_no = meta.orderNo;
    if ("issue_type" in out && !out.issue_type) out.issue_type = meta.issueType;
    return out;
  };

  let guard = 0;
  while (guard++ < MAX_STEPS + MAX_REPLANS + 2) {
    const next = plan.steps.find(
      (s) => s.status === "pending" || s.status === "running",
    );
    if (!next) break;

    if (stepsUsed >= MAX_STEPS) {
      await emit({
        type: "agent.budget_exhausted",
        actor: "Orchestrator",
        summary: `Step budget of ${MAX_STEPS} exhausted — routing to a human rather than looping`,
        payload: { stepsUsed, replansUsed },
        claimId: meta.claimId, userId: meta.userId,
      });
      return { plan, stepsUsed, replansUsed, pausedAt: null, budgetExhausted: true };
    }

    next.status = "running";
    stepsUsed += 1;

    await emit({
      type: "agent.plan_step_started",
      actor: AGENT_FOR_TOOL[next.tool] ?? "Orchestrator",
      summary: `Step ${next.id}/${plan.steps.length}: ${next.title} — ${next.why}`,
      payload: { stepId: next.id, tool: next.tool, args: next.args },
      claimId: meta.claimId, userId: meta.userId,
    });

    const outcome = await runStep(next, ctx, substitute);

    // The approval gate. Stop cleanly; the stored plan resumes it later.
    if (outcome.paused) {
      await emit({
        type: "agent.paused",
        actor: "Orchestrator",
        summary: `Paused at step ${next.id} (${next.tool}) — it needs operator approval`,
        payload: { stepId: next.id, tool: next.tool },
        claimId: meta.claimId, userId: meta.userId,
      });
      return { plan, stepsUsed, replansUsed, pausedAt: next, budgetExhausted: false };
    }

    if (outcome.result?.ok) {
      done.push(next);
      results[next.tool] = outcome.result.data;
      continue;
    }

    // Pseudo-steps are handled by the caller, so they are simply complete.
    if (next.tool.startsWith("__")) {
      next.status = "done";
      done.push(next);
      continue;
    }

    // A real failure. Replan around the tool, if the budget allows.
    if (replansUsed >= MAX_REPLANS) {
      await emit({
        type: "agent.budget_exhausted",
        actor: "Orchestrator",
        summary:
          `${next.tool} failed and the replan budget of ${MAX_REPLANS} is spent — ` +
          "routing to a human",
        payload: { failedTool: next.tool, stepsUsed, replansUsed },
        claimId: meta.claimId, userId: meta.userId,
      });
      return { plan, stepsUsed, replansUsed, pausedAt: null, budgetExhausted: true };
    }

    replansUsed += 1;
    const failure = outcome.result?.ok === false ? outcome.result.error : "unknown failure";
    const rewritten = await replan(
      plan, failure, next.tool, done, meta.facts, CLAIM_PLAN_TOOLS,
      { orderNo: meta.orderNo, issueType: meta.issueType, claimId: meta.claimId, userId: meta.userId },
    );

    // Keep the completed steps visible, then the new route after them.
    plan = {
      ...rewritten,
      steps: [
        ...done.map((s) => ({ ...s })),
        { ...next, status: "failed" as const },
        ...rewritten.steps.map((s, i) => ({ ...s, id: done.length + 2 + i })),
      ],
    };
  }

  return { plan, stepsUsed, replansUsed, pausedAt: null, budgetExhausted: false };
}

/**
 * Open and fully process a claim. Everything up to the approval gate happens
 * in one pass, because a customer who has just reported a broken product
 * should not be made to wait on a queue to find out they were heard.
 */
export async function openClaim(input: {
  userId: string;
  orderNo: string;
  complaint: string;
  lang?: string;
  inputMode?: "text" | "voice";
  audio?: { buffer: Buffer; filename: string } | null;
  evidence?: EvidenceUpload[];
}): Promise<ClaimOutcome> {
  await connectDb();
  const nowAt = await now();
  let degraded = false;

  const order = await Order.findOne({ orderNo: input.orderNo }).lean<LeanOrder>();
  if (!order) throw new Error(`No order ${input.orderNo}`);
  if (String(order.userId) !== String(input.userId)) {
    throw new Error("That order belongs to a different buyer.");
  }

  const buyer = await User.findById(input.userId).lean<LeanUser>();
  if (!buyer) throw new Error("Buyer not found.");

  const item = order.items[0];
  const policy = await Policy.findOne({ policyId: item.policyId }).lean<LeanPolicy>();
  if (!policy) throw new Error(`Policy ${item.policyId} is missing.`);

  /* ── 1. Voice, if that is how it arrived ──────────────────────────── */

  let complaintText = input.complaint?.trim() ?? "";
  let voiceTranscript = "";

  if (input.audio) {
    const t = await transcribe(input.audio.buffer, input.audio.filename);
    if (t) {
      voiceTranscript = t.text;
      if (!complaintText) complaintText = t.text;
    } else {
      degraded = true;
    }
  }

  if (!complaintText) {
    throw new Error(
      "We could not make out the complaint. Please type what went wrong, in any language.",
    );
  }

  const claimNo = `CLM-${nanoid(8).toUpperCase()}`;

  const claim = await Claim.create({
    claimNo,
    orderId: order._id,
    userId: input.userId,
    sku: item.sku,
    rawComplaint: complaintText,
    lang: input.lang ?? buyer.lang ?? "en",
    inputMode: input.inputMode ?? (input.audio ? "voice" : "text"),
    voiceTranscript,
    state: "INTAKE",
    evidence: (input.evidence ?? []).map((e) => ({
      kind: e.kind,
      filename: e.filename,
      mimeType: e.mimeType,
      bytes: e.bytes,
      dataUrl: e.dataUrl,
      caption: e.caption ?? "",
      uploadedAt: nowAt,
    })),
  });

  await emit({
    type: "claim.opened",
    actor: "buyer",
    summary: `${claimNo} opened on ${order.orderNo}: "${truncate(complaintText, 110)}"`,
    payload: { claimNo, orderNo: order.orderNo, inputMode: claim.inputMode, evidenceCount: claim.evidence.length },
    claimId: claim._id,
    orderId: order._id,
    userId: input.userId,
  });

  if (voiceTranscript) {
    await emit({
      type: "claim.voice_transcribed",
      actor: "TriageAgent",
      summary: `Voice note transcribed: "${truncate(voiceTranscript, 110)}"`,
      payload: { transcript: voiceTranscript },
      claimId: claim._id, orderId: order._id, userId: input.userId,
    });
  }

  /* ── 2. Triage: what kind of problem is this, in what language ───── */

  const t = await triage(complaintText);
  if (t.degraded) degraded = true;

  await transitionClaim(
    claimNo,
    "TRIAGED",
    {
      issueType: t.issueType,
      triageConfidence: t.confidence,
      lang: t.lang,
      translatedComplaint: t.translated,
      evidenceFlags: t.evidenceFlags,
    },
    { actor: "TriageAgent", reason: `classified ${t.issueType}` },
  );

  await emit({
    type: "claim.triaged",
    actor: "TriageAgent",
    summary:
      `Classified as ${t.issueType} (${Math.round(t.confidence * 100)}% confident)` +
      (t.secondaryIssue ? `, secondary ${t.secondaryIssue}` : "") +
      (t.degraded ? " — keyword path, model unavailable" : ""),
    payload: { ...t },
    claimId: claim._id, orderId: order._id, userId: input.userId,
  });

  if (t.lang !== "en") {
    await emit({
      type: "claim.translated",
      actor: "TriageAgent",
      summary: `Translated from ${t.lang}: "${truncate(t.translated, 110)}"`,
      payload: { lang: t.lang, translated: t.translated },
      claimId: claim._id, orderId: order._id, userId: input.userId,
    });
  }

  /* ── 3. Plan, before gathering anything ──────────────────────────── */

  // The plan is written first and stored, so the operator sees the route the
  // agent intended to take — including when a tool dies and it has to rewrite
  // it. Steps then execute through the registry, so the mandate and the
  // approval gate apply whether a step came from the planner or the fallback.
  const chaos = await chaosState();
  const ctx: ToolContext = {
    userId: input.userId,
    agent: "Orchestrator",
    brokenTool: await brokenTool(),
    slowTool: Object.entries(chaos).find(([, m]) => m === "slow")?.[0],
  };

  const goal =
    `Resolve a ${t.issueType} complaint on ${order.orderNo} (${item.title}, ` +
    `Rs ${order.amountInr}) and recover whatever the buyer is entitled to under policy.`;

  const facts = {
    order_no: order.orderNo,
    issue_type: t.issueType,
    amount_inr: order.amountInr,
    payment_mode: order.paymentMode,
    delivered_at: order.deliveredAt,
    promised_by: order.promisedBy,
    category: item.category,
    policy_id: item.policyId,
    buyer_lang: t.lang,
    evidence_count: claim.evidence.length,
  };

  let plan = await makePlan(goal, facts, CLAIM_PLAN_TOOLS, {
    orderNo: order.orderNo,
    issueType: t.issueType,
    claimId: String(claim._id),
    userId: input.userId,
  });
  if (plan.source !== "model") degraded = true;

  const execution = await executePlan(plan, ctx, {
    orderNo: order.orderNo,
    issueType: t.issueType,
    claimId: String(claim._id),
    userId: input.userId,
    facts,
  });
  plan = execution.plan;

  await Claim.updateOne(
    { _id: claim._id },
    {
      $set: {
        plan: { goal: plan.goal, source: plan.source, steps: plan.steps },
        stepsUsed: execution.stepsUsed,
        replansUsed: execution.replansUsed,
      },
    },
  );

  /* ── 4. The courier record: does it corroborate the story? ───────── */

  const flags: EvidenceFlags = { ...t.evidenceFlags };
  const shipment = await Shipment.findOne({ orderId: order._id }).lean<LeanShipment>();

  if (shipment) {
    const delivered = (shipment.scans ?? []).some((s) => s.code === "DELIVERED");
    if (t.issueType === "NOT_DELIVERED") {
      if (!delivered) {
        flags.tracking_corroborates = true;
        flags.no_delivery_scan = true;
      } else {
        // The courier says delivered, the buyer says it never came. Both may be
        // telling the truth — that is exactly what a human should look at.
        flags.conflicting_evidence = true;
      }
    } else if (t.issueType === "LATE") {
      const late = order.deliveredAt && order.promisedBy && order.deliveredAt > order.promisedBy;
      if (late) {
        flags.tracking_corroborates = true;
        flags.late_scan = true;
      } else {
        flags.conflicting_evidence = true;
      }
    } else if (delivered) {
      flags.tracking_corroborates = true;
    }
  }

  /* ── 5. Look at the proof ────────────────────────────────────────── */

  const visionFindings: (VisionFindings & { filename: string })[] = [];
  const images = claim.evidence.filter((e: { kind: string }) => e.kind === "image") as unknown as LeanEvidence[];

  if (images.length) flags.photo = true;

  for (const img of images.slice(0, 3)) {
    const findings = await seeImage(img.dataUrl, t.translated, item.title);
    if (!findings) {
      degraded = true;
      continue;
    }

    visionFindings.push({ ...findings, filename: img.filename });

    if (findings.matchesClaim === "supports" && findings.defectVisible) {
      flags.image_supports_claim = true;
    } else if (findings.matchesClaim === "contradicts") {
      flags.image_contradicts_claim = true;
    }
    if (findings.looksLikeScreenshot || findings.looksLikeStockPhoto) {
      flags.metadata_suspect = true;
    }
    if (t.issueType === "WRONG_ITEM" && findings.describesProduct) {
      const described = findings.describesProduct.toLowerCase();
      const ordered = item.title.toLowerCase();
      const overlap = ordered.split(/\s+/).filter((w) => w.length > 3 && described.includes(w));
      if (overlap.length === 0) flags.sku_mismatch = true;
    }

    await Claim.updateOne(
      { _id: claim._id, "evidence.filename": img.filename },
      { $set: { "evidence.$.visionFindings": findings } },
    );

    await emit({
      type: "claim.vision_analysed",
      actor: "FraudAnalyst",
      summary:
        `Photo ${img.filename}: ${findings.defectVisible ? `${findings.defectSeverity} ${findings.defectKind}` : "no visible defect"} — ` +
        `${findings.matchesClaim} the complaint`,
      payload: { filename: img.filename, findings },
      claimId: claim._id, orderId: order._id, userId: input.userId,
    });
  }

  await Claim.updateOne({ _id: claim._id }, { $set: { evidenceFlags: flags } });

  /* ── 6. Is the allegation genuine? (advisory, never decisive) ────── */

  const seller = await Seller.findOne({ sellerId: item.sellerId }).lean();
  const orderCount = await Order.countDocuments({ userId: input.userId });

  const minutesSinceDelivery = order.deliveredAt
    ? (nowAt.getTime() - new Date(order.deliveredAt).getTime()) / 60_000
    : null;
  const windowFraction = order.deliveredAt
    ? (nowAt.getTime() - new Date(order.deliveredAt).getTime()) /
      (policy.returnWindowDays * 86_400_000)
    : null;

  // Cross-order history. The per-claim signals above cannot see a pattern, and
  // refund abuse is a pattern - so this is read here and passed in, rather
  // than the engine reaching for a database it must not know about.
  const history = await claimHistory(
    String(input.userId),
    String(order._id),
    String(claim._id),
    t.issueType,
    nowAt,
  );

  const authenticity = assessAuthenticity({
    issueType: t.issueType,
    evidenceFlags: flags,
    hasImage: images.length > 0,
    minutesSinceDelivery,
    windowFraction,
    orderAmountInr: order.amountInr,
    buyerTotalClaims: buyer.totalClaims ?? 0,
    buyerRejectedClaims: buyer.rejectedClaims ?? 0,
    buyerOrderCount: orderCount,
    sellerDefectRatePct: seller?.defectRatePct ?? 0,
    ...history,
  });

  await Claim.updateOne({ _id: claim._id }, { $set: { authenticity } });
  await emit({
    type: "claim.authenticity_assessed",
    actor: "FraudAnalyst",
    summary: `${authenticity.verdict.replace(/_/g, " ")} — suspicion ${authenticity.score}/100`,
    payload: authenticity,
    claimId: claim._id, orderId: order._id, userId: input.userId,
  });

  /* ── 7. Adjudicate. The engine decides, not the model. ──────────── */

  const verdict = checkEntitlement(
    {
      amountInr: order.amountInr,
      deliveredAt: order.deliveredAt,
      promisedBy: order.promisedBy,
      stockAvailable: order.stockAvailable,
      // The complaint wins only when it voiced a preference; otherwise the
      // buyer's stored profile stands.
      buyerPriority: (t.buyerPriority ?? order.buyerPriority ?? "money") as "speed" | "money",
    },
    {
      returnWindowDays: policy.returnWindowDays,
      replacementAllowed: policy.replacementAllowed,
      refundSlaDays: policy.refundSlaDays,
      lateCompensation: policy.lateCompensation,
      clauses: policy.clauses as { id: string; text: string; tags: string[] }[],
    },
    t.issueType,
    flags,
    nowAt,
  );

  await emit({
    type: "claim.adjudicated",
    // The engine, not the model that fetched the clauses. `checkEntitlement`
    // is a pure function and this is the event that records a refund amount —
    // crediting it to a language model misstates who decided the money, which
    // is the one thing the audit trail exists to be clear about.
    actor: "EntitlementEngine",
    summary:
      verdict.eligible
        ? `Eligible: ${verdict.remedy.replace(/_/g, " ")}${verdict.amountInr > 0 ? ` ₹${verdict.amountInr}` : ""} (confidence ${verdict.confidence})`
        : `Not eligible: ${verdict.remedy.replace(/_/g, " ")} (confidence ${verdict.confidence})`,
    payload: verdict,
    claimId: claim._id, orderId: order._id, userId: input.userId,
  });

  /* ── 8. Write the letter, then check it ─────────────────────────── */

  const { draft, verified, notes, usedTemplate, rejectedDrafts } = await draftAndVerify({
    buyerName: buyer.name,
    orderNo: order.orderNo,
    productTitle: item.title,
    issueType: t.issueType,
    complaint: t.translated,
    lang: t.lang,
    verdict,
    policyClauses: policy.clauses as { id: string; text: string; tags: string[] }[],
    sabotageFirstDraft: await ungroundedDraft(),
  });
  if (usedTemplate) degraded = true;

  await emit({
    type: verified ? "claim.draft_verified" : "claim.draft_rejected",
    actor: verified ? "VerifierAgent" : "VerifierAgent",
    summary: verified
      ? `Draft passed grounding and arithmetic checks${usedTemplate ? " (template path)" : ""}`
      : `Draft rejected: ${notes.join("; ")}`,
    payload: { draft, notes, usedTemplate },
    claimId: claim._id, orderId: order._id, userId: input.userId,
  });

  /* ── 9. Decide where the case goes ──────────────────────────────── */

  const needsHuman =
    verdict.remedy === "ESCALATE_AMBIGUOUS" ||
    flags.conflicting_evidence === true ||
    authenticity.verdict === "LIKELY_FABRICATED" ||
    // A run that spent its step or replan budget has stopped making progress.
    // Handing it to a person is the designed outcome, not an error path.
    execution.budgetExhausted;

  const state = needsHuman ? "HUMAN_HANDOFF" : "AWAITING_APPROVAL";

  const requestedAction = verdict.eligible
    ? `${verdict.remedy.replace(/_/g, " ").toLowerCase()}${verdict.amountInr > 0 ? ` of ₹${verdict.amountInr}` : ""} to ${buyer.name}`
    : `decline the claim and send the explanation to ${buyer.name}`;

  // TRIAGED -> ADJUDICATED -> (AWAITING_APPROVAL | HUMAN_HANDOFF). The engine
  // verdict is recorded on the adjudication step, so the state machine shows
  // that the decision existed before anything was queued for a human.
  await transitionClaim(
    claimNo,
    "ADJUDICATED",
    {
      verdict: { ...verdict, deadlineAt: verdict.deadlineAt ? new Date(verdict.deadlineAt) : null },
      draftMessage: draft,
      draftVerified: verified,
      verifierNotes: notes,
      deadlineAt: verdict.deadlineAt ? new Date(verdict.deadlineAt) : null,
    },
    { actor: "PolicyAgent", reason: `${verdict.remedy} by the rule engine` },
  );

  await transitionClaim(
    claimNo,
    state,
    {
      "approval.required": true,
      "approval.requestedAction": requestedAction,
    },
    {
      actor: needsHuman ? "Orchestrator" : "ActionAgent",
      reason: needsHuman ? "routed to a human" : "queued at the approval gate",
    },
  );

  await User.updateOne({ _id: input.userId }, { $inc: { totalClaims: 1 } });

  if (needsHuman) {
    await emit({
      type: "claim.handoff",
      actor: "Orchestrator",
      summary:
        execution.budgetExhausted
          ? `Routed to a human: the run spent its budget (${execution.stepsUsed} steps, ` +
            `${execution.replansUsed} replans) without reaching a decision`
          : verdict.remedy === "ESCALATE_AMBIGUOUS"
            ? `Routed to a human: engine confidence ${verdict.confidence} is below the acting threshold`
            : flags.conflicting_evidence
              ? "Routed to a human: the courier record and the complaint disagree"
              : "Routed to a human: the evidence does not support the allegation, and only a person may say so",
      payload: { verdict, authenticity, flags, budget: { stepsUsed: execution.stepsUsed, replansUsed: execution.replansUsed } },
      claimId: claim._id, orderId: order._id, userId: input.userId,
    });
  } else {
    await emit({
      type: "claim.approval_requested",
      actor: "ActionAgent",
      summary: `Waiting at the approval gate: ${requestedAction}`,
      payload: { requestedAction, verdict, authenticity },
      claimId: claim._id, orderId: order._id, userId: input.userId,
    });
  }

  /* ── 10. Tell the buyer we have it, and tell the operator to look ── */

  const ack = claimReceived({
    name: buyer.name,
    claimNo,
    orderNo: order.orderNo,
    issueType: t.issueType,
    originalText: complaintText,
    lang: t.lang,
  });
  await sendMail({
    to: buyer.email, subject: ack.subject, html: ack.html,
    template: "claim_received", claimId: String(claim._id), orderId: String(order._id),
  });

  const ops = operatorApproval({
    claimNo,
    orderNo: order.orderNo,
    buyerName: buyer.name,
    issueType: t.issueType,
    remedy: verdict.remedy,
    amountInr: verdict.amountInr,
    confidence: verdict.confidence,
    authenticityVerdict: authenticity.verdict,
    authenticityScore: authenticity.score,
    topSignals: authenticity.signals.slice(0, 4).map((s) => s.detail),
    originalText: complaintText,
    lang: t.lang,
    requestedAction,
    evidenceCount: claim.evidence.length,
  });
  await sendMail({
    to: env.mail.ops, subject: ops.subject, html: ops.html,
    template: "operator_approval", claimId: String(claim._id), orderId: String(order._id),
  });

  return {
    claimNo,
    state,
    triage: t,
    verdict,
    authenticity,
    draft,
    draftVerified: verified,
    verifierNotes: notes,
    rejectedDrafts,
    visionFindings,
    degraded,
    plan: { goal: plan.goal, source: plan.source, steps: plan.steps },
    budget: {
      stepsUsed: execution.stepsUsed,
      replansUsed: execution.replansUsed,
      exhausted: execution.budgetExhausted,
    },
  };
}

/* ───────────────────── Drafting with a verifier loop ───────────────────── */

const DRAFT_SYSTEM = `You write the letter a customer receives about their complaint.

YOU ARE GIVEN A VERDICT FROM A RULE ENGINE. It is authoritative and final.

ABSOLUTE RULES
- Use ONLY the amount, deadline date, remedy and clause ids given to you. Never compute, round, estimate or restate any of them differently.
- If an amount is given, state it exactly once, as a rupee figure.
- If a deadline is given, state it exactly as the YYYY-MM-DD date provided.
- Cite only the clause ids provided. Never invent a clause id.
- Never say money has already been sent, refunded or credited. Nothing has happened yet; an operator still has to approve it.
- If the verdict is not eligible, do not use the word "approved", and do not offer any remedy.

TONE
- Write to a person who has lost money and time. Plain, warm, specific. No corporate padding, no apology theatre.
- 90 to 150 words. Greet them by name, say what you found, say what happens next, sign off as "Vaanijya Resolutions".
- Write in English. A translation is handled separately.`;


/**
 * The brief with the authoritative verdict removed.
 *
 * Used only by the chaos mode: without the numbers and clause ids the model
 * has nothing to ground its prose in, so it invents a goodwill gesture and a
 * turnaround date — exactly what the verifier exists to catch.
 */
function briefWithoutVerdict(brief: string): string {
  const i = brief.indexOf("ENGINE VERDICT");
  return i === -1 ? brief : brief.slice(0, i).trimEnd();
}

async function draftAndVerify(p: {
  buyerName: string;
  orderNo: string;
  productTitle: string;
  issueType: IssueType;
  complaint: string;
  lang: string;
  verdict: Verdict;
  policyClauses: { id: string; text: string; tags: string[] }[];
  /** Chaos: make the first draft omit its citations, so the verifier bins it. */
  sabotageFirstDraft?: boolean;
}): Promise<{
  draft: string; verified: boolean; notes: string[];
  usedTemplate: boolean; rejectedDrafts: number;
}> {
  const clauseIds = p.policyClauses.map((c) => c.id);
  const citedText = p.policyClauses
    .filter((c) => p.verdict.clauseIds.includes(c.id))
    .map((c) => `${c.id}: ${c.text}`)
    .join("\n");

  const brief = [
    `Buyer name: ${p.buyerName}`,
    `Order: ${p.orderNo}`,
    `Product: ${p.productTitle}`,
    `What they reported: ${p.complaint}`,
    `Issue type: ${p.issueType}`,
    "",
    "ENGINE VERDICT (authoritative):",
    `  eligible: ${p.verdict.eligible}`,
    `  remedy: ${p.verdict.remedy}`,
    `  amount_inr: ${p.verdict.amountInr}`,
    `  deadline: ${p.verdict.deadlineAt ? p.verdict.deadlineAt.slice(0, 10) : "none"}`,
    `  clause_ids: ${p.verdict.clauseIds.join(", ") || "none"}`,
    `  reasons: ${p.verdict.reasons.join(" | ")}`,
    "",
    citedText ? `CLAUSE TEXT YOU MAY RELY ON:\n${citedText}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Up to two attempts: if the verifier catches something, the model is told
  // exactly what and gets one more go. A third attempt is not worth the latency
  // when a grounded template is sitting right there.
  let lastNotes: string[] = [];
  let rejectedDrafts = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    // Chaos mode strips the grounding instructions on the FIRST attempt only,
    // so the verifier rejects the agent's own draft on screen and the agent
    // then revises it. That visible self-correction is the point of the mode.
    const sabotage = p.sabotageFirstDraft === true && attempt === 0;

    const messages = [
      {
        role: "system" as const,
        content: sabotage
          ? "You write the letter a customer receives about their complaint. " +
            "Be warm and reassuring. Mention a goodwill gesture and a likely " +
            "turnaround time in your own words."
          : DRAFT_SYSTEM,
      },
      { role: "user" as const, content: sabotage ? briefWithoutVerdict(brief) : brief },
      ...(attempt > 0
        ? [
            {
              role: "user" as const,
              content:
                `Your previous draft was rejected by the verifier for these reasons:\n` +
                lastNotes.map((n) => `- ${n}`).join("\n") +
                `\nWrite it again, fixing exactly those problems.`,
            },
          ]
        : []),
    ];

    const res = await chat(messages, { temperature: 0.4, maxTokens: 500 });
    if (!res.ok || !res.content.trim()) break;

    const check = verifyDraft(res.content, p.verdict, clauseIds);
    if (check.passed) {
      return {
        draft: res.content.trim(), verified: true, notes: [],
        usedTemplate: false, rejectedDrafts,
      };
    }

    rejectedDrafts += 1;
    lastNotes = check.notes;

    // Emit the rejection, so the operator sees the verifier doing its job
    // rather than only seeing the draft that eventually survived.
    await emit({
      type: "claim.draft_rejected",
      actor: "VerifierAgent",
      summary:
        `Draft ${attempt + 1} rejected: ${check.notes.join("; ")}` +
        (attempt === 0 ? " — sending it back to be rewritten" : ""),
      payload: {
        attempt: attempt + 1,
        notes: check.notes,
        rejectedDraft: res.content.slice(0, 1200),
      },
    });
  }

  // Fall back to the template: grounded by construction, so it passes.
  const tpl = templateDraft({
    buyerName: p.buyerName,
    orderNo: p.orderNo,
    productTitle: p.productTitle,
    issueType: p.issueType,
    verdict: p.verdict,
  });
  const check = verifyDraft(tpl, p.verdict, clauseIds);

  return {
    draft: tpl,
    rejectedDrafts,
    verified: check.passed,
    notes: lastNotes.length
      ? [...lastNotes, "fell back to the grounded template after the model draft was rejected"]
      : check.notes,
    usedTemplate: true,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}


/**
 * A buyer's claim history, in the shape the fraud analyst scores.
 *
 * Read here rather than inside the engine, which is pure and has no database.
 * Everything returned is a count of what already happened, so the same inputs
 * always produce the same assessment - a verdict stays reproducible months
 * later, which is the whole reason the engine is pure in the first place.
 *
 * Note which claims are counted. A REJECTED claim is history (the buyer filed
 * something unsupported), but an upheld claim is not held against them: a buyer
 * who was genuinely wronged three times is not a fraudster, and treating them
 * as one is how a platform loses its honest customers.
 */
async function claimHistory(
  userId: string,
  orderId: string,
  /** The claim being assessed, excluded by identity rather than by state. */
  currentClaimId: string,
  issueType: string,
  nowAt: Date,
): Promise<{
  priorClaimsOnThisOrder: number;
  claimsLast30Days: number;
  sameIssueTypeCount: number;
  refundedToBuyerInr: number;
  buyerLifetimeSpendInr: number;
}> {
  await connectDb();
  const since = new Date(nowAt.getTime() - 30 * 86_400_000);

  // Exclude the claim being assessed by its own id. It is already in the
  // collection by the time this runs, and excluding it by state instead was a
  // real bug: the claim advances past INTAKE before assessment, so it counted
  // itself and every genuine first claim scored +26 for being a repeat.
  const others = await Claim.find({ userId, _id: { $ne: currentClaimId } })
    .select("orderId issueType state verdict createdAt")
    .lean<
      {
        orderId: mongoose.Types.ObjectId;
        issueType: string | null;
        state: string;
        verdict: { amountInr: number };
        createdAt: Date;
      }[]
    >();

  const refundedAgg = await Claim.aggregate<{ total: number }>([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        state: "RESOLVED",
        _id: { $ne: new mongoose.Types.ObjectId(currentClaimId) },
      },
    },
    { $group: { _id: null, total: { $sum: "$verdict.amountInr" } } },
  ]);

  const spendAgg = await Order.aggregate<{ total: number }>([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        status: { $nin: ["CANCELLED", "RTO"] },
      },
    },
    { $group: { _id: null, total: { $sum: "$amountInr" } } },
  ]);

  return {
    priorClaimsOnThisOrder: others.filter((c) => String(c.orderId) === orderId).length,
    claimsLast30Days: others.filter((c) => new Date(c.createdAt) >= since).length,
    sameIssueTypeCount: others.filter((c) => c.issueType === issueType).length,
    refundedToBuyerInr: refundedAgg[0]?.total ?? 0,
    buyerLifetimeSpendInr: spendAgg[0]?.total ?? 0,
  };
}
