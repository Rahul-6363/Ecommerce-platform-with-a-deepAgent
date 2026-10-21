"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Shell from "@/components/Shell";
import { api, Banner, Chip, Disclosure, Spinner, SpeakButton, useSpeaker } from "@/components/ui";

/**
 * Watch the agent work, one step at a time.
 *
 * Every screen in this product is a projection of the same append-only event
 * stream, and that stream already records who did what. What it could not do
 * is explain itself: three hundred chronological rows do not show that the
 * model which read a complaint is not the thing that decided the refund,
 * which is the claim the whole architecture rests on.
 *
 * So this page runs real journeys against the real engines — no mocks, no
 * recordings, no code path that exists only for the demo — and shows each
 * event beside the actor that produced it and whether that actor was a
 * language model or a pure function.
 *
 * The one visual decision that matters: models and engines are coloured
 * differently and never share a colour with each other. A judge should be
 * able to see, without reading a word, that every event touching money is
 * the same colour as every other engine.
 */

type Walkthrough = { id: string; title: string; question: string; seconds: number };

type Ev = {
  seq: number;
  type: string;
  actor: string;
  actorName: string;
  actorKind: "model" | "engine" | "person" | "system";
  actorDoes: string;
  actorCannot?: string;
  stage: string;
  summary: string;
  pivotal: string | null;
  payload?: Record<string, unknown>;
  at: string;
};

type StepResult = {
  id: string;
  title: string;
  proves: string;
  method: string;
  path: string;
  reviewsPrevious: boolean;
  status: number;
  ok: boolean;
  refusedAsExpected: boolean;
  skipped: boolean;
  ms: number;
  response: Record<string, unknown>;
  events: Ev[];
  error?: string;
};

type RunResult = {
  walkthrough: { id: string; title: string; question: string };
  results: StepResult[];
  summary: {
    steps: number; passed: number; skipped: number; events: number;
    models: number; engines: number; people: number; pivotal: number;
  };
};

/** One colour per kind, and models never share with engines. That is the point. */
const KIND: Record<string, { label: string; colour: string; wash: string; blurb: string }> = {
  model: {
    label: "language model",
    colour: "var(--neel)",
    wash: "var(--neel-wash)",
    blurb: "Reads, classifies, extracts, writes prose. Decides nothing about money.",
  },
  engine: {
    label: "pure function",
    colour: "var(--moss)",
    wash: "var(--moss-wash)",
    blurb: "Same inputs, same output, no network, no model inside. These decide.",
  },
  person: {
    label: "a person",
    colour: "var(--haldi-deep)",
    wash: "var(--haldi-wash)",
    blurb: "Approved, confirmed or declined it.",
  },
  system: {
    label: "platform",
    colour: "var(--ink-faint)",
    wash: "var(--paper-sunk)",
    blurb: "The clock, the seeder, the outbox. Not a decision-maker.",
  },
};

