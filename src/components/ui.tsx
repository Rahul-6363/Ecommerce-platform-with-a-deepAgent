"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const INR = (n: number) => `₹${Math.trunc(n || 0).toLocaleString("en-IN")}`;
export const humanise = (s: string) => (s ?? "").replace(/_/g, " ").toLowerCase();

export function Chip({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "gold" | "indigo" | "moss" | "brick";
  children: React.ReactNode;
}) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

/** Order and claim states, coloured by what they mean rather than by rank. */
export function StateChip({ state }: { state: string }) {
  const tone =
    state === "RESOLVED" || state === "DELIVERED" || state === "APPROVED"
      ? "moss"
      : state === "REJECTED" || state === "RTO" || state === "CANCELLED"
        ? "brick"
        : state.startsWith("ESCALATED") || state === "HUMAN_HANDOFF"
          ? "gold"
          : state === "AWAITING_APPROVAL"
            ? "indigo"
            : "neutral";
  return <Chip tone={tone as "neutral"}>{humanise(state)}</Chip>;
}

export function RiskDial({ score, band }: { score: number; band: string }) {
  const colour =
    band === "HIGH" ? "var(--brick)" : band === "MEDIUM" ? "var(--haldi-deep)" : "var(--moss)";
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: ".6rem" }}>
      <div
        style={{
          position: "relative",
          width: 44, height: 44, borderRadius: "50%",
          background: `conic-gradient(${colour} ${pct * 3.6}deg, var(--paper-sunk) 0deg)`,
          display: "grid", placeItems: "center", flexShrink: 0,
        }}
        role="img"
        aria-label={`Delivery risk ${score} out of 100, ${band.toLowerCase()}`}
      >
        <div
          style={{
            width: 34, height: 34, borderRadius: "50%", background: "var(--paper-raised)",
            display: "grid", placeItems: "center",
            fontSize: ".8rem", fontWeight: 650, color: colour,
          }}
        >
          {score}
        </div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: ".82rem", fontWeight: 600, color: colour }}>{band}</div>
        <div style={{ fontSize: ".72rem", color: "var(--ink-faint)" }}>delivery risk</div>
      </div>
    </div>
  );
}

/**
 * A horizontal suspicion meter. Deliberately not a dial: a dial reads as a
 * verdict, and this number is advisory — it asks for a person, it never decides.
 */
export function SuspicionBar({ score, verdict }: { score: number; verdict: string }) {
  const colour =
    verdict === "LIKELY_FABRICATED" ? "var(--brick)"
    : verdict === "INCONCLUSIVE" ? "var(--haldi-deep)"
    : "var(--moss)";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: ".3rem" }}>
        <span style={{ fontSize: ".82rem", fontWeight: 600, color: colour }}>
          {humanise(verdict)}
        </span>
        <span className="mono" style={{ color: "var(--ink-faint)" }}>{score}/100</span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: "var(--paper-sunk)", overflow: "hidden" }}>
        <div style={{ width: `${Math.max(2, Math.min(100, score))}%`, height: "100%", background: colour }} />
      </div>
    </div>
  );
}

export function Spinner({ label = "Working" }: { label?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: ".45rem", color: "var(--ink-faint)", fontSize: ".85rem" }}>
      <span aria-hidden style={{ display: "inline-flex", gap: 3 }}>
        {[0, 1, 2].map((i) => (
          <span key={i} className="dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--neel)" }} />
        ))}
      </span>
      {label}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div style={{ padding: "2.5rem 1.25rem", textAlign: "center", color: "var(--ink-faint)" }}>
      <div style={{ fontSize: ".95rem", fontWeight: 550, color: "var(--ink-soft)", marginBottom: ".3rem" }}>
        {title}
      </div>
      {children && <div style={{ fontSize: ".86rem", maxWidth: "34ch", margin: "0 auto" }}>{children}</div>}
    </div>
  );
}

