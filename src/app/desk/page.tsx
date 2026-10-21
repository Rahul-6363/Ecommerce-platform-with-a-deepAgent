"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Shell from "@/components/Shell";
import { useRouter } from "next/navigation";
import {
  api, Banner, Chip, Disclosure, Empty, INR, Ladder, RiskDial,
  Spinner, StateChip, SuspicionBar, Toast, humanise,
} from "@/components/ui";
import PlanTrace, { type PlanShape } from "@/components/PlanTrace";
import EvalPanel from "@/components/EvalPanel";

type Signal = { factor: string; points: number; detail: string };

type Claim = {
  claimNo: string; orderNo: string; productTitle: string; orderAmountInr: number;
  buyerName: string; buyerEmail: string;
  buyerClaimHistory: { total: number; rejected: number; priorRto: number } | null;
  state: string; issueType: string; lang: string; inputMode: string;
  rawComplaint: string; translatedComplaint: string;
  evidenceFlags: Record<string, boolean>;
  verdict: {
    eligible: boolean; remedy: string; amountInr: number; deadlineAt: string | null;
    clauseIds: string[]; reasons: string[]; confidence: number; alternatives: string[];
  };
  authenticity: { verdict: string; score: number; signals: Signal[]; narrative: string; reviewRequired: boolean };
  draftMessage: string; draftVerified: boolean; verifierNotes: string[];
  plan: PlanShape;
  budget: { stepsUsed: number; replansUsed: number; exhausted: boolean };
  approval: { decision: string | null; decidedBy: string; note: string; requestedAction: string };
  deadlineAt: string | null; escalationTier: number;
  evidence: { kind: string; filename: string; dataUrl: string; visionFindings: Record<string, unknown> | null }[];
  createdAt: string;
};

type OrderRow = {
  orderNo: string; buyerName: string; status: string; amountInr: number;
  paymentMode: string; placedByAgent: boolean; promisedBy: string;
  items: { title: string; qty: number }[];
  shipment: { shipmentId: string; courier: string; status: string; attempts: number; riskScore: number | null; riskBand: string | null } | null;
};

type Desk = {
  clock: { simulatedNow: string; realNow: string; offsetDays: number };
  capabilities: Record<string, { status: string; detail: string }>;
  mandate: { agent: string; job: string; usesModel: boolean; unapproved: string; tools: string[] }[];
  brokenTool: string;
  chaos: Record<string, "fail" | "slow">;
  dashboard: Record<string, number>;
  claims: Claim[];
  orders: OrderRow[];
  outbox: { to: string; subject: string; status: string; template: string; sentAt: string; html: string }[];
  sellers: SellerStanding[];
  refunds: RefundRow[];
};

type SellerStanding = {
  sellerId: string;
  orders: number;
  upheldClaims: number;
  rejectedClaims: number;
  observedDefectRatePct: number;
  effectiveDefectRatePct: number;
  confident: boolean;
  band: "GOOD" | "ACCEPTABLE" | "POOR" | "UNACCEPTABLE";
  action: "NONE" | "WATCH" | "THROTTLE_LISTINGS" | "RECOMMEND_SUSPENSION";
  refundedInr: number;
  notice: string;
  reasons: string[];
};

type RefundRow = {
  refundNo: string;
  amountInr: number;
  remedy: string;
  method: string;
  status: string;
  sellerId: string;
  initiatedAt: string;
  expectedBy: string;
  settledAt: string | null;
  overdue: boolean;
};

type Tab = "queue" | "orders" | "refunds" | "sellers" | "outbox" | "mandate" | "evals";

