/**
 * The eval runner.
 *
 * Runs each scenario against the real pipeline — `openClaim`, the registry,
 * the engines, the watcher — not against mocks. A pass therefore means the
 * behaviour holds in the system a buyer actually touches.
 *
 * It reseeds first, because an eval suite whose result depends on what the last
 * person clicked is not a regression suite.
 */
import { connectDb } from "@/lib/db/connect";
import { Claim, Order, Shipment, User } from "@/models";
import type { LeanClaim, LeanOrder, LeanUser } from "@/models";
import { rescueOrder } from "@/lib/agent/rescue";
import { openClaim } from "@/lib/agent/claims";
import { decideClaim } from "@/lib/agent/approval";
import { tick } from "@/lib/agent/watcher";
import { callTool } from "@/lib/agent/tools";
import { seed } from "@/lib/seed";
import { advanceMs, resetClock, setBrokenTool } from "@/lib/clock";
import { readEvents } from "@/lib/events";
import { env } from "@/lib/env";
import {
  SCENARIOS, type EvalReport, type Scenario, type ScenarioResult,
} from "@/lib/evals";

/** A 1x1 PNG, so the evidence path is exercised without shipping a fixture. */
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export async function runEvals(only?: number[]): Promise<EvalReport> {
  const startedAt = new Date();
  await connectDb();

  // Fresh state, so results are reproducible. `force` because the suite is
  // destructive by design and the test setup guarantees a throwaway
  // in-process database; the Evals tab is operator-only and refuses in
  // production through the same guard.
  await seed({ force: true });
  await resetClock();
  await setBrokenTool("");

  const chosen = only?.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
  const results: ScenarioResult[] = [];

  for (const sc of chosen) {
    const t0 = Date.now();
    try {
      results.push({ ...(await runOne(sc)), ms: Date.now() - t0 });
    } catch (err) {
      results.push({
        id: sc.id, name: sc.name, kind: sc.kind,
        status: "ERROR", checks: [], observed: {},
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - t0,
      });
    }
    // Scenarios must not leak state into each other.
    await setBrokenTool("");
    await resetClock();
  }

  return {
    ran: results.length,
    passed: results.filter((r) => r.status === "PASS").length,
    failed: results.filter((r) => r.status === "FAIL").length,
    knownLimits: results.filter((r) => r.status === "KNOWN LIMIT").length,
    errors: results.filter((r) => r.status === "ERROR").length,
    results,
    degraded: !env.groq.enabled,
    startedAt: startedAt.toISOString(),
    ms: Date.now() - startedAt.getTime(),
  };
}