export function Banner({
  tone = "indigo",
  children,
}: {
  tone?: "indigo" | "gold" | "brick" | "moss";
  children: React.ReactNode;
}) {
  const map = {
    indigo: ["var(--neel-wash)", "var(--neel)"],
    gold: ["var(--haldi-wash)", "var(--haldi-deep)"],
    brick: ["var(--brick-wash)", "var(--brick)"],
    moss: ["var(--moss-wash)", "var(--moss)"],
  } as const;
  const [bg, accent] = map[tone];
  return (
    <div
      style={{
        background: bg, borderLeft: `3px solid ${accent}`,
        padding: ".7rem .9rem", borderRadius: "0 8px 8px 0",
        fontSize: ".86rem", color: "var(--ink-soft)", lineHeight: 1.55,
      }}
    >
      {children}
    </div>
  );
}

/** The engine's reasoning, shown as a chain rather than a paragraph. */
export function Ladder({ reasons }: { reasons: string[] }) {
  if (!reasons?.length) return null;
  return (
    <ul className="ladder">
      {reasons.map((r, i) => (
        <li key={i}>{r}</li>
      ))}
    </ul>
  );
}

export function Toast({ message, tone, onDone }: { message: string; tone: "ok" | "err"; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4200);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div
      role="status"
      className="enter"
      style={{
        position: "fixed", bottom: "1.2rem", left: "50%", transform: "translateX(-50%)",
        background: tone === "ok" ? "var(--ink)" : "var(--brick)",
        color: tone === "ok" ? "var(--paper)" : "#fff",
        padding: ".65rem 1.1rem", borderRadius: 9, fontSize: ".875rem",
        boxShadow: "var(--shadow-lift)", zIndex: 90, maxWidth: "min(90vw, 38rem)",
      }}
    >
      {message}
    </div>
  );
}

/** Collapsible detail. Used wherever a reviewer may or may not want the depth. */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: ".4rem", background: "none",
          border: "none", padding: ".25rem 0", cursor: "pointer",
          fontSize: ".82rem", fontWeight: 550, color: "var(--neel)",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block", transition: "transform .15s ease",
            transform: open ? "rotate(90deg)" : "none", fontSize: ".7rem",
          }}
        >
          ▶
        </span>
        {summary}
      </button>
      {open && <div className="enter" style={{ paddingTop: ".4rem" }}>{children}</div>}
    </div>
  );
}

/**
 * Speak a line of agent text aloud.
 *
 * The counterpart to `useRecorder`: the agent already listens, this lets it
 * answer. Three things it deliberately does:
 *
 *  - **Never autoplays on load.** Browsers block it and buyers hate it. The
 *    first play is always a press; `autoSpeak` only takes effect for messages
 *    that arrive AFTER the buyer has turned it on.
 *  - **Cancels the previous clip.** Two overlapping voices reading two prices
 *    is worse than silence, so starting a new line stops the old one.
 *  - **Fails quietly.** With no ELEVENLABS_API_KEY the endpoint answers 503;
 *    the control then disables itself rather than showing an error for a
 *    feature the buyer never asked for.
 */
