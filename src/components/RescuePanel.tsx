"use client";

import { useCallback, useEffect, useState } from "react";
import { api, Banner, Chip, Empty, INR, RiskDial, Spinner, humanise } from "@/components/ui";

/**
 * The Proactive Order Rescue Agent, on the desk.
 *
 * What an operator needs from this is not a list of actions taken — it is the
 * *reasoning*, because the only question worth asking about a preventive agent
 * is whether it was right to act. So each row leads with the detected problem
 * and the factors behind it, and the action comes last.
 *
 * Two deliberate choices:
 *
 *  1. **Declined orders are shown, not hidden.** An agent that only displays
 *     what it did looks like one that always acts. The count of orders it left
 *     alone is the number that says it has judgement.
 *  2. **Simulated courier actions say so, every time.** There is no courier
 *     integration here. The reasoning, the gate and the audit trail are real;
 *     the van is not, and a reader must never have to guess which.
 */

type Step = {
  action: string;
  outcome: "executed" | "queued_for_approval" | "refused" | "failed";
  needsApproval: boolean;
  detail: string;
};

type Assessment = {
  orderNo: string;
  decision: "INTERVENE" | "NO_ACTION" | "HANDOFF";
  triggers: string[];
  risk: { score: number; band: string; reasons: { factor: string; points: number; detail: string }[] };
  forecast: null | {
    likelyAt: string;
    confidentAt: string;
    confidencePct: number;
    deadline: null | { at: string; confidentMeets: boolean; verdict: string; sentence: string };
  };
  runwayDays: number | null;
  contributingFactors: { factor: string; points: number; detail: string }[];
  intervention: null | { action: string; needsApproval: boolean; expectedEffect: string };
  reasons: string[];
  handoffReason: string;
};

type Run = {
  orderNo: string;
  assessment: Assessment;
  steps: Step[];
  after: null | { pointsRemoved: number; resolved: boolean; sentence: string };
  state: string;
  handedOff: boolean;
};

type Sweep = {
  at: string;
  humanPresent: boolean;
  ordersConsidered: number;
  declined: number;
  interventions: Run[];
  handoffs: Run[];
};

type QueueRow = {
  orderNo: string;
  rescueState: string;
  rescueAttempts: number;
  rescueActions: string[];
  riskScore: number | null;
  riskBand: string | null;
  promisedBy: string;
  status: string;
};

