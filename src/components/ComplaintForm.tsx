"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  api, Banner, Chip, INR, Ladder, SpeakButton, Spinner, SuspicionBar,
  useGreeting, useRecorder, useSpeaker, humanise,
} from "@/components/ui";
import { narrateAssessment, narrateGreeting } from "@/lib/speech/narrate";
import PlanTrace, { type PlanShape } from "@/components/PlanTrace";

/**
 * Reporting a defect.
 *
 * The buyer writes or speaks in their own language and attaches photographs.
 * Nothing here asks them to classify the problem, pick a remedy or name a
 * policy — that is the system's job, and asking a frustrated customer to do
 * triage is how complaints get abandoned.
 */

type Order = {
  orderNo: string;
  items: { sku: string; title: string; boxContents: string[] }[];
};

type Outcome = {
  claimNo: string;
  state: string;
  triage: { issueType: string; confidence: number; lang: string; translated: string; degraded: boolean };
  verdict: {
    eligible: boolean; remedy: string; amountInr: number;
    deadlineAt: string | null; clauseIds: string[]; reasons: string[]; confidence: number;
  };
  authenticity: { verdict: string; score: number; narrative: string };
  draft: string;
  visionFindings: { filename: string; defectVisible: boolean; defectKind: string; matchesClaim: string; observations: string[] }[];
  degraded: boolean;
  plan: PlanShape;
  budget: { stepsUsed: number; replansUsed: number; exhausted: boolean };
};

const LANGS = [
  { code: "", label: "Detect it for me" },
  { code: "en", label: "English" }, { code: "hi", label: "हिन्दी" },
  { code: "kn", label: "ಕನ್ನಡ" }, { code: "ta", label: "தமிழ்" },
  { code: "te", label: "తెలుగు" }, { code: "mr", label: "मराठी" },
  { code: "bn", label: "বাংলা" }, { code: "gu", label: "ગુજરાતી" },
];

const MAX_FILES = 4;