export function useSpeaker() {
  const [speaking, setSpeaking] = useState(false);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string>("");

  const stop = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    if (url.current) {
      URL.revokeObjectURL(url.current);
      url.current = "";
    }
    setSpeaking(false);
  }, []);

  /**
   * Speak a line, and say whether it was heard.
   *
   * The return value exists for the greeting: a browser refuses to play audio
   * before the visitor has interacted with the page, and the refusal arrives
   * as a rejected `play()` promise. A caller that cannot tell the difference
   * between "spoken" and "blocked" has no way to arrange a second attempt, so
   * the outcome is reported rather than swallowed.
   */
  const speak = useCallback(
    async (text: string, lang = "en"): Promise<boolean> => {
      if (!text?.trim()) return false;
      // `available` is not consulted here. It controls whether the UI offers
      // to speak; the attempt itself is always made, so that a key configured
      // after this component mounted is noticed rather than locked out.
      // The shell's mute applies to every caller, including explicit Listen
      // buttons: if someone has silenced the agent, a button that speaks
      // anyway is a bug, not a convenience.
      if (!voiceWanted()) return false;
      stop();
      setError("");
      setSpeaking(true);

      try {
        const res = await fetch("/api/speech", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, lang }),
        });

        if (!res.ok) {
          // 503 means the server has no voice key configured: stop offering
          // the feature rather than nagging about it on every reply.
          //
          // Latched for this mount only, and deliberately re-probed below on
          // the next successful call. In development the key can arrive after
          // the page did — a `.env` edit and a server restart — and a hook
          // that gave up permanently would stay silent through the fix, which
          // looks exactly like the feature being broken.
          if (res.status === 503) setAvailable(false);
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error ?? `Could not speak (${res.status})`);
          setSpeaking(false);
          return false;
        }

        // Recovered: a previous 503 must not outlive the condition.
        setAvailable(true);

        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        url.current = objectUrl;

        const el = new Audio(objectUrl);
        audio.current = el;
        el.onended = () => stop();
        el.onerror = () => {
          setError("That audio could not be played.");
          stop();
        };
        await el.play();
        return true;
      } catch (e) {
        // An autoplay block is a NotAllowedError, and it is not a fault worth
        // showing anyone: the page simply has to wait to be touched. Anything
        // else is a genuine failure and is surfaced.
        const blocked = e instanceof DOMException && e.name === "NotAllowedError";
        if (!blocked) setError(e instanceof Error ? e.message : "Playback failed.");
        setSpeaking(false);
        return false;
      }
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  // Silence mid-sentence when the shell's switch is turned off.
  useEffect(() => {
    const hush = () => stop();
    window.addEventListener("vaanijya:hush", hush);
    return () => window.removeEventListener("vaanijya:hush", hush);
  }, [stop]);

  return { speak, stop, speaking, available, error };
}

/**
 * The speak/stop control.
 *
 * Rendered as nothing at all when speech is unavailable: a disabled button for
 * a capability the deployment does not have is just clutter.
 */
export function SpeakButton({
  text,
  lang = "en",
  speaker,
  label = "Listen",
}: {
  text: string;
  lang?: string;
  speaker: ReturnType<typeof useSpeaker>;
  label?: string;
}) {
  if (!speaker.available || !text?.trim()) return null;
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={() => (speaker.speaking ? speaker.stop() : speaker.speak(text, lang))}
      aria-label={speaker.speaking ? "Stop speaking" : `${label}: ${text.slice(0, 60)}`}
    >
      <span aria-hidden>{speaker.speaking ? "◼" : "🔊"}</span>
      {speaker.speaking ? "Stop" : label}
    </button>
  );
}

/**
 * The key under which a buyer's choice about being spoken to is remembered.
 *
 * One switch for the whole product rather than per page: someone who silences
 * the agent on the catalogue has told us something about themselves, not about
 * that screen.
 */
const VOICE_PREF_KEY = "vaanijya.voice";

/** Read the stored preference. Voice is on unless it was turned off. */
export function voiceWanted(): boolean {
  try {
    return window.localStorage.getItem(VOICE_PREF_KEY) !== "off";
  } catch {
    // Private mode, or storage blocked. Default to speaking, since the
    // greeting is the thing that tells someone a voice exists at all.
    return true;
  }
}

export function setVoiceWanted(on: boolean): void {
  try {
    window.localStorage.setItem(VOICE_PREF_KEY, on ? "on" : "off");
  } catch {
    /* nothing to do: the session still honours the in-memory value */
  }
}

/**
 * Speak one line when a buyer arrives on a screen.
 *
 * Three constraints shape this, and all three are about not being obnoxious:
 *
 *  1. **It cannot autoplay.** Every current browser refuses audio before the
 *     visitor has interacted with the page, so a greeting fired on mount is
 *     silently dropped and looks like a broken feature. It is armed on mount
 *     and fires on the first real interaction — a click, a key, a tap. For a
 *     buyer about to type a need, that is the same moment either way.
 *  2. **Once per screen per session.** Remembered in `sessionStorage`, so
 *     navigating back to the catalogue four times greets you once. This is
 *     also the quota guard: the greeting is charged per character, and a
 *     re-greeting on every mount would be the single most wasteful thing in
 *     the product.
 *  3. **Never over the top of something else.** If the agent is already
 *     speaking a result, the greeting is dropped entirely rather than queued.
 *     A greeting that arrives late is worse than one that never came.
 */
