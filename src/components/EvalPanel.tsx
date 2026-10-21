"use client";

/**
 * The eval suite, runnable from the desk.
 *
 * Each row is a claim about the system that a reviewer would otherwise have to
 * take on trust. The KNOWN LIMIT row is deliberately prominent rather than
 * tucked away: a suite that reports 100% by omitting its hard case is not
 * telling you anything.
 */

import { useEffect, useState } from "react";
import { api, Banner, Chip, Empty, Spinner } from "@/components/ui";

type ScenarioRow = {
  id: number;
  name: string;
  kind: string;
  orderNo: string | null;
  knownLimitation: string | null;
};

type Check = { label: string; ok: boolean; detail: string };

type Result = {
  id: number;
  name: string;
  kind: string;
  status: "PASS" | "FAIL" | "KNOWN LIMIT" | "ERROR";
  checks: Check[];
  observed: Record<string, unknown>;
  error?: string;
  knownLimitation?: string;
  ms: number;
};

type Report = {
  ran: number;
  passed: number;
  failed: number;
  knownLimits: number;
  errors: number;
  results: Result[];
  degraded: boolean;
  ms: number;
};

const TONE = {
  PASS: { chip: "moss", colour: "var(--moss)" },
  FAIL: { chip: "brick", colour: "var(--brick)" },
  "KNOWN LIMIT": { chip: "gold", colour: "var(--haldi-deep)" },
  ERROR: { chip: "brick", colour: "var(--brick)" },
} as const;