export default function WalkthroughPage() {
  const router = useRouter();
  const [user, setUser] = useState<{ name: string; role: string } | null>(null);
  const [list, setList] = useState<Walkthrough[]>([]);
  const [chosen, setChosen] = useState<string>("");
  const [run, setRun] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");
  const speaker = useSpeaker();

  useEffect(() => {
    api<{ user: { name: string; role: string } | null }>("/api/auth/me")
      .then((r) => (r.user ? setUser(r.user) : router.push("/signin")))
      .catch(() => router.push("/signin"));
    api<{ walkthroughs: Walkthrough[] }>("/api/walkthrough")
      .then((r) => setList(r.walkthroughs ?? []))
      .catch(() => setErr("Could not load the walkthroughs."));
  }, [router]);

  const start = useCallback(async (id: string) => {
    setChosen(id);
    setRunning(true);
    setErr("");
    setRun(null);
    try {
      const r = await api<RunResult>("/api/walkthrough", { json: { id } });
      setRun(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That walkthrough could not be run.");
    }
    setRunning(false);
  }, []);

  if (!user) {
    return (
      <main style={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}>
        <Spinner label="Loading" />
      </main>
    );
  }

  return (
    <Shell user={user}>
      <main className="page">
        <header style={{ maxWidth: "64ch", marginBottom: "1.5rem" }}>
          <h1 style={{ fontSize: "clamp(1.6rem,3.6vw,2.3rem)", marginBottom: ".5rem" }}>
            Watch it work
          </h1>
          <p style={{ color: "var(--ink-soft)", margin: 0, fontSize: ".94rem", lineHeight: 1.65 }}>
            Pick a question. Each one runs for real against the live engines and shows
            every step the agent took &mdash; and, for each step, whether a language
            model or a pure function made the call.
          </p>
          <p
            style={{
              color: "var(--ink-faint)", margin: ".5rem 0 0", fontSize: ".83rem",
              lineHeight: 1.6,
            }}
          >
            Nothing here is recorded, mocked or special-cased. Some steps are supposed
            to be refused, and a step whose outcome differs from what it claimed is
            reported rather than hidden.
          </p>
        </header>

        {err && <Banner tone="brick">{err}</Banner>}

        {/* The legend, before anything runs. Without it the colours are
            decoration; with it they are the argument. */}
        <section
          className="card"
          style={{ padding: "1rem 1.1rem", marginBottom: "1.4rem" }}
        >
          <strong style={{ fontSize: ".82rem", textTransform: "uppercase", letterSpacing: ".05em", color: "var(--ink-faint)" }}>
            Who is who
          </strong>
          <div
            style={{
              display: "grid", gap: ".7rem", marginTop: ".7rem",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 15rem), 1fr))",
            }}
          >
            {(["model", "engine", "person"] as const).map((k) => (
              <div key={k} style={{ display: "grid", gap: ".2rem" }}>
                <div style={{ display: "flex", gap: ".45rem", alignItems: "center" }}>
                  <span
                    aria-hidden
                    style={{
                      flexShrink: 0, width: 12, height: 12, borderRadius: 3,
                      background: KIND[k].colour,
                    }}
                  />
                  <span
                    className="ev-kind"
                    style={{ color: KIND[k].colour }}
                  >
                    {KIND[k].label}
                  </span>
                </div>
                <span style={{ color: "var(--ink-soft)", fontSize: ".8rem", lineHeight: 1.5 }}>
                  {KIND[k].blurb}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* ── Pick a journey ───────────────────────────────────────────── */}
        <div style={{ display: "grid", gap: ".6rem", marginBottom: "1.6rem" }}>
          {list.map((w) => (
            <button
              key={w.id}
              className="journey"
              onClick={() => void start(w.id)}
              disabled={running}
              data-chosen={chosen === w.id}
            >
              <div style={{ display: "flex", gap: ".6rem", alignItems: "baseline", flexWrap: "wrap" }}>
                <strong style={{ fontSize: ".98rem", flex: 1, minWidth: 0 }}>{w.title}</strong>
                <Chip tone="neutral">~{w.seconds}s</Chip>
                {running && chosen === w.id && <Spinner label="Running" />}
              </div>
              {/* The question, in the judge's own words. It is what they are
                  choosing between, so it is not demoted to a caption. */}
              <div style={{ color: "var(--neel-ink)", fontSize: ".86rem" }}>
                {w.question}
              </div>
            </button>
          ))}
        </div>

        {/* ── The trail ────────────────────────────────────────────────── */}
        {run && (
          <section>
            <div
              className="card"
              style={{ padding: "1.1rem 1.2rem", marginBottom: "1.2rem" }}
            >
              <div style={{ display: "flex", gap: ".7rem", alignItems: "baseline", flexWrap: "wrap", justifyContent: "space-between" }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: "1.02rem" }}>{run.walkthrough.title}</strong>
                  <div style={{ color: "var(--ink-soft)", fontSize: ".85rem", marginTop: ".15rem" }}>
                    {run.walkthrough.question}
                  </div>
                </div>
                <SpeakButton
                  text={spokenSummary(run)}
                  speaker={speaker}
                  label="Say what happened"
                />
              </div>

              {/* The four numbers a presenter reads out, at a size they can
                  be read out from. */}
              <dl className="tally">
                <div>
                  <dt>Steps as expected</dt>
                  <dd style={{ color: run.summary.passed === run.summary.steps ? "var(--moss)" : "var(--haldi-deep)" }}>
                    {run.summary.passed}/{run.summary.steps}
                  </dd>
                </div>
                <div>
                  <dt>Model calls</dt>
                  <dd style={{ color: "var(--neel)" }}>{run.summary.models}</dd>
                </div>
                <div>
                  <dt>Engine decisions</dt>
                  <dd style={{ color: "var(--moss)" }}>{run.summary.engines}</dd>
                </div>
                {run.summary.people > 0 && (
                  <div>
                    <dt>Needed a person</dt>
                    <dd style={{ color: "var(--haldi-deep)" }}>{run.summary.people}</dd>
                  </div>
                )}
                {run.summary.pivotal > 0 && (
                  <div>
                    <dt>Worth stopping on</dt>
                    <dd style={{ color: "var(--brick)" }}>{run.summary.pivotal}</dd>
                  </div>
                )}
              </dl>

              {/* Every actor in the run, in order, as one strip. The
                  alternation between a model reading and an engine deciding is
                  the architecture, and here it is visible without reading. */}
              <Handoff run={run} />

              {run.summary.skipped > 0 && (
                <div style={{ fontSize: ".78rem", color: "var(--ink-faint)", marginTop: ".7rem" }}>
                  {run.summary.skipped}{" "}
                  {run.summary.skipped === 1 ? "step needs" : "steps need"} a different
                  sign-in and {run.summary.skipped === 1 ? "was" : "were"} left out of the
                  count rather than marked failed.
                </div>
              )}
            </div>

            <ol className="trail">
              {run.results.map((r, i) => (
                <Step key={r.id} step={r} index={i + 1} />
              ))}
            </ol>

            <p
              style={{
                fontSize: ".8rem", color: "var(--ink-faint)", marginTop: "1.2rem",
                maxWidth: "62ch", lineHeight: 1.6,
              }}
            >
              Every row above came from the platform&rsquo;s own append-only event stream,
              which is what{" "}
              <Link href="/desk" style={{ color: "var(--neel-ink)" }}>the desk</Link>,{" "}
              <Link href="/orders" style={{ color: "var(--neel-ink)" }}>your orders</Link>{" "}
              and the emails are all projections of. The walkthrough called the same HTTP
              routes the UI calls, so the gates it hit are the real ones.
            </p>
          </section>
        )}
      </main>
    </Shell>
  );
}