export default function ComplaintForm({
  order,
  onClose,
  onFiled,
}: {
  order: Order;
  onClose: () => void;
  onFiled: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const [lang, setLang] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const { recording, error: micError, start, stop } = useRecorder();
  const speaker = useSpeaker();

  /**
   * Ask, out loud, what went wrong.
   *
   * This is the screen where a spoken prompt earns the most. The buyer is
   * annoyed, the form asks for free text in any language, and being asked a
   * question is what makes it obvious they can just talk — which is the whole
   * point of the microphone sitting next to the box.
   *
   * No name in this one. See `narrateGreeting`.
   */
  useGreeting(speaker, narrateGreeting("complaint"), { stage: "complaint" });

  function pickFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files, ...Array.from(list)].slice(0, MAX_FILES);
    setFiles(next);
  }

  async function toggleMic() {
    if (recording) {
      const blob = await stop();
      if (blob) setAudio(blob);
    } else {
      setAudio(null);
      await start();
    }
  }

  async function submit() {
    if (!text.trim() && !audio) {
      setErr("Tell us what went wrong — type it, or record a voice note.");
      return;
    }
    setErr("");
    setBusy(true);

    try {
      const fd = new FormData();
      fd.append("orderNo", order.orderNo);
      fd.append("complaint", text);
      if (lang) fd.append("lang", lang);
      for (const f of files) fd.append("evidence", f);
      if (audio) fd.append("audio", audio, "complaint.webm");

      const r = await api<Outcome>("/api/claims", { method: "POST", body: fd });
      setOutcome(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "We could not file that complaint.");
    }
    setBusy(false);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Report a problem with order ${order.orderNo}`}
      className="scrim"
      style={{
        position: "fixed", inset: 0, background: "rgba(16,18,28,.45)",
        backdropFilter: "blur(2px)",
        display: "grid", placeItems: "center", padding: "1rem", zIndex: 80,
        overflowY: "auto",
      }}
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        className="card lift"
        style={{ width: "100%", maxWidth: "40rem", padding: "1.4rem", maxHeight: "92dvh", overflowY: "auto" }}
      >
        {!outcome ? (
          <>
            <h2 style={{ marginBottom: ".3rem" }}>What went wrong?</h2>
            <p style={{ color: "var(--ink-soft)", fontSize: ".88rem", marginBottom: "1.1rem" }}>
              {order.items[0]?.title} · {order.orderNo}. Write in whatever language
              you think in, or record a voice note. Photographs of the problem help a lot.
            </p>

            <label style={{ display: "block", marginBottom: ".9rem" }}>
              <span style={{ fontSize: ".82rem", fontWeight: 550, display: "block", marginBottom: ".3rem" }}>
                Describe the problem
              </span>
              <textarea
                className="field"
                rows={4}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="ಇಯರ್‌ಬಡ್ ಬಂದಿದೆ ಆದರೆ ಬಲ ಭಾಗ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ  /  the right earbud does not work"
                style={{ resize: "vertical", lineHeight: 1.6 }}
                disabled={busy}
              />
            </label>

            <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", marginBottom: ".9rem", alignItems: "center" }}>
              <select
                className="field"
                style={{ width: "auto" }}
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                aria-label="Language of your complaint"
                disabled={busy}
              >
                {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>

              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={toggleMic}
                disabled={busy}
                style={recording ? { borderColor: "var(--brick)", color: "var(--brick)" } : undefined}
              >
                {recording ? "■ Stop recording" : audio ? "🎙 Re-record" : "🎙 Record instead"}
              </button>

              {audio && !recording && <Chip tone="moss">voice note attached</Chip>}
            </div>

            <label style={{ display: "block", marginBottom: ".9rem" }}>
              <span style={{ fontSize: ".82rem", fontWeight: 550, display: "block", marginBottom: ".3rem" }}>
                Photographs of the problem ({files.length}/{MAX_FILES})
              </span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={(e) => pickFiles(e.target.files)}
                disabled={busy || files.length >= MAX_FILES}
                style={{ fontSize: ".84rem" }}
              />
            </label>

            {files.length > 0 && (
              <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
                {files.map((f, i) => (
                  <div key={i} style={{ position: "relative" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={URL.createObjectURL(f)}
                      alt={f.name}
                      style={{ width: 70, height: 70, objectFit: "cover", borderRadius: 7, border: "1px solid var(--rule)" }}
                    />
                    <button
                      onClick={() => setFiles(files.filter((_, j) => j !== i))}
                      aria-label={`Remove ${f.name}`}
                      style={{
                        position: "absolute", top: -6, right: -6, width: 20, height: 20,
                        borderRadius: "50%", border: "1px solid var(--rule)", background: "var(--paper-raised)",
                        cursor: "pointer", fontSize: ".7rem", lineHeight: 1, color: "var(--ink-soft)",
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {(err || micError) && (
              <div style={{ color: "var(--brick)", fontSize: ".85rem", marginBottom: ".8rem" }}>
                {err || micError}
              </div>
            )}

            <Banner tone="indigo">
              The agent reads your complaint and the photographs, then a rule
              engine decides what you are owed under the returns policy. A person
              approves it before anything is paid.
            </Banner>

            <div style={{ display: "flex", gap: ".5rem", marginTop: "1.1rem", justifyContent: "flex-end" }}>
              <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn btn-accent" onClick={submit} disabled={busy}>
                {busy ? <Spinner label="Assessing" /> : "Send this to the agent"}
              </button>
            </div>
          </>
        ) : (
          <Result
            outcome={outcome}
            speaker={speaker}
            onDone={() => onFiled(`${outcome.claimNo} filed. We have emailed you a copy.`)}
          />
        )}
      </div>
    </div>
  );
}

/** What the agent concluded, shown immediately rather than "we'll be in touch". */
function Result({
  outcome,
  speaker,
  onDone,
}: {
  outcome: Outcome;
  speaker: ReturnType<typeof useSpeaker>;
  onDone: () => void;
}) {
  const v = outcome.verdict;
  const handoff = outcome.state === "HUMAN_HANDOFF";

  /**
   * The verdict in one spoken sentence.
   *
   * Spoken in the buyer's own language, because the assessment is the moment
   * they most need to understand and least want to read: there is a suspicion
   * bar, a clause list and a vision report on this screen, and none of it
   * answers "am I getting my money".
   */
  const spoken = useMemo(
    () =>
      narrateAssessment({
        claimNo: outcome.claimNo,
        eligible: v.eligible,
        remedy: v.remedy,
        amountInr: v.amountInr,
        handoff,
      }),
    [outcome.claimNo, v.eligible, v.remedy, v.amountInr, handoff],
  );

  /**
   * Say the verdict as the screen appears.
   *
   * The strongest case for speaking unprompted: this page carries a suspicion
   * bar, a clause list and a vision report, and none of it answers the only
   * question the buyer has. Spoken in the language they complained in.
   *
   * Once per claim, and never if the agent has been silenced.
   */
  const spokeFor = useRef("");
  useEffect(() => {
    if (spokeFor.current === outcome.claimNo) return;
    if (!spoken) return;
    spokeFor.current = outcome.claimNo;
    void speaker.speak(spoken, outcome.triage.lang || "en");
    // `speaker` identity changes each render and must not re-trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome.claimNo, spoken]);

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: ".6rem", flexWrap: "wrap" }}>
        <h2 style={{ marginBottom: ".3rem" }}>
          {handoff ? "A person will look at this" : v.eligible ? "You are covered" : "What we found"}
        </h2>
        <SpeakButton text={spoken} lang={outcome.triage.lang || "en"} speaker={speaker} />
      </div>
      <p style={{ color: "var(--ink-soft)", fontSize: ".88rem", marginBottom: "1rem" }}>
        Complaint <span className="mono">{outcome.claimNo}</span> · classified as{" "}
        {humanise(outcome.triage.issueType)}
        {outcome.triage.lang !== "en" && ` · read in ${outcome.triage.lang}`}
      </p>

      <div
        style={{
          padding: ".9rem", borderRadius: 9, marginBottom: "1rem",
          background: handoff ? "var(--haldi-wash)" : v.eligible ? "var(--moss-wash)" : "var(--paper-sunk)",
          borderLeft: `3px solid ${handoff ? "var(--haldi-deep)" : v.eligible ? "var(--moss)" : "var(--rule-strong)"}`,
        }}
      >
        <div style={{ fontSize: "1.05rem", fontWeight: 650, marginBottom: ".25rem" }}>
          {handoff
            ? "Routed to a human reviewer"
            : v.eligible
              ? `${humanise(v.remedy)}${v.amountInr > 0 ? ` of ${INR(v.amountInr)}` : ""}`
              : "No remedy under this policy"}
        </div>
        <div style={{ fontSize: ".84rem", color: "var(--ink-soft)" }}>
          {handoff
            ? "The evidence does not settle this either way, so we are not deciding it automatically."
            : v.clauseIds.length > 0
              ? `Under clause ${v.clauseIds.join(", ")}`
              : "Based on the returns policy for this category"}
          {v.deadlineAt && !handoff && (
            <> · to be completed by {new Date(v.deadlineAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</>
          )}
        </div>
      </div>

      {outcome.visionFindings.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: ".82rem", fontWeight: 550, marginBottom: ".4rem" }}>What we saw in your photographs</div>
          {outcome.visionFindings.map((f, i) => (
            <div key={i} style={{ fontSize: ".84rem", color: "var(--ink-soft)", padding: ".3rem 0", borderTop: "1px solid var(--rule)" }}>
              <Chip tone={f.matchesClaim === "supports" ? "moss" : f.matchesClaim === "contradicts" ? "brick" : "neutral"}>
                {f.matchesClaim}
              </Chip>{" "}
              {f.defectVisible ? f.defectKind : "no visible defect"}
              {f.observations.length > 0 && (
                <div style={{ fontSize: ".78rem", color: "var(--ink-faint)", marginTop: ".2rem" }}>
                  {f.observations.join(" · ")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontSize: ".82rem", fontWeight: 550, marginBottom: ".45rem" }}>How we read the evidence</div>
        <SuspicionBar score={outcome.authenticity.score} verdict={outcome.authenticity.verdict} />
        <p style={{ fontSize: ".82rem", color: "var(--ink-faint)", marginTop: ".45rem", marginBottom: 0, lineHeight: 1.6 }}>
          {outcome.authenticity.narrative}
        </p>
      </div>

      <details style={{ marginBottom: ".6rem" }}>
        <summary style={{ cursor: "pointer", fontSize: ".84rem", color: "var(--neel)", fontWeight: 550 }}>
          The full reasoning
        </summary>
        <div style={{ paddingTop: ".5rem" }}>
          <Ladder reasons={v.reasons} />
        </div>
      </details>

      {outcome.plan?.steps?.length > 0 && (
        <details style={{ marginBottom: "1rem" }}>
          <summary style={{ cursor: "pointer", fontSize: ".84rem", color: "var(--neel)", fontWeight: 550 }}>
            Every step the agent took ({outcome.plan.steps.length})
          </summary>
          <div style={{ paddingTop: ".6rem" }}>
            <PlanTrace plan={outcome.plan} budget={outcome.budget} />
          </div>
        </details>
      )}

      <Banner tone={handoff ? "gold" : "indigo"}>
        Nothing has been paid yet. A platform operator reviews this and you will be
        emailed the decision with the clause it rests on.
      </Banner>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.1rem" }}>
        <button className="btn btn-primary" onClick={onDone}>Done</button>
      </div>
    </>
  );
}
