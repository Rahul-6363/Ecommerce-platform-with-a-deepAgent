"use client";

/**
 * How it works — the system, declared on screen.
 *
 * This page exists because the interesting claims about this platform are
 * invisible by default: that the money decision is a pure function, that the
 * gate is enforced in code, that a claim cannot reach APPROVED without passing
 * it. Every number here is imported from the module that uses it, so the page
 * cannot drift from the behaviour it describes.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/Shell";
import { api, Banner, Chip, Spinner, humanise } from "@/components/ui";

type Agent = {
  agent: string; job: string; usesModel: boolean; unapproved: string; tools: string[];
};

type SystemInfo = {
  capabilities: Record<string, { status: string; detail: string }>;
  models: { text: string; vision: string; audio: string; fallbacks: string[]; speech?: string };
  agents: Agent[];
  budgets: Record<string, number>;
  gates: { operatorApproval: string[]; buyerConfirm: string[] };
  tools: { tool: string; capability: string; gate: string }[];
  stateMachine: { state: string; next: string[]; terminal: boolean; gate: boolean }[];
  engines: Record<string, {
    description: string;
    constants: Record<string, unknown>;
    remedyLadder?: Record<string, string[]>;
    requiredEvidence?: Record<string, string[]>;
    supportedConstraints?: readonly string[];
  }>;
  fallbackPlan: { id: number; title: string; tool: string; why: string; gated: boolean }[];
  evals: { id: number; name: string; kind: string; knownLimitation: string | null }[];
};

export default function SystemPage() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api<SystemInfo>("/api/system")
      .then(setInfo)
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not load."));
  }, []);

  if (err) {
    return (
      <Shell>
        <Banner tone="brick">
          {err} — <Link href="/signin" style={{ color: "var(--neel)" }}>sign in</Link> to view this.
        </Banner>
      </Shell>
    );
  }
  if (!info) return <Shell><Spinner label="Loading" /></Shell>;

  return (
    <Shell>
      <h1 style={{ marginBottom: ".6rem" }}>How it works</h1>
      <p style={{ color: "var(--ink-soft)", maxWidth: "62ch", marginBottom: "1.6rem", lineHeight: 1.7 }}>
        Every number on this page is read from the module that uses it, so what
        you see here is what the system does — not a description of it that can
        fall out of date.
      </p>

      {/* ── The line between the model and the code ─────────────────── */}
      <Section
        title="Where the model stops"
        lede="A language model reads the complaint and writes the letter. Pure functions decide the money. That division is the whole design."
      >
        <div style={{ display: "grid", gap: ".8rem", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,17rem),1fr))" }}>
          {Object.entries(info.engines).map(([name, e]) => (
            <div key={name} className="card" style={{ padding: "1rem" }}>
              <div style={{ display: "flex", gap: ".4rem", alignItems: "center", marginBottom: ".4rem" }}>
                <h3 style={{ fontSize: ".95rem" }}>{humanise(name)}</h3>
                <Chip tone="moss">no model inside</Chip>
              </div>
              <p style={{ fontSize: ".84rem", color: "var(--ink-soft)", margin: "0 0 .7rem", lineHeight: 1.55 }}>
                {e.description}
              </p>
              <dl style={{ margin: 0, fontSize: ".8rem" }}>
                {Object.entries(e.constants).map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: ".5rem", padding: ".18rem 0", borderTop: "1px solid var(--rule)" }}>
                    <dt style={{ color: "var(--ink-faint)" }}>{humanise(k)}</dt>
                    <dd className="mono" style={{ margin: 0, fontWeight: 600 }}>{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>

        {info.engines.entitlement?.remedyLadder && (
          <div className="card" style={{ padding: "1rem", marginTop: ".8rem" }}>
            <h3 style={{ fontSize: ".92rem", marginBottom: ".2rem" }}>The remedy ladder</h3>
            <p style={{ fontSize: ".82rem", color: "var(--ink-soft)", margin: "0 0 .7rem" }}>
              Walked in order; the first remedy that is actually feasible wins. A
              buyer who wants their item fast gets the goods remedy, one who wants
              money gets the refund.
            </p>
            <div style={{ display: "grid", gap: ".3rem" }}>
              {Object.entries(info.engines.entitlement.remedyLadder).map(([issue, ladder]) => (
                <div key={issue} style={{ display: "flex", gap: ".5rem", alignItems: "baseline", flexWrap: "wrap", fontSize: ".82rem", padding: ".22rem 0", borderTop: "1px solid var(--rule)" }}>
                  <span style={{ minWidth: "9rem", fontWeight: 550 }}>{humanise(issue)}</span>
                  <span style={{ color: "var(--ink-soft)" }}>
                    {ladder.map((r) => humanise(r)).join("  →  ")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* ── Bounded authority ───────────────────────────────────────── */}
      <Section
        title="What each agent may do alone"
        lede="Authority is data, shown here and checked in the code that calls the tool. A rule written only into a prompt is a request a model can be talked out of."
      >
        <div style={{ display: "grid", gap: ".7rem", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,18rem),1fr))" }}>
          {info.agents.map((a) => (
            <div key={a.agent} className="card" style={{ padding: ".9rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: ".5rem", marginBottom: ".3rem" }}>
                <h3 style={{ fontSize: ".92rem" }}>{a.agent}</h3>
                <Chip tone={a.usesModel ? "indigo" : "neutral"}>
                  {a.usesModel ? "uses a model" : "no model"}
                </Chip>
              </div>
              <p style={{ fontSize: ".83rem", color: "var(--ink-soft)", margin: "0 0 .5rem", lineHeight: 1.55 }}>
                {a.job}
              </p>
              <div style={{ fontSize: ".78rem", color: "var(--ink-faint)" }}>
                Without approval: {a.unapproved}
              </div>
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: "1rem", marginTop: ".8rem" }}>
          <h3 style={{ fontSize: ".92rem", marginBottom: ".5rem" }}>The gates</h3>
          <div style={{ display: "grid", gap: ".7rem", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,15rem),1fr))" }}>
            <div>
              <div style={{ fontSize: ".8rem", fontWeight: 600, color: "var(--brick)", marginBottom: ".3rem" }}>
                An operator must approve
              </div>
              <div style={{ display: "flex", gap: ".3rem", flexWrap: "wrap" }}>
                {info.gates.operatorApproval.map((t) => <Chip key={t} tone="brick">{t}</Chip>)}
              </div>
              <p style={{ fontSize: ".78rem", color: "var(--ink-faint)", marginTop: ".4rem", marginBottom: 0, lineHeight: 1.5 }}>
                Two of these are <em>messaging the buyer</em> and <em>moving money</em>, so
                the person approving is neither the buyer nor the seller.
              </p>
            </div>
            <div>
              <div style={{ fontSize: ".8rem", fontWeight: 600, color: "var(--haldi-deep)", marginBottom: ".3rem" }}>
                The buyer must confirm
              </div>
              <div style={{ display: "flex", gap: ".3rem", flexWrap: "wrap" }}>
                {info.gates.buyerConfirm.map((t) => <Chip key={t} tone="gold">{t}</Chip>)}
              </div>
              <p style={{ fontSize: ".78rem", color: "var(--ink-faint)", marginTop: ".4rem", marginBottom: 0, lineHeight: 1.5 }}>
                The agent fills the cart. A human spends their own money.
              </p>
            </div>
          </div>

          <div style={{ marginTop: ".9rem", paddingTop: ".7rem", borderTop: "1px solid var(--rule)", display: "flex", gap: "1rem", flexWrap: "wrap", fontSize: ".8rem" }}>
            {Object.entries(info.budgets).map(([k, v]) => (
              <span key={k} style={{ color: "var(--ink-soft)" }}>
                {humanise(k)}: <strong className="mono">{v}</strong>
              </span>
            ))}
          </div>
          <p style={{ fontSize: ".78rem", color: "var(--ink-faint)", marginTop: ".4rem", marginBottom: 0 }}>
            Exhausting any budget routes the case to a person, never to a loop.
          </p>
        </div>
      </Section>

      {/* ── The state machine ───────────────────────────────────────── */}
      <Section
        title="A claim cannot skip the gate"
        lede="Every transition is declared and checked at the point of change. A claim cannot reach APPROVED except from the state where a human decides — which is what makes the gate mean anything."
      >
        <div className="card" style={{ padding: "1rem" }}>
          {info.stateMachine.map((s) => (
            <div
              key={s.state}
              style={{
                display: "flex", gap: ".6rem", alignItems: "baseline", flexWrap: "wrap",
                padding: ".34rem 0", borderTop: "1px solid var(--rule)",
              }}
            >
              <span
                className="mono"
                style={{
                  minWidth: "11rem", fontWeight: 600,
                  color: s.gate ? "var(--neel)" : s.terminal ? "var(--ink-faint)" : "var(--ink)",
                }}
              >
                {s.state}
              </span>
              {s.gate && <Chip tone="indigo">the gate</Chip>}
              {s.terminal ? (
                <span style={{ fontSize: ".8rem", color: "var(--ink-faint)" }}>terminal — nothing follows</span>
              ) : (
                <span style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>→ {s.next.join(", ")}</span>
              )}
            </div>
          ))}
        </div>
      </Section>

      {/* ── The deterministic plan ──────────────────────────────────── */}
      <Section
        title="The plan it falls back to"
        lede="When no model is reachable, or the planner returns something invalid, this fixed sequence runs instead. It is a complete, correct path through a claim — the model's job is to do better than it, not to be trusted instead of it."
      >
        <div className="card" style={{ padding: "1rem" }}>
          {info.fallbackPlan.map((s) => (
            <div key={s.id} style={{ display: "flex", gap: ".6rem", padding: ".32rem 0", borderTop: "1px solid var(--rule)" }}>
              <span className="mono" style={{ color: "var(--ink-faint)", minWidth: "1.2rem" }}>{s.id}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: ".86rem", fontWeight: 550 }}>
                  {s.title} {s.gated && <Chip tone="brick">gated</Chip>}
                </div>
                <div style={{ fontSize: ".78rem", color: "var(--ink-faint)" }}>{s.why}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Evals ──────────────────────────────────────────────────── */}
      <Section
        title={`The ${info.evals.length} scenarios it is checked against`}
        lede="Each one asserts a claim about the system that you would otherwise have to take on trust. They run against the real pipeline from the Evals tab on the operator desk."
      >
        <div className="card" style={{ padding: "1rem" }}>
          {info.evals.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: ".6rem", alignItems: "baseline", padding: ".28rem 0", borderTop: "1px solid var(--rule)", flexWrap: "wrap" }}>
              <span className="mono" style={{ color: "var(--ink-faint)", minWidth: "1.6rem" }}>{e.id}</span>
              <span style={{ fontSize: ".85rem", flex: 1, minWidth: "14rem" }}>{e.name}</span>
              {e.knownLimitation
                ? <Chip tone="gold">known limit</Chip>
                : <span style={{ fontSize: ".75rem", color: "var(--ink-faint)" }}>{e.kind}</span>}
            </div>
          ))}
        </div>
        {info.evals.some((e) => e.knownLimitation) && (
          <div style={{ marginTop: ".7rem" }}>
            <Banner tone="gold">
              {info.evals.find((e) => e.knownLimitation)?.knownLimitation}
            </Banner>
          </div>
        )}
      </Section>

      {/* ── What is live ───────────────────────────────────────────── */}
      <Section title="What is running right now" lede="">
        <div className="card" style={{ padding: "1rem" }}>
          {Object.entries(info.capabilities).map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: ".6rem", alignItems: "center", padding: ".3rem 0", borderTop: "1px solid var(--rule)", flexWrap: "wrap" }}>
              <span style={{ minWidth: "6rem", fontSize: ".85rem", fontWeight: 550 }}>{humanise(k)}</span>
              <Chip tone={v.status === "live" ? "moss" : v.status === "ephemeral" ? "indigo" : "gold"}>
                {v.status}
              </Chip>
              <span style={{ fontSize: ".8rem", color: "var(--ink-faint)" }}>{v.detail}</span>
            </div>
          ))}
          <div style={{ marginTop: ".7rem", paddingTop: ".6rem", borderTop: "1px solid var(--rule)", fontSize: ".79rem", color: "var(--ink-faint)", lineHeight: 1.6 }}>
            Text model <code className="mono">{info.models.text}</code>
            {info.models.fallbacks.length > 0 && (
              <>, falling back to <code className="mono">{info.models.fallbacks.join(", ")}</code> when
              its daily quota runs out</>
            )}.
            Anything not live runs on a deterministic path instead, and the screen says so.
          </div>
        </div>
      </Section>
    </Shell>
  );
}

/** The page frame. Navigation and identity come from the app shell. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <main className="page page-narrow">{children}</main>
    </AppShell>
  );
}

function Section({
  title, lede, children,
}: {
  title: string; lede: string; children: React.ReactNode;
}) {
  return (
    <section className="enter" style={{ marginBottom: "2.2rem" }}>
      <h2 style={{ fontSize: "1.25rem", marginBottom: lede ? ".35rem" : ".7rem" }}>{title}</h2>
      {lede && (
        <p style={{ color: "var(--ink-soft)", maxWidth: "66ch", margin: "0 0 .9rem", lineHeight: 1.65, fontSize: ".9rem" }}>
          {lede}
        </p>
      )}
      {children}
    </section>
  );
}