export default function DeskPage() {
  const router = useRouter();
  const [data, setData] = useState<Desk | null>(null);
  const [tab, setTab] = useState<Tab>("queue");
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<{ m: string; t: "ok" | "err" } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Desk>("/api/desk"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/operator|Sign in/i.test(msg)) router.push("/signin");
      else setToast({ m: msg, t: "err" });
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  async function act(label: string, fn: () => Promise<string>) {
    setBusy(label);
    try {
      setToast({ m: await fn(), t: "ok" });
      await load();
    } catch (e) {
      setToast({ m: e instanceof Error ? e.message : "That did not work.", t: "err" });
    }
    setBusy("");
  }

  if (!data) {
    return <main style={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}><Spinner label="Loading the desk" /></main>;
  }

  const queue = data.claims.filter(
    (c) => !["RESOLVED", "REJECTED"].includes(c.state),
  );
  const history = data.claims.filter((c) => ["RESOLVED", "REJECTED"].includes(c.state));

  return (
    <Shell>
      <main className="page">
        <h1 style={{ fontSize: "clamp(1.5rem,3.4vw,2.1rem)", marginBottom: ".4rem" }}>
          Resolution desk
        </h1>
        <p style={{ color: "var(--ink-soft)", marginTop: 0, marginBottom: "1.2rem" }}>
          Every claim the agent could not settle on its own waits here for your decision.
        </p>

      {/* ── Counters, every one a projection of the event stream ───── */}
      <div style={{ display: "grid", gap: ".6rem", gridTemplateColumns: "repeat(auto-fit,minmax(8rem,1fr))", margin: "1.1rem 0" }}>
        <Stat label="Waiting on you" value={queue.length} tone={queue.length > 0 ? "gold" : "neutral"} />
        <Stat label="Orders placed" value={data.dashboard.ordersPlaced ?? 0} />
        <Stat label="Claims resolved" value={data.dashboard.claimsResolved ?? 0} />
        <Stat label="Escalations" value={data.dashboard.escalations ?? 0} />
        <Stat label="Agent declined to act" value={data.dashboard.declined ?? 0} />
        <Stat label="Letters sent" value={data.dashboard.mailSent ?? 0} />
      </div>

      <DemoControls data={data} busy={busy} act={act} />

      <nav style={{ display: "flex", gap: ".4rem", margin: "1.25rem 0", flexWrap: "wrap" }}>
        {([
          ["queue", `Approval queue (${queue.length})`],
          ["orders", `Parcels (${data.orders.length})`],
          ["refunds", `Refunds (${data.refunds.filter((r) => r.overdue).length ? `${data.refunds.filter((r) => r.overdue).length} overdue` : data.refunds.length})`],
          ["sellers", `Sellers (${data.sellers.filter((x) => x.action !== "NONE").length} flagged)`],
          ["outbox", `Outbox (${data.outbox.length})`],
          ["mandate", "Agent authority"],
          ["evals", "Evals"],
        ] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} className={`btn btn-sm ${tab === t ? "btn-primary" : "btn-ghost"}`} aria-pressed={tab === t}>
            {label}
          </button>
        ))}
      </nav>

      {tab === "queue" && (
        <>
          {queue.length === 0 ? (
            <Empty title="Nothing is waiting for you">
              When the agent adjudicates a complaint it stops here for approval.
              File one from the storefront to see the gate work.
            </Empty>
          ) : (
            <div className="stagger" style={{ display: "grid", gap: "1rem" }}>
              {queue.map((c) => (
                <CaseCard key={c.claimNo} claim={c} busy={busy} act={act} />
              ))}
            </div>
          )}

          {history.length > 0 && (
            <div style={{ marginTop: "2rem" }}>
              <h2 style={{ fontSize: "1.1rem", marginBottom: ".8rem" }}>Decided</h2>
              <div style={{ display: "grid", gap: ".6rem" }}>
                {history.map((c) => (
                  <div key={c.claimNo} className="card" style={{ padding: ".8rem 1rem", display: "flex", gap: ".6rem", alignItems: "center", flexWrap: "wrap" }}>
                    <span className="mono" style={{ color: "var(--ink-faint)" }}>{c.claimNo}</span>
                    <StateChip state={c.state} />
                    <span style={{ fontSize: ".86rem" }}>
                      {c.buyerName} · {humanise(c.issueType)} → {humanise(c.verdict.remedy)}
                      {c.verdict.amountInr > 0 && ` ${INR(c.verdict.amountInr)}`}
                    </span>
                    {c.approval.decidedBy && (
                      <span style={{ fontSize: ".78rem", color: "var(--ink-faint)", marginLeft: "auto" }}>
                        by {c.approval.decidedBy}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {tab === "orders" && <Parcels orders={data.orders} busy={busy} act={act} />}
      {tab === "refunds" && <Refunds refunds={data.refunds} />}
      {tab === "sellers" && <Sellers sellers={data.sellers} />}
      {tab === "outbox" && <Outbox mail={data.outbox} />}
      {tab === "mandate" && <Mandate mandate={data.mandate} caps={data.capabilities} />}
      {tab === "evals" && <EvalPanel onReseeded={load} />}

      {toast && <Toast message={toast.m} tone={toast.t} onDone={() => setToast(null)} />}
      </main>
    </Shell>
  );
}

function Stat({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "gold" }) {
  return (
    <div className="card" style={{ padding: ".7rem .85rem" }}>
      <div style={{ fontSize: "1.45rem", fontWeight: 650, fontFamily: "var(--font-display)", color: tone === "gold" && value > 0 ? "var(--haldi-deep)" : "var(--ink)" }}>
        {value}
      </div>
      <div style={{ fontSize: ".75rem", color: "var(--ink-faint)" }}>{label}</div>
    </div>
  );
}

/* ─────────────────────────── The case card ─────────────────────────── */

function CaseCard({
  claim,
  busy,
  act,
}: {
  claim: Claim;
  busy: string;
  act: (label: string, fn: () => Promise<string>) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [overrideAmount, setOverrideAmount] = useState<string>("");
  const v = claim.verdict;
  const a = claim.authenticity;
  const suspicious = a.verdict === "LIKELY_FABRICATED";
  const handoff = claim.state === "HUMAN_HANDOFF";

  return (
    <article className="card actionable enter" style={{ padding: "1.15rem", borderColor: suspicious ? "var(--brick)" : handoff ? "var(--haldi)" : "var(--rule)" }}>
      <div style={{ display: "flex", gap: ".4rem", alignItems: "center", flexWrap: "wrap", marginBottom: ".75rem" }}>
        <span className="mono" style={{ color: "var(--ink-faint)" }}>{claim.claimNo}</span>
        <StateChip state={claim.state} />
        <Chip tone="neutral">{humanise(claim.issueType)}</Chip>
        {claim.inputMode === "voice" && <Chip tone="indigo">voice</Chip>}
        {claim.escalationTier > 0 && <Chip tone="gold">escalated T{claim.escalationTier}</Chip>}
        <span style={{ marginLeft: "auto", fontSize: ".8rem", color: "var(--ink-faint)" }}>
          {claim.orderNo} · {claim.buyerName} · {INR(claim.orderAmountInr)}
        </span>
      </div>

      {handoff && (
        <div style={{ marginBottom: ".8rem" }}>
          <Banner tone="gold">
            The agent declined to decide this one. Either the evidence conflicts,
            its confidence fell below the acting threshold, or the allegation did
            not hold up — in each case it asks you rather than guessing.
          </Banner>
        </div>
      )}

      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,17rem),1fr))" }}>
        {/* What the buyer said, verbatim and translated */}
        <div>
          <Label>The complaint</Label>
          <blockquote style={{ margin: "0 0 .6rem", padding: ".6rem .75rem", background: "var(--paper-sunk)", borderRadius: 8, fontSize: ".88rem", fontStyle: "italic" }}>
            <span lang={claim.lang}>&ldquo;{claim.rawComplaint}&rdquo;</span>
            {claim.lang !== "en" && claim.translatedComplaint && (
              <div style={{ fontSize: ".8rem", color: "var(--ink-faint)", fontStyle: "normal", marginTop: ".35rem" }}>
                {claim.translatedComplaint}
              </div>
            )}
          </blockquote>

          {claim.evidence.filter((e) => e.kind === "image").length > 0 && (
            <div style={{ display: "flex", gap: ".4rem", flexWrap: "wrap", marginBottom: ".6rem" }}>
              {claim.evidence.filter((e) => e.kind === "image").map((e, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={e.dataUrl} alt={`Evidence ${i + 1}`} style={{ width: 82, height: 82, objectFit: "cover", borderRadius: 7, border: "1px solid var(--rule)" }} />
              ))}
            </div>
          )}

          {claim.buyerClaimHistory && (
            <div style={{ fontSize: ".78rem", color: "var(--ink-faint)" }}>
              This buyer: {claim.buyerClaimHistory.total} claim(s),{" "}
              {claim.buyerClaimHistory.rejected} rejected, {claim.buyerClaimHistory.priorRto} prior return-to-origin
            </div>
          )}
        </div>

        {/* The two independent assessments, side by side */}
        <div>
          <Label>Authenticity — advisory</Label>
          <SuspicionBar score={a.score} verdict={a.verdict} />
          <p style={{ fontSize: ".8rem", color: "var(--ink-soft)", margin: ".45rem 0 .5rem", lineHeight: 1.55 }}>
            {a.narrative}
          </p>
          {a.signals.length > 0 && (
            <Disclosure summary={`${a.signals.length} signals`}>
              {a.signals.map((s, i) => (
                <div key={i} style={{ fontSize: ".8rem", padding: ".22rem 0", color: "var(--ink-soft)", display: "flex", gap: ".4rem" }}>
                  <span className="mono" style={{ color: s.points > 0 ? "var(--brick)" : "var(--moss)", flexShrink: 0, minWidth: "2.2rem" }}>
                    {s.points > 0 ? "+" : ""}{s.points}
                  </span>
                  <span>{s.detail}</span>
                </div>
              ))}
            </Disclosure>
          )}
        </div>
      </div>

      {/* The engine verdict — the thing being approved */}
      <div
        style={{
          margin: "1rem 0", padding: ".9rem", borderRadius: 9,
          background: v.eligible ? "var(--moss-wash)" : "var(--paper-sunk)",
          borderLeft: `3px solid ${v.eligible ? "var(--moss)" : "var(--rule-strong)"}`,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: ".75rem", flexWrap: "wrap", alignItems: "baseline" }}>
          <div>
            <div style={{ fontSize: "1.05rem", fontWeight: 650 }}>
              {v.eligible ? `${humanise(v.remedy)}${v.amountInr > 0 ? ` of ${INR(v.amountInr)}` : " (no cash)"}` : "Not eligible"}
            </div>
            <div style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>
              {v.clauseIds.length > 0 ? `Clause ${v.clauseIds.join(", ")}` : "no clause matched"} ·
              engine confidence {Math.round(v.confidence * 100)}%
              {v.deadlineAt && ` · due ${new Date(v.deadlineAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}
            </div>
          </div>
          <Chip tone={claim.draftVerified ? "moss" : "brick"}>
            {claim.draftVerified ? "letter verified" : "letter rejected by the verifier"}
          </Chip>
        </div>

        <div style={{ marginTop: ".7rem" }}>
          <Disclosure summary="The engine's reasoning, step by step" defaultOpen>
            <Ladder reasons={v.reasons} />
          </Disclosure>
        </div>

        {v.alternatives.length > 0 && (
          <div style={{ marginTop: ".4rem" }}>
            <Disclosure summary={`${v.alternatives.length} remedies considered and not chosen`}>
              <Ladder reasons={v.alternatives} />
            </Disclosure>
          </div>
        )}
      </div>

      {claim.plan?.steps?.length > 0 && (
        <div style={{ marginBottom: ".7rem" }}>
          <Disclosure summary={`The route the agent planned (${claim.plan.steps.length} steps)`}>
            <PlanTrace plan={claim.plan} budget={claim.budget} />
          </Disclosure>
        </div>
      )}

      {claim.draftMessage && (
        <Disclosure summary="The letter that goes to the buyer">
          <div style={{ whiteSpace: "pre-wrap", fontSize: ".85rem", color: "var(--ink-soft)", lineHeight: 1.65, padding: ".6rem .75rem", background: "var(--paper-sunk)", borderRadius: 8 }}>
            {claim.draftMessage}
          </div>
          {claim.verifierNotes.length > 0 && (
            <div style={{ marginTop: ".4rem", fontSize: ".78rem", color: "var(--brick)" }}>
              Verifier: {claim.verifierNotes.join("; ")}
            </div>
          )}
        </Disclosure>
      )}

      {/* The gate */}
      <div style={{ marginTop: "1rem", paddingTop: ".9rem", borderTop: "1px solid var(--rule)" }}>
        <div style={{ fontSize: ".85rem", fontWeight: 600, marginBottom: ".55rem" }}>
          The agent is asking to: {claim.approval.requestedAction}
        </div>

        <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="field"
            style={{ flex: "1 1 14rem" }}
            placeholder="A note for the buyer and the audit log (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {v.eligible && v.amountInr > 0 && (
            <input
              className="field"
              style={{ width: "8.5rem" }}
              type="number"
              min={0}
              max={claim.orderAmountInr}
              placeholder={`${v.amountInr}`}
              value={overrideAmount}
              onChange={(e) => setOverrideAmount(e.target.value)}
              aria-label="Override the amount"
            />
          )}
        </div>

        <div style={{ display: "flex", gap: ".5rem", marginTop: ".6rem", flexWrap: "wrap" }}>
          <button
            className="btn btn-approve"
            disabled={busy !== ""}
            onClick={() =>
              act(claim.claimNo, async () => {
                const r = await api<{ remedy: string; amountInr: number; mailStatus: string; overridden: boolean }>(
                  "/api/desk/approve",
                  {
                    json: {
                      claimNo: claim.claimNo, approve: true, note: note || undefined,
                      overrideAmountInr: overrideAmount ? Number(overrideAmount) : undefined,
                    },
                  },
                );
                return `${claim.claimNo}: ${humanise(r.remedy)}${r.amountInr > 0 ? ` ${INR(r.amountInr)}` : ""} approved${
                  r.overridden ? " (your override, recorded in the audit log)" : ""
                }. Buyer email ${r.mailStatus}.`;
              })
            }
          >
            {busy === claim.claimNo ? <Spinner label="Approving" /> : "Approve"}
          </button>

          <button
            className="btn btn-reject"
            disabled={busy !== ""}
            onClick={() =>
              act(claim.claimNo, async () => {
                await api("/api/desk/approve", { json: { claimNo: claim.claimNo, approve: false, note: note || undefined } });
                return `${claim.claimNo} rejected. The buyer has been emailed the reason.`;
              })
            }
          >
            Reject
          </button>

          {claim.deadlineAt && (
            <button
              className="btn btn-ghost"
              disabled={busy !== ""}
              onClick={() =>
                act(claim.claimNo, async () => {
                  await api("/api/desk/controls", { json: { action: "skip_to_deadline", claimNo: claim.claimNo } });
                  const r = await api<{ escalated: { claimNo: string; tier: number }[] }>("/api/desk/tick", { json: { humanPresent: false } });
                  const mine = r.escalated.find((e) => e.claimNo === claim.claimNo);
                  return mine
                    ? `Deadline lapsed. The tracker escalated ${claim.claimNo} to T${mine.tier} on its own, with nobody at a keyboard.`
                    : "Clock moved past the deadline; the watcher found nothing to escalate yet.";
                })
              }
            >
              Skip to the deadline
            </button>
          )}
        </div>

        <p style={{ fontSize: ".76rem", color: "var(--ink-faint)", marginTop: ".55rem", marginBottom: 0 }}>
          You are neither the buyer nor the seller. Approving releases money and
          sends the letter; rejecting counts against this buyer&rsquo;s claim record.
        </p>
      </div>
    </article>
  );
}

/* ─────────────────────────── Other tabs ─────────────────────────── */

function Parcels({
  orders,
  busy,
  act,
}: {
  orders: OrderRow[];
  busy: string;
  act: (label: string, fn: () => Promise<string>) => Promise<void>;
}) {
  if (orders.length === 0) return <Empty title="No parcels yet" />;
  return (
    <div style={{ display: "grid", gap: ".7rem" }}>
      {orders.map((o) => (
        <div key={o.orderNo} className="card" style={{ padding: ".9rem 1rem", display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 16rem", minWidth: 0 }}>
            <div style={{ display: "flex", gap: ".4rem", alignItems: "center", flexWrap: "wrap", marginBottom: ".2rem" }}>
              <span className="mono" style={{ color: "var(--ink-faint)" }}>{o.orderNo}</span>
              <StateChip state={o.status} />
              {o.paymentMode === "COD" && <Chip tone="gold">COD</Chip>}
              {o.placedByAgent && <Chip tone="indigo">agent</Chip>}
            </div>
            <div style={{ fontSize: ".88rem" }}>
              {o.items.map((i) => `${i.title} × ${i.qty}`).join(", ")}
            </div>
            <div style={{ fontSize: ".78rem", color: "var(--ink-faint)" }}>
              {o.buyerName} · {INR(o.amountInr)}
              {o.shipment && ` · ${o.shipment.courier} · ${o.shipment.attempts} attempt(s)`}
            </div>
          </div>

          {o.shipment?.riskScore !== null && o.shipment?.riskBand && (
            <RiskDial score={o.shipment.riskScore!} band={o.shipment.riskBand} />
          )}

          <div style={{ display: "flex", gap: ".35rem", flexWrap: "wrap" }}>
            {o.status !== "DELIVERED" && (
              <>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy !== ""}
                  onClick={() => act(o.orderNo, async () => {
                    const r = await api<{ to: string }>("/api/desk/controls", { json: { action: "advance_order", orderNo: o.orderNo } });
                    return `${o.orderNo} is now ${humanise(r.to)}.`;
                  })}
                >
                  Advance
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy !== ""}
                  onClick={() => act(o.orderNo, async () => {
                    await api("/api/desk/controls", { json: { action: "fail_attempt", orderNo: o.orderNo, phoneReachable: false } });
                    return `Recorded a failed attempt on ${o.orderNo}. Re-score it to see the risk move.`;
                  })}
                >
                  Fail an attempt
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The refund ledger, operator side.
 *
 * Overdue first, because a refund past the date the buyer was promised is the
 * one thing on this desk a person is actively waiting on.
 */
function Refunds({ refunds }: { refunds: RefundRow[] }) {
  if (refunds.length === 0) {
    return <Empty title="No refunds yet">An upheld claim with a cash remedy opens a refund here.</Empty>;
  }

  const sorted = [...refunds].sort(
    (a, b) => Number(b.overdue) - Number(a.overdue) || Date.parse(b.initiatedAt) - Date.parse(a.initiatedAt),
  );
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  return (
    <div className="card" style={{ padding: "1.1rem" }}>
      <h3 style={{ marginBottom: ".2rem" }}>Money owed to buyers</h3>
      <p style={{ fontSize: ".82rem", color: "var(--ink-soft)", margin: "0 0 .9rem", maxWidth: "56ch", lineHeight: 1.6 }}>
        Amount, destination and the date the buyer was promised. Advancing the
        clock settles anything due.
      </p>

      {sorted.map((r) => (
        <div
          key={r.refundNo}
          style={{
            display: "flex", gap: ".6rem", flexWrap: "wrap", alignItems: "baseline",
            justifyContent: "space-between", padding: ".55rem 0", borderTop: "1px solid var(--rule)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", gap: ".4rem", alignItems: "center", flexWrap: "wrap" }}>
              <span className="mono" style={{ color: "var(--ink-faint)" }}>{r.refundNo}</span>
              <Chip tone={r.settledAt ? "moss" : r.overdue ? "brick" : "gold"}>
                {r.settledAt ? "settled" : r.overdue ? "overdue" : humanise(r.status)}
              </Chip>
              <span style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>
                {humanise(r.remedy)} · {humanise(r.method)}
                {r.sellerId ? ` · ${r.sellerId}` : ""}
              </span>
            </div>
            <div style={{ fontSize: ".78rem", color: "var(--ink-faint)", marginTop: ".15rem" }}>
              {r.settledAt
                ? `Settled ${day(r.settledAt)}, promised by ${day(r.expectedBy)}`
                : `Promised by ${day(r.expectedBy)}`}
            </div>
          </div>
          <strong className="mono" style={{ fontSize: ".95rem" }}>{INR(r.amountInr)}</strong>
        </div>
      ))}
    </div>
  );
}

/**
 * Seller accountability.
 *
 * The platform already prices a seller's failure rate into what buyers pay.
 * This is where that number is shown to be *earned*: upheld claims over orders
 * fulfilled, with the consequence that follows and the arithmetic behind it.
 *
 * Only upheld claims count. Claims filed and dismissed are shown separately,
 * because a seller is entitled to see that the platform reviewed an allegation
 * and found nothing against them.
 */
function Sellers({ sellers }: { sellers: SellerStanding[] }) {
  if (sellers.length === 0) return <Empty title="No sellers">Seed the database first.</Empty>;

  const tone = (band: SellerStanding["band"]) =>
    band === "GOOD" ? "moss" : band === "ACCEPTABLE" ? "neutral" : band === "POOR" ? "gold" : "brick";

  return (
    <div style={{ display: "grid", gap: ".8rem" }}>
      <div className="card" style={{ padding: "1rem 1.1rem" }}>
        <h3 style={{ marginBottom: ".2rem" }}>Where a fault lands on the seller</h3>
        <p style={{ fontSize: ".82rem", color: "var(--ink-soft)", margin: 0, maxWidth: "58ch", lineHeight: 1.6 }}>
          An upheld claim raises the seller&rsquo;s defect rate, which buyers see priced
          into their offers. Too high throttles their listings; worse is referred
          to a person.
        </p>
      </div>

      {sellers.map((x) => (
        <div
          key={x.sellerId}
          className="card"
          style={{
            padding: "1rem 1.1rem",
            borderLeft: x.action === "NONE" ? undefined : `3px solid var(--${x.band === "UNACCEPTABLE" ? "brick" : "haldi"})`,
          }}
        >
          <div style={{ display: "flex", gap: ".6rem", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: ".4rem", alignItems: "center", flexWrap: "wrap" }}>
              <span className="mono" style={{ fontWeight: 600 }}>{x.sellerId}</span>
              <Chip tone={tone(x.band) as "moss"}>{humanise(x.band)}</Chip>
              {x.action !== "NONE" && <Chip tone="indigo">{humanise(x.action)}</Chip>}
              {!x.confident && <Chip tone="neutral">sample too small to act on</Chip>}
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: "1.1rem", fontWeight: 680 }}>{x.effectiveDefectRatePct}%</div>
              <div style={{ fontSize: ".72rem", color: "var(--ink-faint)" }}>
                defect rate buyers see
              </div>
            </div>
          </div>

          <p style={{ fontSize: ".84rem", color: "var(--ink-soft)", margin: ".6rem 0 0", lineHeight: 1.6 }}>
            {x.notice}
          </p>

          <div style={{ marginTop: ".6rem" }}>
            <Disclosure summary="How this number was computed">
              <Ladder reasons={x.reasons} />
            </Disclosure>
          </div>
        </div>
      ))}
    </div>
  );
}

function Outbox({ mail }: { mail: Desk["outbox"] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (mail.length === 0) {
    return <Empty title="No mail yet">Every letter the platform sends is captured here, whether or not SMTP is configured.</Empty>;
  }
  return (
    <div style={{ display: "grid", gap: ".5rem" }}>
      {mail.map((m, i) => (
        <div key={i} className="card" style={{ padding: ".75rem .9rem" }}>
          <div style={{ display: "flex", gap: ".5rem", alignItems: "center", flexWrap: "wrap" }}>
            <Chip tone={m.status === "sent" ? "moss" : m.status === "failed" ? "brick" : "neutral"}>{m.status}</Chip>
            <span style={{ fontSize: ".88rem", fontWeight: 550 }}>{m.subject}</span>
            <span style={{ fontSize: ".78rem", color: "var(--ink-faint)", marginLeft: "auto" }}>
              {m.to} · {new Date(m.sentAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
          <button
            onClick={() => setOpen(open === i ? null : i)}
            style={{ background: "none", border: "none", padding: ".3rem 0 0", cursor: "pointer", fontSize: ".78rem", color: "var(--neel)" }}
          >
            {open === i ? "Hide" : "Read"} the letter
          </button>
          {open === i && (
            <iframe
              title={m.subject}
              srcDoc={m.html}
              sandbox=""
              style={{ width: "100%", height: "26rem", border: "1px solid var(--rule)", borderRadius: 8, marginTop: ".5rem", background: "#fff" }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function Mandate({ mandate, caps }: { mandate: Desk["mandate"]; caps: Desk["capabilities"] }) {
  return (
    <div>
      <Banner tone="indigo">
        Each agent&rsquo;s authority is data, shown here and enforced in the code that
        calls the tool. A rule written only into a prompt is a request; these are
        checked before a tool runs, so the worst a confused model can do is get refused.
      </Banner>

      <div style={{ display: "grid", gap: ".7rem", marginTop: "1rem", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,19rem),1fr))" }}>
        {mandate.map((m) => (
          <div key={m.agent} className="card" style={{ padding: ".95rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: ".5rem", marginBottom: ".3rem" }}>
              <h3 style={{ fontSize: ".95rem" }}>{m.agent}</h3>
              <Chip tone={m.usesModel ? "indigo" : "neutral"}>{m.usesModel ? "uses a model" : "no model"}</Chip>
            </div>
            <p style={{ fontSize: ".84rem", color: "var(--ink-soft)", margin: "0 0 .5rem", lineHeight: 1.55 }}>{m.job}</p>
            <div style={{ fontSize: ".78rem", color: "var(--ink-faint)" }}>
              Unapproved: {m.unapproved}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: "1.2rem" }}>
        <Banner tone="gold">
          A claim cannot reach <strong>APPROVED</strong> except from{" "}
          <strong>AWAITING_APPROVAL</strong> — the state where you decide. That is
          enforced by a state machine on every write, not by convention, which is
          what makes this gate worth anything.{" "}
          <a href="/system" style={{ color: "var(--neel)", fontWeight: 550 }}>
            See the full machine &rarr;
          </a>
        </Banner>
      </div>

      <h3 style={{ margin: "1.5rem 0 .6rem" }}>What is live right now</h3>
      <div className="card" style={{ padding: ".9rem" }}>
        {Object.entries(caps).map(([k, v]) => (
          <div key={k} style={{ display: "flex", gap: ".5rem", padding: ".35rem 0", borderBottom: "1px solid var(--rule)", fontSize: ".84rem" }}>
            <span style={{ minWidth: "6rem", fontWeight: 550 }}>{k}</span>
            <Chip tone={v.status === "live" ? "moss" : "neutral"}>{v.status}</Chip>
            <span style={{ color: "var(--ink-faint)" }}>{v.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DemoControls({
  data,
  busy,
  act,
}: {
  data: Desk;
  busy: string;
  act: (label: string, fn: () => Promise<string>) => Promise<void>;
}) {
  return (
    <div className="card" style={{ padding: ".8rem .95rem", display: "flex", gap: ".6rem", alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ fontSize: ".8rem", color: "var(--ink-faint)", marginRight: ".3rem" }}>
        Simulated clock:{" "}
        <strong style={{ color: "var(--ink)" }}>
          {new Date(data.clock.simulatedNow).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
        </strong>
        {data.clock.offsetDays > 0 && ` (+${data.clock.offsetDays}d)`}
      </div>

      <button className="btn btn-ghost btn-sm" disabled={busy !== ""} onClick={() => act("clock", async () => {
        const r = await api<{ simulatedNow: string }>("/api/desk/controls", { json: { action: "advance_days", days: 1 } });
        return `Clock moved to ${new Date(r.simulatedNow).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}.`;
      })}>
        +1 day
      </button>

      <button className="btn btn-ghost btn-sm" disabled={busy !== ""} onClick={() => act("tick", async () => {
        const r = await api<{ escalated: unknown[]; shipmentsScored: unknown[]; handedOff: unknown[] }>("/api/desk/tick", { json: { humanPresent: false } });
        return `Watcher ran with nobody present: ${r.escalated.length} escalated, ${r.handedOff.length} handed off, ${r.shipmentsScored.length} parcels rescored.`;
      })}>
        Run the watcher
      </button>

      <button className="btn btn-ghost btn-sm" disabled={busy !== ""} onClick={() => act("clock", async () => {
        await api("/api/desk/controls", { json: { action: "reset_clock" } });
        return "Clock reset to real time.";
      })}>
        Reset clock
      </button>

      {/* The reviewer's switch. Break something and watch the plan rewrite. */}
      <select
        className="field"
        style={{ width: "auto", fontSize: ".8rem", padding: ".3rem .5rem", marginLeft: "auto" }}
        value={Object.entries(data.chaos ?? {}).map(([t, m]) => `${t}:${m}`)[0] ?? ""}
        onChange={(e) => act("tool", async () => {
          const v = e.target.value;
          if (!v) {
            const r = await api<{ note: string }>("/api/desk/controls", { json: { action: "clear_chaos" } });
            return r.note;
          }
          const [tool, mode] = v.split(":");
          const r = await api<{ note: string }>("/api/desk/controls", {
            json: { action: "set_chaos", tool, mode },
          });
          return r.note;
        })}
        aria-label="Break a tool, slow it down, or strip the grounding from a draft"
      >
        <option value="">Nothing broken</option>
        <option value="get_tracking:fail">Fail: courier tracking</option>
        <option value="get_policy:fail">Fail: policy lookup</option>
        <option value="search_catalogue:fail">Fail: catalogue search</option>
        <option value="get_tracking:slow">Slow: courier tracking (2.5s)</option>
        <option value="__draft__:fail">Ungrounded first draft (verifier rejects it)</option>
      </select>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: ".74rem", color: "var(--ink-faint)", marginBottom: ".35rem", fontWeight: 550 }}>
      {children}
    </div>
  );
}