/* ───────────────────────── The handoff strip ───────────────────────── */

/**
 * Every actor in the run, in order, one coloured segment each.
 *
 * The argument this page exists to make is that models and engines alternate:
 * a model reads, an engine decides, a model writes up the decision it was
 * handed. Said in prose that takes a paragraph. Shown as a strip it takes no
 * reading at all, which matters when the person looking has three minutes.
 *
 * Review steps are excluded because they re-report events an earlier step
 * already caused, and a strip that counted them twice would overstate the
 * number of model calls.
 */
function Handoff({ run }: { run: RunResult }) {
  const events = run.results.filter((r) => !r.reviewsPrevious).flatMap((r) => r.events);
  if (events.length === 0) return null;

  return (
    <>
      <div className="handoff" role="img" aria-label={handoffLabel(events)}>
        {events.map((e) => {
          const kind = KIND[e.actorKind] ?? KIND.system;
          return (
            <span
              key={e.seq}
              title={`${e.actorName} — ${kind.label}`}
              style={{ background: e.pivotal ? "var(--brick)" : kind.colour }}
            />
          );
        })}
      </div>
      <div style={{ fontSize: ".75rem", color: "var(--ink-faint)", marginTop: ".35rem" }}>
        Left to right, in the order it happened.
      </div>
    </>
  );
}

/**
 * The strip, for a screen reader.
 *
 * A list of forty colours is useless read aloud, so what is described is the
 * thing the strip is for: how many of each kind, in sequence.
 */
function handoffLabel(events: Ev[]): string {
  const runs: string[] = [];
  for (const e of events) {
    const kind = (KIND[e.actorKind] ?? KIND.system).label;
    if (runs[runs.length - 1] !== kind) runs.push(kind);
  }
  return `${events.length} events, alternating: ${runs.join(", then ")}.`;
}

/* ──────────────────────────── One step ──────────────────────────── */