export function useGreeting(
  speaker: ReturnType<typeof useSpeaker>,
  line: string,
  opts: { stage: string; lang?: string; enabled?: boolean } = { stage: "" },
) {
  const { stage, lang = "en", enabled = true } = opts;
  // A ref, not state: this host re-renders on every keystroke, and a greeting
  // must not restart mid-sentence.
  const fired = useRef(false);

  useEffect(() => {
    if (!enabled || !line?.trim() || !stage) return;
    // `speaker.available` is deliberately not checked. It may be false only
    // because an earlier call in this page's life got a 503, and the greeting
    // is usually the first thing to try — gating on it means a page that
    // loaded before the key was configured never greets, even once the key is
    // there. A failed attempt is silent anyway.
    if (fired.current) return;

    // Versioned: a browser that was greeted under the previous scheme still
    // holds that flag for the life of its session, and would stay silent
    // through the fix. Bumping the prefix retires those.
    const key = `vaanijya.greeted2.${stage}`;
    try {
      if (window.sessionStorage.getItem(key) === "1") return;
    } catch {
      /* storage blocked: greet, and accept it may repeat on next navigation */
    }
    if (!voiceWanted()) return;

    let cancelled = false;

    /** Mark this screen greeted, so a return visit this session is silent. */
    function remember() {
      try {
        window.sessionStorage.setItem(key, "1");
      } catch {
        /* nothing to do */
      }
    }

    async function say(): Promise<boolean> {
      if (cancelled || fired.current) return true;
      if (!voiceWanted()) return true; // silenced in the meantime
      fired.current = true;
      const played = await speaker.speak(line, lang);
      if (played) {
        remember();
        return true;
      }
      // Blocked. Release the latch so the fallback attempt can run.
      fired.current = false;
      return false;
    }

    // Attempt it straight away. On a page the visitor has already interacted
    // with — a second visit, a client-side navigation, a tab they came back
    // to — this plays immediately and nothing else is needed.
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "touchstart"];
    const onInteract = () => {
      void say().then((done) => {
        if (done) detach();
      });
    };
    function detach() {
      for (const e of events) window.removeEventListener(e, onInteract);
    }

    void say().then((played) => {
      if (cancelled || played) return;
      // The browser refused, which it does until the page has been touched.
      // Arm the same line on the first interaction instead. This is a browser
      // policy, not something a setting can turn off.
      for (const e of events) window.addEventListener(e, onInteract, { passive: true });
    });

    return () => {
      cancelled = true;
      detach();
    };
    // `speaker` identity changes every render, so it is deliberately not a
    // dependency; re-arming on the same line would be pointless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line, stage, lang, enabled]);
}

/**
 * Whether this answer should be spoken without being asked.
 *
 * The first answer a buyer ever gets in a session is spoken aloud, even if
 * they typed rather than talked. A 🔊 button next to a reply is not a
 * discoverable feature — nobody presses an unfamiliar icon to find out what it
 * does — so the voice introduces itself once, by doing the thing.
 *
 * After that it is the toggle's decision. Speaking every reply uninvited is
 * the behaviour people turn off and never turn back on, and an agent that
 * talks over someone reading is worse than one that stayed quiet.
 *
 * Returns true at most once per browser session per surface, and never when
 * the agent has been silenced in the shell.
 */
export function shouldSpeakAnswer(surface: string, autoSpeak: boolean): boolean {
  if (!voiceWanted()) return false;
  if (autoSpeak) return true;

  const key = `vaanijya.spoke1.${surface}`;
  try {
    if (window.sessionStorage.getItem(key) === "1") return false;
    window.sessionStorage.setItem(key, "1");
  } catch {
    // Storage blocked. Speak this one rather than going silent: a repeat is a
    // smaller failure than a feature nobody discovers.
    return true;
  }
  return true;
}

/** Record a voice note in the browser and hand back the audio blob. */
export function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const chunks = useRef<Blob[]>([]);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);

  async function start() {
    setError("");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = s;
      chunks.current = [];
      const mr = new MediaRecorder(s);
      mr.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
      mr.start();
      recorder.current = mr;
      setRecording(true);
    } catch {
      setError("We could not reach your microphone. Check the browser permission, or type instead.");
    }
  }

  function stop(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const mr = recorder.current;
      if (!mr) return resolve(null);
      mr.onstop = () => {
        stream.current?.getTracks().forEach((t) => t.stop());
        setRecording(false);
        resolve(chunks.current.length ? new Blob(chunks.current, { type: "audio/webm" }) : null);
      };
      mr.stop();
    });
  }

  useEffect(() => () => stream.current?.getTracks().forEach((t) => t.stop()), []);

  return { recording, error, start, stop };
}

