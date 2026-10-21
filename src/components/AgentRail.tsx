"use client";

import { useEffect, useRef, useState } from "react";
import {
  api, Chip, INR, shouldSpeakAnswer, SpeakButton, Spinner, useRecorder, useSpeaker,
} from "@/components/ui";

/**
 * The shopping agent, as a persistent rail rather than a floating bubble.
 *
 * A support widget sits in the corner and waits to be summoned. This is a
 * co-shopper: it is always open beside the catalogue, it fills the same cart
 * the buyer can see, and every item it adds carries its reason. The placement
 * is the argument.
 */

type Msg = { role: "user" | "assistant"; content: string; at?: string };
type ToolCall = { name: string; args: Record<string, unknown>; ok: boolean; summary: string };
type Requirements = Record<string, unknown>;

/** A microphone, drawn rather than borrowed from the emoji table. */
function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 15a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 1 0-7 0v5.5A3.5 3.5 0 0 0 12 15Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

const LANGS = [
  { code: "en", label: "English", hint: "I need running shoes under 2000" },
  { code: "hi", label: "हिन्दी", hint: "2000 ke andar ek accha running shoe chahiye" },
  { code: "kn", label: "ಕನ್ನಡ", hint: "2000 ರೂಪಾಯಿ ಒಳಗೆ ಒಳ್ಳೆಯ ಶೂ ಬೇಕು" },
  { code: "ta", label: "தமிழ்", hint: "2000 ரூபாய்க்குள் நல்ல காலணி வேண்டும்" },
  { code: "te", label: "తెలుగు", hint: "2000 లోపు మంచి షూ కావాలి" },
  { code: "mr", label: "मराठी", hint: "2000 च्या आत चांगले बूट हवे" },
  { code: "bn", label: "বাংলা", hint: "2000 টাকার মধ্যে ভাল জুতা চাই" },
  { code: "gu", label: "ગુજરાતી", hint: "2000 ની અંદર સારા જૂતા જોઈએ" },
];