export default function EvalPanel({ onReseeded }: { onReseeded: () => void }) {
  const [scenarios, setScenarios] = useState<ScenarioRow[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api<{ scenarios: ScenarioRow[] }>("/api/desk/evals")
      .then((r) => setScenarios(r.scenarios))
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not load the scenarios."));
  }, []);

  async function run() {
    setRunning(true);
    setErr("");
    try {
      setReport(await api<Report>("/api/desk/evals", { json: {} }));
      // The suite reseeds, so the rest of the desk is now looking at stale data.
      onReseeded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The suite did not finish.");
    }
    setRunning(false);
  }

  const rows: (ScenarioRow & { result?: Result })[] = scenarios.map((s) => ({
    ...s,
    result: report?.results.find((r) => r.id === s.id),
  }));

  return (
    <div>
      <Banner tone="indigo">
        Every scenario runs against the real pipeline — the same engines,
        registry and approval gate the storefront uses, not mocks. Running the
        suite reseeds the database, because an eval whose result depends on what
        the last person clicked is not a regression suite.
      </Banner>

      <div style={{ display: "flex", gap: ".6rem", alignItems: "center", flexWrap: "wrap", margin: "1rem 0" }}>
        <button className="btn btn-accent" onClick={run} disabled={running}>
          {running ? <Spinner label="Running the suite" /> : `Run all ${scenarios.length} scenarios`}
        </button>

        {report && (
          <div style={{ display: "flex", gap: ".4rem", alignItems: "center", flexWrap: "wrap" }}>
            <Chip tone="moss">{report.passed} passed</Chip>
            {report.failed > 0 && <Chip tone="brick">{report.failed} failed</Chip>}
            {report.knownLimits > 0 && <Chip tone="gold">{report.knownLimits} known limit</Chip>}
            {report.errors > 0 && <Chip tone="brick">{report.errors} errored</Chip>}
            <span style={{ fontSize: ".78rem", color: "var(--ink-faint)" }}>
              in {(report.ms / 1000).toFixed(1)}s
              {report.degraded && " · no model key, so this ran the fallback path"}
            </span>
          </div>
        )}
      </div>

      {running && <div className="working" style={{ marginBottom: "1rem" }} />}
      {err && <div style={{ color: "var(--brick)", fontSize: ".85rem", marginBottom: "1rem" }}>{err}</div>}

      {scenarios.length === 0 && !err ? (
        <Empty title="Loading the scenarios" />
      ) : (
        <div style={{ display: "grid", gap: ".45rem" }}>
          {rows.map((row) => {
            const r = row.result;
            const tone = r ? TONE[r.status] : null;
            const isOpen = open === row.id;

            return (
              <div
                key={row.id}
                className="card"
                style={{ padding: ".7rem .9rem", borderLeft: tone ? `3px solid ${tone.colour}` : undefined }}
              >
                <button
                  onClick={() => setOpen(isOpen ? null : row.id)}
                  aria-expanded={isOpen}
                  style={{
                    display: "flex", gap: ".6rem", alignItems: "center", width: "100%",
                    background: "none", border: "none", padding: 0, cursor: "pointer",
                    textAlign: "left", flexWrap: "wrap",
                  }}
                >
                  <span className="mono" style={{ color: "var(--ink-faint)", minWidth: "1.6rem" }}>
                    {row.id}
                  </span>
                  {r ? <Chip tone={tone!.chip}>{r.status}</Chip> : <Chip tone="neutral">not run</Chip>}
                  <span style={{ fontSize: ".86rem", fontWeight: 500, flex: 1, minWidth: "12rem" }}>
                    {row.name}
                  </span>
                  <span style={{ fontSize: ".74rem", color: "var(--ink-faint)" }}>
                    {row.kind}
                    {r ? ` · ${r.ms}ms` : ""}
                  </span>
                </button>

                {isOpen && (
                  <div className="enter" style={{ marginTop: ".6rem", paddingTop: ".6rem", borderTop: "1px solid var(--rule)" }}>
                    {r?.knownLimitation && (
                      <div
                        style={{
                          background: "var(--haldi-wash)", borderLeft: "3px solid var(--haldi-deep)",
                          padding: ".6rem .75rem", borderRadius: "0 7px 7px 0",
                          fontSize: ".82rem", color: "var(--ink-soft)", lineHeight: 1.6, marginBottom: ".7rem",
                        }}
                      >
                        <strong style={{ display: "block", marginBottom: ".2rem", color: "var(--haldi-deep)" }}>
                          A limitation we report rather than hide
                        </strong>
                        {r.knownLimitation}
                      </div>
                    )}

                    {r?.error && (
                      <div style={{ color: "var(--brick)", fontSize: ".82rem", marginBottom: ".6rem" }}>
                        {r.error}
                      </div>
                    )}

                    {r?.checks.length ? (
                      <div style={{ marginBottom: ".7rem" }}>
                        {r.checks.map((c, i) => (
                          <div
                            key={i}
                            style={{
                              display: "flex", gap: ".5rem", alignItems: "flex-start",
                              fontSize: ".82rem", padding: ".2rem 0",
                            }}
                          >
                            <span
                              aria-hidden
                              style={{ color: c.ok ? "var(--moss)" : "var(--brick)", fontWeight: 700, flexShrink: 0 }}
                            >
                              {c.ok ? "✓" : "✕"}
                            </span>
                            <span style={{ color: "var(--ink-soft)" }}>
                              {c.label}
                              {c.detail && (
                                <span style={{ color: "var(--ink-faint)" }}> — {c.detail}</span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {r?.observed && Object.keys(r.observed).length > 0 && (
                      <details>
                        <summary style={{ cursor: "pointer", fontSize: ".78rem", color: "var(--neel)", fontWeight: 550 }}>
                          What the run actually produced
                        </summary>
                        <pre
                          className="mono scroll-thin"
                          style={{
                            margin: ".4rem 0 0", padding: ".6rem", background: "var(--paper-sunk)",
                            borderRadius: 7, fontSize: ".72rem", overflowX: "auto",
                            color: "var(--ink-soft)", lineHeight: 1.5,
                          }}
                        >
{JSON.stringify(r.observed, null, 2)}
                        </pre>
                      </details>
                    )}

                    {!r && (
                      <div style={{ fontSize: ".82rem", color: "var(--ink-faint)" }}>
                        {row.knownLimitation
                          ? "This scenario documents a known limitation. Run the suite to see it reported."
                          : `Runs against ${row.orderNo ?? "the seeded data"}. Run the suite to see the result.`}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