/**
 * A recording as base64, which is how every voice endpoint here takes it.
 *
 * Shared rather than duplicated per form: the "data:audio/webm;base64,"
 * prefix the reader adds has to be stripped, and a second copy of that detail
 * is a second place for it to be got wrong.
 */
export function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = String(r.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(new Error("Could not read that recording."));
    r.readAsDataURL(blob);
  });
}

/**
 * A free-text field the buyer can type or speak into.
 *
 * Used where the value is prose and there is nothing to parse — a delivery
 * instruction being the case this was built for. Dictation fills the box and
 * stops; the buyer reads it and presses the button, because a misheard
 * instruction reaches a courier and nothing downstream can catch it.
 *
 * The typed path is never disabled while recording is unavailable: a denied
 * microphone permission must not cost someone the feature.
 */
export function VoiceNote({
  value,
  onChange,
  label,
  placeholder,
  hint,
  maxLength = 400,
  rows = 3,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  placeholder?: string;
  hint?: string;
  maxLength?: number;
  rows?: number;
}) {
  const { recording, error, start, stop } = useRecorder();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function dictate() {
    if (recording) {
      const blob = await stop();
      if (!blob) return;
      setBusy(true);
      setErr("");
      try {
        const audio = await toBase64(blob);
        const r = await api<{ text: string; truncated: boolean }>("/api/speech/note", {
          json: { audio, filename: "note.webm" },
        });
        // Appended rather than replacing, so a second remark adds to the first
        // instead of silently destroying what the buyer already said.
        const next = value.trim() ? `${value.trim()} ${r.text}` : r.text;
        onChange(next.slice(0, maxLength));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "That recording could not be read.");
      }
      setBusy(false);
    } else {
      setErr("");
      await start();
    }
  }

  const left = maxLength - value.length;

  return (
    <div style={{ display: "grid", gap: ".35rem" }}>
      <div style={{ display: "flex", gap: ".5rem", alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: ".8rem", fontWeight: 600 }}>{label}</span>
        <button
          type="button"
          className={`btn btn-ghost btn-sm${recording ? " pulse-rec" : ""}`}
          onClick={() => void dictate()}
          disabled={busy}
          style={{ marginLeft: "auto" }}
          aria-label={recording ? "Stop recording and transcribe" : "Dictate instead of typing"}
        >
          {busy ? <Spinner label="Reading" /> : recording ? "■ Stop and use it" : "🎤 Say it"}
        </button>
      </div>

      <textarea
        className="field"
        rows={rows}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ resize: "vertical", lineHeight: 1.55 }}
      />

      <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", alignItems: "baseline" }}>
        {hint && (
          <span style={{ fontSize: ".74rem", color: "var(--ink-faint)", lineHeight: 1.5 }}>
            {hint}
          </span>
        )}
        {left <= 80 && (
          <span
            className="mono"
            style={{ fontSize: ".72rem", color: left <= 0 ? "var(--brick)" : "var(--ink-faint)", marginLeft: "auto" }}
          >
            {left} left
          </span>
        )}
      </div>

      {recording && (
        <span style={{ fontSize: ".76rem", color: "var(--brick)" }}>
          Listening — say it, then press stop.
        </span>
      )}
      {(err || error) && <Banner tone="brick">{err || error}</Banner>}
    </div>
  );
}

export async function api<T>(
  url: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const opts: RequestInit = { ...init };
  if (init?.json !== undefined) {
    opts.method = init.method ?? "POST";
    opts.headers = { "content-type": "application/json", ...(init.headers ?? {}) };
    opts.body = JSON.stringify(init.json);
  }
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  return body as T;
}