export default function AgentRail({ onCartChange }: { onCartChange: () => void }) {
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [trace, setTrace] = useState<ToolCall[]>([]);
  const [requirements, setRequirements] = useState<Requirements>({});
  const [input, setInput] = useState("");
  const [lang, setLang] = useState("en");
  const [busy, setBusy] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  const [err, setErr] = useState("");

  const { recording, error: micError, start, stop } = useRecorder();
  const speaker = useSpeaker();
  /**
   * Speak the agent's replies.
   *
   * Turned on by using the mic rather than by a setting: a buyer who talked to
   * the agent wants to be answered, and that is a better signal than a toggle
   * nobody finds. Replies are spoken as they arrive from then on.
   */
  const [autoSpeak, setAutoSpeak] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  /* The arrival greeting is spoken by the shell, not here. */

  // Seconds recorded so far. Without this the only sign that the microphone is
  // live is a pulsing ring, which says nothing about how much has been caught.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!recording) {
      setElapsed(0);
      return;
    }
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  useEffect(() => {
    const saved = localStorage.getItem("vaanijya.session");
    if (saved) {
      setSessionId(saved);
      api<{ messages: Msg[]; requirements: Requirements }>(`/api/agent/shop?sessionId=${saved}`)
        .then((r) => {
          setMessages(r.messages ?? []);
          setRequirements(r.requirements ?? {});
        })
        .catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setErr("");
    setInput("");
    setMessages((m) => [...m, { role: "user", content: trimmed }]);
    setBusy(true);

    try {
      const r = await api<{
        sessionId: string; reply: string; toolCalls: ToolCall[];
        degraded: boolean; requirements: Requirements;
      }>("/api/agent/shop", { json: { message: trimmed, sessionId: sessionId || undefined, lang } });

      setSessionId(r.sessionId);
      localStorage.setItem("vaanijya.session", r.sessionId);
      setMessages((m) => [...m, { role: "assistant", content: r.reply }]);
      // The first reply of a session speaks itself, so the voice is
      // discovered rather than advertised by an icon. After that the toggle
      // decides. See `shouldSpeakAnswer`.
      if (r.reply && shouldSpeakAnswer("rail", autoSpeak)) {
        void speaker.speak(r.reply, lang);
        // Having heard one reply, the buyer knows what the toggle does, so it
        // is switched on and they can switch it off.
        setAutoSpeak(true);
      }
      setTrace((t) => [...t, ...(r.toolCalls ?? [])]);
      setRequirements(r.requirements ?? {});
      setDegraded(r.degraded);
      if ((r.toolCalls ?? []).some((c) => c.name === "add_to_cart" || c.name === "remove_from_cart")) {
        onCartChange();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The agent did not respond.");
    }
    setBusy(false);
  }

  async function toggleMic() {
    if (recording) {
      const blob = await stop();
      if (!blob) return;
      setBusy(true);
      try {
        const fd = new FormData();
        fd.append("audio", blob, "speech.webm");
        const r = await api<{ text: string; scriptLanguage: string }>("/api/agent/voice", {
          method: "POST", body: fd,
        });
        setLang(r.scriptLanguage || lang);
        setBusy(false);
        // They spoke to us; answer out loud from here on.
        setAutoSpeak(true);
        await send(r.text);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Transcription failed.");
        setBusy(false);
      }
    } else {
      await start();
    }
  }

  const hint = LANGS.find((l) => l.code === lang)?.hint ?? LANGS[0].hint;
  // `category_said` is the buyer's own phrase and `category` is the normalised
  // catalogue value. Showing both would read as a duplicate, so prefer theirs.
  const reqEntries = Object.entries(requirements)
    .filter(([k]) => !(k === "category" && "category_said" in requirements))
    .map(([k, v]) => [k === "category_said" ? "category" : k, v] as [string, unknown])
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length));

  return (
    <aside
      className={`card rail${messages.length === 0 && !busy ? " rail-idle" : ""}`}
      aria-label="Shopping agent"
    >
      <header style={{ padding: ".85rem 1rem", borderBottom: "1px solid var(--rule)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: ".75rem" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: ".92rem" }}>Shopping agent</div>
            <div style={{ fontSize: ".74rem", color: "var(--ink-faint)" }}>
              {degraded
                ? "using a simpler search right now"
                : "say what you need, in your own language"}
            </div>
          </div>
          <select
            className="field"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            aria-label="Language"
            style={{ width: "auto", padding: ".3rem .5rem", fontSize: ".8rem" }}
          >
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>

        {reqEntries.length > 0 && (
          <div style={{ display: "flex", gap: ".3rem", flexWrap: "wrap", marginTop: ".6rem" }}>
            {reqEntries.map(([k, v]) => (
              <Chip key={k} tone="gold">
                {k === "budget_inr" ? `under ${INR(Number(v))}` : `${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : String(v)}`}
              </Chip>
            ))}
          </div>
        )}
      </header>

      <div ref={scroller} className="scroll-thin rail-body">
        {messages.length === 0 && (
          <div style={{ color: "var(--ink-faint)", fontSize: ".86rem", lineHeight: 1.7 }}>
            <p style={{ marginTop: 0, marginBottom: ".75rem" }}>
              Say what you need — type or speak, any language.
            </p>
            {[hint, "something for my mother's kitchen under 2000", "wireless earbuds with noise cancelling"].map((s) => (
              <button key={s} className="seed" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className="turn enter">
            <div
              style={{
                display: "flex", gap: ".5rem", alignItems: "baseline",
                justifyContent: "space-between",
              }}
            >
              <div className="turn-who">{m.role === "user" ? "You" : "Agent"}</div>
              {/* Only on the agent's latest reply: a listen button beside every
                  historical turn is clutter, and nobody replays turn three. */}
              {m.role === "assistant" && i === messages.length - 1 && (
                <SpeakButton text={m.content} lang={lang} speaker={speaker} />
              )}
            </div>
            <div className={m.role === "user" ? "turn-you" : "turn-agent"}>{m.content}</div>
          </div>
        ))}

        {busy && (
          <div className="enter" style={{ paddingLeft: ".7rem" }}>
            <Spinner label="Searching the catalogue" />
            <div className="working" style={{ marginTop: ".4rem" }} />
          </div>
        )}
        {err && <div style={{ color: "var(--brick)", fontSize: ".84rem", marginTop: ".5rem" }}>{err}</div>}
        {micError && <div style={{ color: "var(--brick)", fontSize: ".84rem", marginTop: ".5rem" }}>{micError}</div>}
      </div>

      {trace.length > 0 && (
        <div style={{ borderTop: "1px solid var(--rule)", padding: ".5rem 1rem", background: "var(--paper-sunk)" }}>
          <button
            onClick={() => setShowTrace((s) => !s)}
            aria-expanded={showTrace}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: ".76rem", color: "var(--neel)", fontWeight: 550 }}
          >
            {showTrace ? "Hide" : "Show"} what the agent looked up ({trace.length})
          </button>
          {showTrace && (
            <div className="scroll-thin" style={{ maxHeight: "9rem", overflowY: "auto", marginTop: ".4rem" }}>
              {trace.slice(-12).map((t, i) => (
                <div key={i} className="mono" style={{ fontSize: ".72rem", color: t.ok ? "var(--ink-faint)" : "var(--brick)", padding: ".15rem 0" }}>
                  {t.name} &middot; {t.summary}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); send(input); }}
        style={{ borderTop: "1px solid var(--rule)", padding: ".7rem", display: "flex", gap: ".4rem" }}
      >
        <button
          type="button"
          onClick={toggleMic}
          disabled={busy}
          aria-label={recording ? "Stop recording and send" : "Record a voice note"}
          className={`btn btn-ghost btn-sm${recording ? " pulse-rec" : ""}`}
          style={recording ? { borderColor: "var(--brick)", color: "var(--brick)" } : undefined}
        >
          {recording ? (
            <>
              <span
                aria-hidden
                style={{ width: 8, height: 8, borderRadius: 2, background: "var(--brick)" }}
              />
              {elapsed}s
            </>
          ) : (
            <MicIcon />
          )}
        </button>
        <input
          className="field"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={recording ? "Listening…" : hint}
          disabled={busy || recording}
          aria-label="Message the shopping agent"
        />
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}
