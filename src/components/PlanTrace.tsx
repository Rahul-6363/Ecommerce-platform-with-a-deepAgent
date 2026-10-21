"use client";

/**
 * The plan, on screen.
 *
 * This is the piece worth showing: the route the agent intended to take,
 * which step it is on, which one failed, and where the plan rewrote itself
 * around a dead tool. A step that stopped at the approval gate is marked as
 * waiting rather than broken, because stopping there is correct behaviour.
 */

import { Chip } from "@/components/ui";

export type Step = {
  id: number;
  title: string;
  tool: string;
  why: string;
  needsApproval: boolean;
  status: string;
  summary?: string;
  ms?: number;
};

export type PlanShape = { goal: string; source: string; steps: Step[] };

const AGENT_FOR_TOOL: Record<string, string> = {
  get_order: "Triage", get_tracking: "Triage",
  get_policy: "Policy", get_buyer_profile: "Policy", check_entitlement: "Policy",
  assess_authenticity: "Fraud analyst",
  risk_score: "Risk", reschedule_delivery: "Risk",
  redirect_to_pickup: "Risk", hold_shipment: "Risk",
  ask_buyer: "Action", convert_cod_to_prepaid: "Action",
  submit_claim: "Action", send_message: "Action", issue_refund: "Action",
  schedule_followup: "Tracker", escalate: "Tracker",
  __draft__: "Action", __verify__: "Verifier",
};

const LABEL: Record<string, string> = {
  __draft__: "write the letter",
  __verify__: "check the letter",
};

function mark(status: string) {
  switch (status) {
    case "done":
      return { glyph: "✓", colour: "var(--moss)", bg: "var(--moss-wash)" };
    case "failed":
      return { glyph: "✕", colour: "var(--brick)", bg: "var(--brick-wash)" };
    case "awaiting_approval":
      return { glyph: "⏸", colour: "var(--neel)", bg: "var(--neel-wash)" };
    case "running":
      return { glyph: "•", colour: "var(--haldi-deep)", bg: "var(--haldi-wash)" };
    case "skipped":
      return { glyph: "–", colour: "var(--ink-faint)", bg: "var(--paper-sunk)" };
    default:
      return { glyph: "", colour: "var(--ink-faint)", bg: "var(--paper-sunk)" };
  }
}

export default function PlanTrace({
  plan,
  budget,
}: {
  plan: PlanShape;
  budget?: { stepsUsed: number; replansUsed: number; exhausted: boolean };
}) {
  if (!plan?.steps?.length) return null;

  const replanned = plan.source.startsWith("replan");
  const fellBack = plan.source === "fallback" || plan.source === "replan-fallback";
  const failedStep = plan.steps.find((s) => s.status === "failed");

  return (
    <div>
      <div style={{ display: "flex", gap: ".4rem", alignItems: "center", flexWrap: "wrap", marginBottom: ".6rem" }}>
        <span style={{ fontSize: ".8rem", fontWeight: 600 }}>
          {plan.steps.length} step{plan.steps.length === 1 ? "" : "s"}
        </span>
        {replanned && <Chip tone="gold">replanned</Chip>}
        {fellBack && <Chip tone="neutral">deterministic plan</Chip>}
        {budget?.exhausted && <Chip tone="brick">budget spent</Chip>}
        {budget && !budget.exhausted && budget.replansUsed > 0 && (
          <span style={{ fontSize: ".75rem", color: "var(--ink-faint)" }}>
            {budget.replansUsed} replan{budget.replansUsed === 1 ? "" : "s"} used
          </span>
        )}
      </div>

      {failedStep && (
        <div
          style={{
            background: "var(--haldi-wash)", borderLeft: "3px solid var(--haldi-deep)",
            padding: ".55rem .75rem", borderRadius: "0 7px 7px 0",
            fontSize: ".82rem", color: "var(--ink-soft)", marginBottom: ".7rem",
          }}
        >
          <code className="mono">{failedStep.tool}</code> failed, so the plan was rewritten
          without it. The case still reached a decision.
        </div>
      )}

      <ol className="stagger" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {plan.steps.map((s, i) => {
          const m = mark(s.status);
          const last = i === plan.steps.length - 1;
          return (
            <li key={`${s.id}-${s.tool}-${i}`} style={{ display: "flex", gap: ".65rem", position: "relative" }}>
              {/* The rail: a connected chain, so the order is unmistakable. */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                <div
                  aria-hidden
                  style={{
                    width: 20, height: 20, borderRadius: "50%", background: m.bg,
                    border: `1px solid ${m.colour}`, color: m.colour,
                    display: "grid", placeItems: "center",
                    fontSize: ".66rem", fontWeight: 700, lineHeight: 1,
                  }}
                >
                  {m.glyph || s.id}
                </div>
                {!last && <div style={{ width: 1, flex: 1, minHeight: 16, background: "var(--rule)" }} />}
              </div>

              <div style={{ paddingBottom: last ? 0 : ".7rem", minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", gap: ".4rem", alignItems: "baseline", flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontSize: ".85rem", fontWeight: 550,
                      color: s.status === "failed" ? "var(--brick)" : "var(--ink)",
                      textDecoration: s.status === "failed" ? "line-through" : "none",
                    }}
                  >
                    {s.title || LABEL[s.tool] || s.tool.replace(/_/g, " ")}
                  </span>
                  <span style={{ fontSize: ".72rem", color: "var(--ink-faint)" }}>
                    {AGENT_FOR_TOOL[s.tool] ?? "Orchestrator"}
                  </span>
                  {s.needsApproval && <Chip tone="indigo">gated</Chip>}
                  {s.ms ? (
                    <span className="mono" style={{ color: "var(--ink-faint)", fontSize: ".7rem" }}>
                      {s.ms}ms
                    </span>
                  ) : null}
                </div>

                {s.why && (
                  <div style={{ fontSize: ".78rem", color: "var(--ink-soft)", marginTop: ".1rem", lineHeight: 1.5 }}>
                    {s.why}
                  </div>
                )}

                {s.status === "awaiting_approval" && (
                  <div style={{ fontSize: ".76rem", color: "var(--neel)", marginTop: ".2rem" }}>
                    Waiting for an operator. This is where the agent stops by design.
                  </div>
                )}

                {s.status === "failed" && s.summary && (
                  <div style={{ fontSize: ".76rem", color: "var(--brick)", marginTop: ".2rem" }}>
                    {s.summary}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {plan.goal && (
        <div style={{ marginTop: ".7rem", paddingTop: ".6rem", borderTop: "1px solid var(--rule)", fontSize: ".76rem", color: "var(--ink-faint)", lineHeight: 1.5 }}>
          Goal: {plan.goal}
        </div>
      )}
    </div>
  );
}