function Step({ step, index }: { step: StepResult; index: number }) {
  const tone = step.skipped ? "skip" : step.ok ? "pass" : "fail";

  return (
    <li data-tone={tone}>
      {/* The marker on the spine. Position carries the sequence; colour
          carries the outcome. */}
      <span className="pip" aria-hidden />

      <div
        className="card"
        style={{ padding: "1.05rem 1.15rem", opacity: step.skipped ? 0.72 : 1 }}
      >
        <div style={{ display: "flex", gap: ".55rem", alignItems: "baseline", flexWrap: "wrap" }}>
          <span
            className="mono"
            style={{ fontSize: ".72rem", color: "var(--ink-faint)", flexShrink: 0 }}
          >
            {String(index).padStart(2, "0")}
          </span>
          <strong style={{ fontSize: ".95rem", flex: 1, minWidth: 0 }}>{step.title}</strong>
          {step.refusedAsExpected && <Chip tone="brick">refused, as it should be</Chip>}
          {step.skipped && <Chip tone="neutral">not runnable as you</Chip>}
          {step.reviewsPrevious && <Chip tone="neutral">a second look</Chip>}
          {!step.error && <Chip tone="neutral">{step.ms}ms</Chip>}
        </div>

        {/* The claim. This is the sentence a judge is meant to read, so it
            gets a measure and a size that invite reading rather than
            scanning. */}
        <p
          style={{
            fontSize: ".875rem", color: "var(--ink-soft)", lineHeight: 1.66,
            margin: ".5rem 0 0", maxWidth: "68ch",
          }}
        >
          {step.proves}
        </p>

        {step.error && (
          <div
            style={{
              fontSize: ".81rem", color: "var(--ink-soft)", marginTop: ".6rem",
              padding: ".5rem .65rem", background: "var(--paper-sunk)", borderRadius: 7,
            }}
          >
            {step.error}
          </div>
        )}

        {step.events.length > 0 && (
          <ul
            style={{
              listStyle: "none", margin: ".9rem 0 0", padding: 0,
              display: "grid", gap: ".35rem",
            }}
          >
            {step.events.map((e) => (
              <EventRow key={e.seq} event={e} />
            ))}
          </ul>
        )}

        {!step.error && (
          <div style={{ marginTop: ".75rem" }}>
            <Disclosure summary={`What the call returned · ${step.method} ${step.path}`}>
              <pre
                className="mono scroll-thin"
                style={{
                  fontSize: ".72rem", lineHeight: 1.55, overflowX: "auto", margin: 0,
                  background: "var(--paper-sunk)", padding: ".7rem", borderRadius: 8,
                }}
              >
                {JSON.stringify(step.response, null, 2)}
              </pre>
            </Disclosure>
          </div>
        )}
      </div>
    </li>
  );
}

function EventRow({ event }: { event: Ev }) {
  const kind = KIND[event.actorKind] ?? KIND.system;

  return (
    <li
      className="ev"
      data-pivotal={event.pivotal ? "true" : "false"}
      style={{
        borderLeftColor: event.pivotal ? "var(--brick)" : kind.colour,
        background: event.pivotal ? undefined : kind.wash,
      }}
    >
      <div style={{ display: "flex", gap: ".5rem", alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: ".83rem", color: kind.colour }}>{event.actorName}</strong>
        {/* The kind in words as well as in colour: the claim must survive a
            judge who cannot distinguish indigo from green. */}
        <span className="ev-kind" style={{ color: kind.colour, opacity: 0.85 }}>
          {kind.label}
        </span>
        <span
          className="mono"
          style={{ fontSize: ".7rem", color: "var(--ink-faint)", marginLeft: "auto" }}
        >
          {event.type}
        </span>
      </div>

      <div style={{ fontSize: ".85rem", color: "var(--ink)" }}>{event.summary}</div>

      {/* The one line that tells a judge why this actor is allowed to do
          this, and what it is structurally prevented from doing. */}
      <div style={{ fontSize: ".745rem", color: "var(--ink-soft)", lineHeight: 1.52 }}>
        {event.actorDoes}
        {event.actorCannot && (
          <>
            {" "}
            <span style={{ color: "var(--brick)", fontWeight: 550 }}>
              Cannot: {event.actorCannot}
            </span>
          </>
        )}
      </div>

      {event.pivotal && (
        <div
          style={{
            fontSize: ".8rem", color: "var(--brick)", fontWeight: 600,
            display: "flex", gap: ".35rem",
          }}
        >
          <span aria-hidden>&#8627;</span>
          <span>{event.pivotal}</span>
        </div>
      )}

      {event.payload && Object.keys(event.payload).length > 0 && (
        <Disclosure summary="What it recorded">
          <pre
            className="mono scroll-thin"
            style={{ fontSize: ".7rem", lineHeight: 1.5, overflowX: "auto", margin: 0 }}
          >
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </Disclosure>
      )}
    </li>
  );
}

/**
 * The run, in one spoken paragraph.
 *
 * Said rather than read because a presenter is usually talking over this
 * screen, and the counts are the part worth hearing: how many model calls,
 * how many engine decisions, and whether anything stopped for a human.
 */
function spokenSummary(run: RunResult): string {
  const s = run.summary;
  const parts = [
    `${s.steps} steps ran.`,
    `${s.models} ${s.models === 1 ? "call" : "calls"} to a language model,`,
    `and ${s.engines} ${s.engines === 1 ? "decision" : "decisions"} by a pure function.`,
  ];
  if (s.people > 0) parts.push(`${s.people} needed a person.`);
  if (s.pivotal > 0) {
    parts.push(
      `${s.pivotal} ${s.pivotal === 1 ? "moment is" : "moments are"} worth stopping on — a gate, a refusal, or a decision handed to a human.`,
    );
  }
  return parts.join(" ");
}