export default function RescuePanel() {
  const [queue, setQueue] = useState<QueueRow[] | null>(null);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api<{ queue: QueueRow[] }>("/api/desk/rescue");
      setQueue(r.queue);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the rescue queue.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function runSweep() {
    setBusy("sweep");
    setError("");
    try {
      // humanPresent: false — the claim being demonstrated is that the rescue
      // happens because a promise is in danger, not because someone clicked.
      const r = await api<{ sweep: Sweep }>("/api/desk/rescue", {
        method: "POST",
        body: JSON.stringify({ humanPresent: false }),
      });
      setSweep(r.sweep);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The sweep did not run.");
    }
    setBusy("");
  }

  if (!queue) return <Spinner label="Loading the rescue queue" />;

  return (
    <section style={{ display: "grid", gap: "1.1rem" }}>
      <Banner tone="indigo">
        This agent watches orders still in flight and tries to stop the complaint
        being necessary. It reuses the same risk engine and delivery forecast the
        rest of the platform uses, judges the promise against the{" "}
        <strong>confident</strong> date rather than the optimistic one, and may
        only take <strong>reversible</strong> courier actions on its own —
        anything that messages a buyer or changes how they pay waits for you.
        <br />
        <br />
        <strong>Courier actions are simulated.</strong> There is no courier
        integration here: each one writes the shipment state a real courier API
        would cause. The reasoning and the gate are real; the van is not.
      </Banner>

      <div style={{ display: "flex", gap: ".6rem", alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn btn-primary" onClick={runSweep} disabled={busy === "sweep"}>
          {busy === "sweep" ? "Sweeping…" : "Run a rescue sweep"}
        </button>
        <span style={{ fontSize: ".82rem", color: "var(--ink-faint)" }}>
          Assesses every in-flight order. Runs with <code>humanPresent: false</code>,
          so the audit trail records that nobody was watching.
        </span>
      </div>

      {error && <Banner tone="brick">{error}</Banner>}

      {/* ── What the last sweep concluded ─────────────────────────── */}

      {sweep && (
        <div className="card" style={{ padding: "1rem" }}>
          <h3 style={{ margin: "0 0 .6rem", fontSize: "1rem" }}>Last sweep</h3>
          <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", marginBottom: ".8rem" }}>
            <Chip tone="neutral">{sweep.ordersConsidered} considered</Chip>
            <Chip tone={sweep.interventions.length ? "indigo" : "neutral"}>
              {sweep.interventions.length} intervened
            </Chip>
            <Chip tone={sweep.handoffs.length ? "gold" : "neutral"}>
              {sweep.handoffs.length} handed off
            </Chip>
            {/* The restraint is the feature, so it gets a chip of its own. */}
            <Chip tone="neutral">{sweep.declined} left alone</Chip>
          </div>

          {sweep.interventions.length === 0 && sweep.handoffs.length === 0 && (
            <p style={{ margin: 0, fontSize: ".88rem", color: "var(--ink-soft)" }}>
              Every in-flight order was healthy enough to leave alone. An agent
              that intervened anyway would be pestering buyers, not preventing
              failures.
            </p>
          )}

          <div style={{ display: "grid", gap: ".8rem" }}>
            {[...sweep.interventions, ...sweep.handoffs].map((run) => (
              <RunCard key={run.orderNo} run={run} />
            ))}
          </div>
        </div>
      )}

      {/* ── The standing queue ────────────────────────────────────── */}

      <div>
        <h3 style={{ fontSize: "1rem", margin: "0 0 .6rem" }}>
          Orders the agent is holding open ({queue.length})
        </h3>

        {queue.length === 0 ? (
          <Empty title="Nothing is being watched">
            Run a sweep, or advance the clock so a promised date comes closer and
            a parcel genuinely falls at risk.
          </Empty>
        ) : (
          <div style={{ display: "grid", gap: ".5rem" }}>
            {queue.map((r) => (
              <div
                key={r.orderNo}
                className="card"
                style={{ padding: ".8rem 1rem", display: "flex", gap: ".6rem", alignItems: "center", flexWrap: "wrap" }}
              >
                <span className="mono" style={{ color: "var(--ink-faint)" }}>{r.orderNo}</span>
                <Chip tone={r.rescueState === "HANDOFF" ? "gold" : r.rescueState === "RESOLVED" ? "neutral" : "indigo"}>
                  {humanise(r.rescueState)}
                </Chip>
                <Chip tone="neutral">{humanise(r.status)}</Chip>
                {r.riskScore !== null && (
                  <span style={{ fontSize: ".82rem" }}>
                    risk {r.riskScore}/100 ({r.riskBand})
                  </span>
                )}
                <span style={{ fontSize: ".8rem", color: "var(--ink-faint)" }}>
                  {r.rescueAttempts} attempt{r.rescueAttempts === 1 ? "" : "s"}
                  {r.rescueActions.length > 0 && ` · ${r.rescueActions.map(humanise).join(", ")}`}
                </span>
                <span style={{ marginLeft: "auto", fontSize: ".78rem", color: "var(--ink-faint)" }}>
                  due {new Date(r.promisedBy).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * One order's assessment.
 *
 * Ordered the way the decision was actually made: the problem, then the
 * factors behind it, then what the agent proposed — not the other way round.
 */
function RunCard({ run }: { run: Run }) {
  const a = run.assessment;

  return (
    <article
      className="card"
      style={{
        padding: "1rem",
        borderColor: run.handedOff ? "var(--haldi)" : "var(--rule)",
      }}
    >
      <div style={{ display: "flex", gap: ".45rem", alignItems: "center", flexWrap: "wrap", marginBottom: ".7rem" }}>
        <span className="mono" style={{ color: "var(--ink-faint)" }}>{a.orderNo}</span>
        <Chip tone={a.decision === "INTERVENE" ? "indigo" : a.decision === "HANDOFF" ? "gold" : "neutral"}>
          {humanise(a.decision)}
        </Chip>
        {a.triggers.map((t) => (
          <Chip key={t} tone="brick">{humanise(t)}</Chip>
        ))}
        {a.runwayDays !== null && (
          <span style={{ marginLeft: "auto", fontSize: ".8rem", color: "var(--ink-faint)" }}>
            {a.runwayDays >= 0 ? `${a.runwayDays}d of runway` : `${Math.abs(a.runwayDays)}d overdue`}
          </span>
        )}
      </div>

      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,15rem),1fr))" }}>
        {/* The score, from the same engine the parcels tab shows. */}
        <div>
          <RiskDial score={a.risk.score} band={a.risk.band} />
          <h4 style={{ fontSize: ".8rem", textTransform: "uppercase", letterSpacing: ".04em", color: "var(--ink-faint)", margin: ".7rem 0 .35rem" }}>
            Contributing factors
          </h4>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: ".84rem", color: "var(--ink-soft)" }}>
            {a.contributingFactors.slice(0, 4).map((f) => (
              <li key={f.factor}>
                <strong>+{f.points}</strong> {f.detail}
              </li>
            ))}
          </ul>
        </div>

        {/* The forecast interval, and whether it makes the promise. */}
        <div>
          <h4 style={{ fontSize: ".8rem", textTransform: "uppercase", letterSpacing: ".04em", color: "var(--ink-faint)", margin: "0 0 .35rem" }}>
            Delivery forecast
          </h4>
          {a.forecast ? (
            <>
              <p style={{ margin: 0, fontSize: ".86rem" }}>
                Likely <strong>{a.forecast.likelyAt}</strong>, {a.forecast.confidencePct}% confident by{" "}
                <strong>{a.forecast.confidentAt}</strong>
              </p>
              {a.forecast.deadline && (
                <p style={{ margin: ".4rem 0 0", fontSize: ".84rem", color: a.forecast.deadline.confidentMeets ? "var(--ink-soft)" : "var(--brick)" }}>
                  {a.forecast.deadline.sentence}
                </p>
              )}
            </>
          ) : (
            <p style={{ margin: 0, fontSize: ".84rem", color: "var(--ink-faint)" }}>
              This order carries no promised date, so there is no promise to judge.
            </p>
          )}

          <h4 style={{ fontSize: ".8rem", textTransform: "uppercase", letterSpacing: ".04em", color: "var(--ink-faint)", margin: ".8rem 0 .35rem" }}>
            Why
          </h4>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: ".84rem", color: "var(--ink-soft)" }}>
            {a.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      </div>

      {/* What it proposed, and what became of it. */}
      {run.steps.length > 0 && (
        <div style={{ marginTop: ".9rem", borderTop: "1px solid var(--rule)", paddingTop: ".8rem" }}>
          <h4 style={{ fontSize: ".8rem", textTransform: "uppercase", letterSpacing: ".04em", color: "var(--ink-faint)", margin: "0 0 .45rem" }}>
            Action
          </h4>
          {run.steps.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: ".5rem", alignItems: "center", flexWrap: "wrap", fontSize: ".86rem" }}>
              <Chip tone={s.outcome === "executed" ? "indigo" : s.outcome === "queued_for_approval" ? "gold" : "brick"}>
                {humanise(s.outcome)}
              </Chip>
              <strong>{humanise(s.action)}</strong>
              <span style={{ color: "var(--ink-soft)" }}>{s.detail}</span>
              {s.outcome === "executed" && (
                <Chip tone="neutral">simulated courier</Chip>
              )}
            </div>
          ))}

          {run.after && (
            <p style={{ margin: ".6rem 0 0", fontSize: ".86rem", color: run.after.pointsRemoved > 0 ? "var(--ink-soft)" : "var(--brick)" }}>
              {run.after.sentence}
            </p>
          )}
        </div>
      )}

      {run.handedOff && a.handoffReason && (
        <div style={{ marginTop: ".9rem" }}>
          <Banner tone="gold">{a.handoffReason}</Banner>
        </div>
      )}
    </article>
  );
}