async function runOne(sc: Scenario): Promise<Omit<ScenarioResult, "ms">> {
  const checks: ScenarioResult["checks"] = [];
  const observed: Record<string, unknown> = {};
  const check = (label: string, ok: boolean, detail = "") =>
    checks.push({ label, ok, detail });

  /* ── Rescue scenarios: the proactive agent, no claim involved ────── */

  if (sc.kind === "rescue") {
    const order = await Order.findOne({ orderNo: sc.orderNo }).lean<LeanOrder>();
    if (!order) throw new Error(`scenario ${sc.id}: no order ${sc.orderNo}`);

    // Put the shipment and the rescue counters in the exact state the
    // scenario describes. Set explicitly rather than inherited, because an
    // eval that depends on what an earlier scenario left behind is not a
    // regression test.
    await Shipment.updateOne(
      { orderId: order._id },
      {
        $set: {
          attempts: sc.rescue?.attempts ?? 0,
          phoneReachable: sc.rescue?.phoneReachable ?? true,
        },
      },
    );
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          rescueAttempts: sc.rescue?.attemptsMade ?? 0,
          rescueActions: sc.rescue?.actionsTaken ?? [],
          rescueState: "NONE",
          rescueBaselineScore: null,
        },
      },
    );

    const run = await rescueOrder(sc.orderNo!, { humanPresent: false });
    const a = run.assessment;

    observed.decision = a.decision;
    observed.triggers = a.triggers;
    observed.riskScore = a.risk.score;
    observed.riskBand = a.risk.band;
    observed.runwayDays = a.runwayDays;
    observed.action = a.intervention?.action ?? null;
    observed.needsApproval = a.intervention?.needsApproval ?? null;
    observed.steps = run.steps.map((x) => `${x.action}:${x.outcome}`);
    observed.state = run.state;
    observed.reasons = a.reasons;

    const e = sc.expect;

    if (e.rescueDecision !== undefined) {
      check(
        `decides ${e.rescueDecision}`,
        a.decision === e.rescueDecision,
        `decided ${a.decision}` + (a.handoffReason ? ` — ${a.handoffReason}` : ""),
      );
    }

    if (e.rescueTrigger !== undefined) {
      check(
        `${e.rescueTrigger} fired`,
        a.triggers.includes(e.rescueTrigger as never),
        a.triggers.length ? a.triggers.join(", ") : "no trigger fired",
      );
    }

    if (e.rescueAction !== undefined) {
      const got = a.intervention?.action ?? null;
      check(
        e.rescueAction === null ? "proposes no action" : `proposes ${e.rescueAction}`,
        got === e.rescueAction,
        got === null ? "declined to act" : `proposed ${got}`,
      );
    }

    if (e.rescueNeedsApproval !== undefined) {
      check(
        e.rescueNeedsApproval
          ? "the proposed action stops at the approval gate"
          : "the proposed action is reversible and may run unapproved",
        (a.intervention?.needsApproval ?? false) === e.rescueNeedsApproval,
        `needsApproval=${a.intervention?.needsApproval ?? "n/a"}`,
      );
    }

    if (e.rescueExecuted !== undefined) {
      const executed = run.steps.some((x) => x.outcome === "executed");
      check(
        e.rescueExecuted
          ? "executed the intervention itself"
          : "executed nothing itself",
        executed === e.rescueExecuted,
        run.steps.length ? run.steps.map((x) => `${x.action}:${x.outcome}`).join(", ") : "no steps",
      );
    }

    // Asserted on EVERY rescue scenario, not only the ones about authority:
    // the rescue agent must never have moved money or placed an order,
    // whatever it decided.
    const refund = await callTool(
      "issue_refund",
      { order_no: sc.orderNo, amount_inr: 1 },
      { userId: String(order.userId), agent: "RiskAgent" },
    );
    check(
      "the rescue agent cannot move money",
      refund.ok === false,
      refund.ok ? "issue_refund SUCCEEDED — the mandate is not enforced" : "refused by the registry",
    );

    // And every point of the score still traces to a named factor, so the
    // intervention is arguable rather than asserted.
    check(
      "every risk point traces to a named factor",
      a.risk.reasons.reduce((n, r) => n + r.points, 0) >= a.risk.score,
      `${a.risk.reasons.length} factors`,
    );

    return finish(sc, checks, observed);
  }

  /* ── Risk scenarios need no claim at all ─────────────────────────── */

  if (sc.kind === "risk") {
    const order = await Order.findOne({ orderNo: sc.orderNo }).lean<LeanOrder>();
    if (!order) throw new Error(`scenario ${sc.id}: no order ${sc.orderNo}`);

    const res = await callTool(
      "risk_score",
      { order_no: sc.orderNo },
      { userId: String(order.userId), agent: "RiskAgent" },
    );
    if (!res.ok) throw new Error(`risk_score failed: ${res.error}`);

    const d = res.data as {
      score: number; band: string;
      intervention: { action: string } | null;
      reasons: { factor: string; points: number }[];
    };
    observed.score = d.score;
    observed.band = d.band;
    observed.intervention = d.intervention?.action ?? null;
    observed.factors = d.reasons.map((r) => `${r.factor} +${r.points}`);

    if (sc.expect.band !== undefined) {
      check(`risk band is ${sc.expect.band}`, d.band === sc.expect.band, `got ${d.band} (${d.score}/100)`);
    }
    if (sc.expect.interventionAction !== undefined) {
      const got = d.intervention?.action ?? null;
      check(
        sc.expect.interventionAction === null
          ? "proposes no intervention"
          : `proposes ${sc.expect.interventionAction}`,
        got === sc.expect.interventionAction,
        got === null ? "declined to act" : `proposed ${got}`,
      );
      // Every point of the score must be traceable to a named factor.
      check(
        "every risk point traces to a named factor",
        d.reasons.reduce((s, r) => s + r.points, 0) >= d.score,
        `${d.reasons.length} factors`,
      );
    }

    return finish(sc, checks, observed);
  }

  /* ── Everything else runs a real claim ───────────────────────────── */

  const buyer = await User.findOne({ email: sc.buyerEmail }).lean<LeanUser>();
  if (!buyer) throw new Error(`scenario ${sc.id}: no buyer ${sc.buyerEmail}`);

  if (sc.breakTool) await setBrokenTool(sc.breakTool);

  const outcome = await openClaim({
    userId: String(buyer._id),
    orderNo: sc.orderNo!,
    complaint: sc.complaint!,
    lang: sc.lang,
    evidence: sc.withPhoto
      ? [{
          kind: "image", filename: `scenario-${sc.id}.png`, mimeType: "image/png",
          bytes: 70, dataUrl: PNG_DATA_URL, caption: "",
        }]
      : [],
  });

  if (sc.breakTool) await setBrokenTool("");

  observed.claimNo = outcome.claimNo;
  observed.issueType = outcome.triage.issueType;
  observed.secondaryIssue = outcome.triage.secondaryIssue;
  observed.lang = outcome.triage.lang;
  observed.remedy = outcome.verdict.remedy;
  observed.eligible = outcome.verdict.eligible;
  observed.amountInr = outcome.verdict.amountInr;
  observed.confidence = outcome.verdict.confidence;
  observed.clauseIds = outcome.verdict.clauseIds;
  observed.state = outcome.state;
  observed.authenticity = outcome.authenticity.verdict;
  observed.suspicion = outcome.authenticity.score;
  observed.planSource = outcome.plan.source;
  observed.planSteps = outcome.plan.steps.map((s) => `${s.tool}:${s.status}`);
  observed.budget = outcome.budget;

  const e = sc.expect;

  if (e.issueType !== undefined) {
    check(`classified ${e.issueType}`, outcome.triage.issueType === e.issueType,
      `got ${outcome.triage.issueType}`);
  }
  if (e.remedy !== undefined) {
    check(`remedy is ${e.remedy}`, outcome.verdict.remedy === e.remedy,
      `got ${outcome.verdict.remedy}`);
  }
  if (e.eligible !== undefined) {
    check(e.eligible ? "found eligible" : "found not eligible",
      outcome.verdict.eligible === e.eligible, `got ${outcome.verdict.eligible}`);
  }
  if (e.amountInr !== undefined) {
    check(`amount is Rs ${e.amountInr}`, outcome.verdict.amountInr === e.amountInr,
      `got Rs ${outcome.verdict.amountInr}`);
  }
  if (e.maxAmountInr !== undefined) {
    check(`amount is capped at Rs ${e.maxAmountInr}`,
      outcome.verdict.amountInr <= e.maxAmountInr, `got Rs ${outcome.verdict.amountInr}`);
  }
  if (e.state !== undefined) {
    check(`routed to ${e.state}`, outcome.state === e.state, `got ${outcome.state}`);
  }
  if (e.clauseMatched !== undefined) {
    check("grounded in a policy clause", outcome.verdict.clauseIds.length > 0,
      outcome.verdict.clauseIds.join(", ") || "no clause matched");
  }
  if (e.reviewRequired !== undefined) {
    check("asks a human rather than deciding against the buyer",
      outcome.authenticity.reviewRequired === e.reviewRequired,
      `${outcome.authenticity.verdict} at ${outcome.authenticity.score}/100`);
  }
  if (e.authenticityVerdict !== undefined) {
    check(`authenticity is ${e.authenticityVerdict}`,
      outcome.authenticity.verdict === e.authenticityVerdict,
      `got ${outcome.authenticity.verdict}`);
  }

  // The invariant that matters most, asserted on every claim scenario.
  const order = await Order.findOne({ orderNo: sc.orderNo }).lean<LeanOrder>();
  check("never pays more than the order was worth",
    outcome.verdict.amountInr <= (order?.amountInr ?? 0),
    `Rs ${outcome.verdict.amountInr} of Rs ${order?.amountInr}`);

  // The letter must always have been checked before it could be sent.
  check("the letter was verified before anyone saw it", outcome.draftVerified === true,
    outcome.verifierNotes.join("; ") || "passed");

  /* ── Chaos: did it notice, and did it route around? ──────────────── */

  if (sc.kind === "chaos") {
    const failed = outcome.plan.steps.some((s) => s.status === "failed");
    const replanned = outcome.budget.replansUsed > 0 || outcome.plan.source.startsWith("replan");
    if (e.toolFailed) {
      check(`${sc.breakTool} failed as injected`, failed,
        outcome.plan.steps.filter((s) => s.status === "failed").map((s) => s.tool).join(",") || "no step failed");
    }
    if (e.replanned) {
      check("the plan rewrote itself without the dead tool", replanned,
        `${outcome.budget.replansUsed} replan(s), source=${outcome.plan.source}`);
    }
    check("the case still reached a decision",
      outcome.verdict.remedy !== "ESCALATE_AMBIGUOUS" || outcome.state === "HUMAN_HANDOFF",
      `${outcome.verdict.remedy} / ${outcome.state}`);
  }

  /* ── Autonomy: approve, breach the deadline, let the watcher run ─── */

  if (sc.kind === "autonomy") {
    const op = await User.findOne({ role: "operator" }).lean<LeanUser>();
    await decideClaim({
      claimNo: outcome.claimNo, approve: true, operatorEmail: op!.email,
    });
    // Put it back into a live, promised state so a deadline can lapse.
    await Claim.updateOne(
      { claimNo: outcome.claimNo },
      { $set: { state: "APPROVED", resolvedAt: null } },
    );

    const before = await readEvents({ limit: 1000 });
    await advanceMs((sc.advanceHours ?? 192) * 3_600_000);
    const result = await tick(false);

    observed.escalated = result.escalated;
    observed.handedOff = result.handedOff;

    const mine = result.escalated.find((x) => x.claimNo === outcome.claimNo);
    const claim = await Claim.findOne({ claimNo: outcome.claimNo }).lean<LeanClaim>();
    observed.finalState = claim?.state;
    observed.tier = claim?.escalationTier;

    if (e.wokeUp !== undefined) {
      check("the watcher found the breach on its own", Boolean(mine),
        mine ? `escalated to T${mine.tier}` : "nothing escalated");
    }
    if (e.escalatedToTier !== undefined) {
      check(`escalated to tier ${e.escalatedToTier}`,
        (claim?.escalationTier ?? 0) >= e.escalatedToTier,
        `tier ${claim?.escalationTier ?? 0}`);
    }
    if (e.humanPresent !== undefined) {
      check("recorded that no human was present",
        result.humanPresent === e.humanPresent, `humanPresent=${result.humanPresent}`);
    }
    // The evidence pack is what makes the escalation actionable.
    const after = await readEvents({ since: before.at(-1)?.seq ?? 0, limit: 200 });
    const escEvent = after.find((x) => x.type === "claim.escalated");
    const pack = (escEvent?.payload as { pack?: { clauseIds?: string[] } } | undefined)?.pack;
    check("assembled an evidence pack with the case facts", Boolean(pack),
      pack ? "pack present" : "no pack on the escalation event");

    await resetClock();
  }

  /* ── Multi-issue: each issue adjudicated, aggregate capped ───────── */

  const multi = outcome.multi;
  const distinct = multi.issues.filter((i) => i.status !== "SUBSUMED");
  const paying = multi.issues.filter((i) => i.payableInr > 0);

  observed.issuesRead = multi.issues.length;
  observed.issuesDistinct = distinct.length;
  observed.issuesPaying = paying.length;
  observed.issueBreakdown = multi.issues.map(
    (i) => `${i.key} ${i.issueType} ${i.status}` + (i.payableInr ? ` Rs${i.payableInr}` : ""),
  );
  observed.totalPayableInr = multi.totalPayableInr;
  observed.uncappedTotalInr = multi.uncappedTotalInr;
  observed.capInr = multi.capInr;

  if (e.issuesDetected !== undefined) {
    // What the splitter read out of the prose, which is the detection claim.
    check(
      `reads ${e.issuesDetected} issues from one complaint`,
      multi.issues.length >= e.issuesDetected,
      `read ${multi.issues.length}: ${multi.issues.map((i) => i.issueType).join(" + ")}`,
    );
  }

  if (e.issuesAdjudicated !== undefined) {
    check(
      `adjudicates ${e.issuesAdjudicated} issue(s) separately`,
      distinct.length === e.issuesAdjudicated,
      `${distinct.length} distinct after the cross-issue rules ` +
        `(${multi.issues.length} read, ${multi.issues.length - distinct.length} subsumed)`,
    );
  }

  if (e.issueTypes !== undefined) {
    const got = multi.issues.map((i) => i.issueType);
    for (const want of e.issueTypes) {
      check(`${want} is one of the adjudicated issues`, got.includes(want as never), got.join(", "));
    }
  }

  if (e.issuesPaying !== undefined) {
    check(
      `${e.issuesPaying} issue(s) carry a cash remedy`,
      paying.length === e.issuesPaying,
      `${paying.length} paying, total Rs ${multi.totalPayableInr}`,
    );
  }

  if (e.expectSubsumed) {
    const subsumed = multi.issues.filter((i) => i.status === "SUBSUMED");
    check(
      "a duplicate allegation is subsumed rather than paid twice",
      subsumed.length > 0,
      subsumed.length
        ? subsumed.map((i) => `${i.issueType} ← ${i.subsumedBy}`).join(", ")
        : "nothing was subsumed",
    );
  }

  // Asserted on every claim scenario that reached adjudication, not only the
  // multi-issue ones: the aggregate across all issues can never exceed the
  // order value, and each issue pays at most what the engine allowed it.
  if (multi.issues.length > 0) {
    check(
      "the aggregate across every issue is within the order value",
      multi.totalPayableInr <= multi.capInr,
      `Rs ${multi.totalPayableInr} of a Rs ${multi.capInr} cap ` +
        `(uncapped Rs ${multi.uncappedTotalInr})`,
    );
    check(
      "no issue pays more than the engine allowed it",
      multi.issues.every((i) => i.payableInr <= i.verdict.amountInr),
      multi.issues
        .map((i) => `${i.issueType} Rs${i.payableInr}/Rs${i.verdict.amountInr}`)
        .join(", "),
    );
  }

  return finish(sc, checks, observed);
}

function finish(
  sc: Scenario,
  checks: ScenarioResult["checks"],
  observed: Record<string, unknown>,
): Omit<ScenarioResult, "ms"> {
  const allPassed = checks.every((c) => c.ok);
  // A scenario we have declared a limitation for is never reported as a pass,
  // and never buried as an ordinary failure.
  const status = sc.knownLimitation ? "KNOWN LIMIT" : allPassed ? "PASS" : "FAIL";
  return {
    id: sc.id, name: sc.name, kind: sc.kind,
    status, checks, observed,
    knownLimitation: sc.knownLimitation,
  };
}
