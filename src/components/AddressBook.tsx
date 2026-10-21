"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, Banner, Chip, SpeakButton, Spinner, useRecorder, useSpeaker } from "@/components/ui";

/**
 * Where the parcel goes, said out loud or typed.
 *
 * The form exists because the schema always did and nothing could write to it:
 * a buyer kept whatever address registration captured, for ever, while the
 * pincode on it silently decided every delivery date and risk score they were
 * shown.
 *
 * The dictation is the point, though. An Indian address is five fields and a
 * phone number, which is the longest form in the product and the one most
 * likely to be filled in on a phone, one-handed, by someone who would rather
 * say it. So the whole thing can be spoken in one go — "flat 402 Sai
 * Residency, near Axis Bank, Bangalore 560041" — and the fields fill in.
 *
 * Two rules it keeps:
 *
 *  1. **Nothing is saved from speech alone.** The parse is shown, read back,
 *     and the buyer presses save. A misheard pincode cannot be caught by
 *     anything downstream — the forecast will be confidently wrong about a
 *     parcel going to the wrong city — so the confirmation is the feature.
 *  2. **Advice is not validation.** A missing landmark or phone costs a risk
 *     score, not the order. They are surfaced here because this is the last
 *     moment they are free to fix, and refused never.
 */

export type Address = {
  index: number;
  label: string;
  line: string;
  landmark: string;
  city: string;
  state: string;
  pincode: string;
  pinTier: number;
  phone: string;
  isDefault: boolean;
  oneLine: string;
  advice: Advice[];
};

type Advice = { field: string; severity: "blocking" | "worth_fixing"; message: string };

type Draft = {
  label: string;
  line: string;
  landmark: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
};

const EMPTY: Draft = {
  label: "Home", line: "", landmark: "", city: "", state: "", pincode: "", phone: "",
};

const TIER_WORDS: Record<number, string> = {
  1: "metro — fastest delivery",
  2: "large city",
  3: "smaller city or town — allow longer",
  4: "remote — allow longest",
};

export default function AddressBook({
  /** Called with the chosen index whenever the selection changes. */
  onPick,
  /** The index currently chosen by the parent, if it is tracking one. */
  picked,
  /** Compact mode for the checkout panel: no delete, no edit, just pick or add. */
  compact = false,
}: {
  onPick?: (index: number) => void;
  picked?: number;
  compact?: boolean;
}) {
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [fieldAdvice, setFieldAdvice] = useState<Advice[]>([]);

  const [heard, setHeard] = useState("");
  const [parsing, setParsing] = useState(false);
  const { recording, error: micError, start, stop } = useRecorder();
  const speaker = useSpeaker();
  const [spoken, setSpoken] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api<{ addresses: Address[] }>("/api/addresses");
      setAddresses(r.addresses ?? []);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load your addresses.");
    }
    setLoading(false);
  }, []);

  useEffect(() => void load(), [load]);

  /** An address with nowhere to deliver is the one state that blocks ordering. */
  const none = !loading && addresses.length === 0;
  useEffect(() => {
    if (none) setOpen(true);
  }, [none]);

  function beginAdd() {
    setEditing(null);
    setDraft(EMPTY);
    setHeard("");
    setSpoken("");
    setFieldAdvice([]);
    setOpen(true);
  }

  function beginEdit(a: Address) {
    setEditing(a.index);
    setDraft({
      label: a.label, line: a.line, landmark: a.landmark, city: a.city,
      state: a.state, pincode: a.pincode, phone: a.phone,
    });
    setHeard("");
    setSpoken("");
    setFieldAdvice([]);
    setOpen(true);
  }

  /**
   * Dictate the whole address at once.
   *
   * Sends the recording to be transcribed and parsed server-side, then fills
   * the form and speaks back what it understood. It never saves: the buyer
   * reads the filled form and presses save, which is the confirmation step.
   */
  async function dictate() {
    if (recording) {
      const blob = await stop();
      if (!blob) return;
      setParsing(true);
      try {
        const base64 = await toBase64(blob);
        const r = await api<{
          heard: string;
          address: Draft & { missing: string[]; source: string };
          advice: Advice[];
          spoken: string;
        }>("/api/addresses/dictate", { json: { audio: base64, filename: "address.webm" } });

        setHeard(r.heard);
        setDraft({
          label: r.address.label || "Home",
          line: r.address.line,
          landmark: r.address.landmark,
          city: r.address.city,
          state: r.address.state,
          pincode: r.address.pincode,
          phone: r.address.phone,
        });
        setFieldAdvice(r.advice ?? []);
        setSpoken(r.spoken);
        // Spoken straight away: someone who dictated an address is not
        // watching the form, and a silent fill looks like nothing happened.
        void speaker.speak(r.spoken);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "That recording could not be read.");
      }
      setParsing(false);
    } else {
      setErr("");
      await start();
    }
  }

  /** The same parse, from typed text, for anyone who would rather paste it. */
  async function parseTyped(text: string) {
    if (!text.trim()) return;
    setParsing(true);
    try {
      const r = await api<{
        address: Draft & { missing: string[] };
        advice: Advice[];
        spoken: string;
      }>("/api/addresses/dictate", { json: { sentence: text } });
      setDraft({
        label: r.address.label || "Home",
        line: r.address.line,
        landmark: r.address.landmark,
        city: r.address.city,
        state: r.address.state,
        pincode: r.address.pincode,
        phone: r.address.phone,
      });
      setFieldAdvice(r.advice ?? []);
      setSpoken(r.spoken);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That could not be read as an address.");
    }
    setParsing(false);
  }

  async function save() {
    setSaving(true);
    setErr("");
    try {
      if (editing === null) {
        await api("/api/addresses", { json: draft });
        setNote("Address saved.");
      } else {
        await api("/api/addresses", { method: "PUT", json: { ...draft, index: editing } });
        setNote("Address updated.");
      }
      setOpen(false);
      setHeard("");
      setSpoken("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That address could not be saved.");
    }
    setSaving(false);
  }

  async function makeDefault(index: number) {
    try {
      await api("/api/addresses", { method: "PATCH", json: { index } });
      await load();
      onPick?.(0);
      setNote("Default address changed.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not change the default.");
    }
  }

  async function remove(index: number) {
    try {
      await api("/api/addresses", { method: "DELETE", json: { index } });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove that address.");
    }
  }

  if (loading) return <Spinner label="Loading your addresses" />;

  const chosen = picked ?? 0;

  return (
    <div>
      {err && <Banner tone="brick">{err}</Banner>}
      {note && !err && <Banner tone="moss">{note}</Banner>}
      {micError && <Banner tone="gold">{micError}</Banner>}

      {none && !open && (
        <Banner tone="gold">
          You have no delivery address yet. Add one before ordering.
        </Banner>
      )}

      {/* ── The list ──────────────────────────────────────────────────── */}
      {addresses.length > 0 && (
        <div style={{ display: "grid", gap: ".6rem", marginBottom: open ? "1rem" : ".8rem" }}>
          {addresses.map((a) => {
            const isChosen = a.index === chosen;
            const worth = a.advice.filter((x) => x.severity === "worth_fixing");
            return (
              <div
                key={a.index}
                className="card"
                style={{
                  padding: ".85rem 1rem",
                  borderLeft: `3px solid ${isChosen ? "var(--moss)" : "var(--rule)"}`,
                  cursor: onPick ? "pointer" : "default",
                }}
                onClick={() => onPick?.(a.index)}
              >
                <div style={{ display: "flex", gap: ".6rem", alignItems: "baseline", flexWrap: "wrap" }}>
                  {onPick && (
                    <input
                      type="radio"
                      checked={isChosen}
                      onChange={() => onPick(a.index)}
                      aria-label={`Deliver to ${a.label}`}
                    />
                  )}
                  <strong style={{ fontSize: ".92rem" }}>{a.label}</strong>
                  {a.isDefault && <Chip tone="indigo">default</Chip>}
                  <Chip tone="neutral">tier {a.pinTier}</Chip>
                  <span style={{ fontSize: ".75rem", color: "var(--ink-faint)" }}>
                    {TIER_WORDS[a.pinTier] ?? ""}
                  </span>
                </div>

                <div style={{ fontSize: ".86rem", color: "var(--ink-soft)", marginTop: ".3rem" }}>
                  {a.oneLine}
                </div>
                {a.phone && (
                  <div style={{ fontSize: ".78rem", color: "var(--ink-faint)", marginTop: ".15rem" }}>
                    {a.phone}
                  </div>
                )}

                {/* What the risk engine will charge for, while it is still free
                    to fix. Never a reason the address was refused. */}
                {worth.length > 0 && (
                  <div style={{ fontSize: ".76rem", color: "var(--haldi-deep)", marginTop: ".4rem" }}>
                    {worth.map((w) => w.message).join(" ")}
                  </div>
                )}

                {!compact && (
                  <div style={{ display: "flex", gap: ".4rem", marginTop: ".55rem", flexWrap: "wrap" }}>
                    <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); beginEdit(a); }}>
                      Edit
                    </button>
                    {!a.isDefault && (
                      <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); void makeDefault(a.index); }}>
                        Make default
                      </button>
                    )}
                    {addresses.length > 1 && (
                      <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); void remove(a.index); }}>
                        Remove
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!open && (
        <button className="btn btn-ghost btn-sm" onClick={beginAdd}>
          + Add an address
        </button>
      )}

      {/* ── Add or edit, by voice or by hand ──────────────────────────── */}
      {open && (
        <div className="card" style={{ padding: "1rem", display: "grid", gap: ".7rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: ".6rem" }}>
            <strong style={{ fontSize: ".95rem" }}>
              {editing === null ? "New address" : "Edit address"}
            </strong>
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>

          {/* The hands-free path, first because it is the fast one. */}
          <div style={{ display: "flex", gap: ".5rem", alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className={recording ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}
              onClick={() => void dictate()}
              disabled={parsing}
            >
              <span aria-hidden>{recording ? "◼" : "🎙"}</span>
              {recording ? "Stop and read it" : "Say the whole address"}
            </button>
            {parsing && <Spinner label="Reading it" />}
            {spoken && <SpeakButton text={spoken} speaker={speaker} label="Replay" />}
          </div>

          <p style={{ fontSize: ".78rem", color: "var(--ink-faint)", margin: 0 }}>
            Say it however you like — &ldquo;flat 402 Sai Residency, near Axis Bank, Bangalore 560041&rdquo;.
            Nothing is saved until you press save.
          </p>

          {heard && (
            <div style={{ fontSize: ".8rem", color: "var(--ink-soft)", fontStyle: "italic" }}>
              Heard: &ldquo;{heard}&rdquo;
            </div>
          )}

          <LabelledField label="Street address" hint="Flat or house number, building, street, area">
            <textarea
              className="field"
              rows={2}
              value={draft.line}
              onChange={(e) => setDraft({ ...draft, line: e.target.value })}
              onBlur={(e) => {
                // Pasting a whole address into the first box is what people
                // actually do, so it is parsed rather than stored as one line.
                if (!draft.pincode && /\d{6}/.test(e.target.value)) void parseTyped(e.target.value);
              }}
              placeholder="Flat 402, Sai Residency, 12th Cross"
            />
          </LabelledField>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: ".7rem" }}>
            <LabelledField label="Pincode" hint="Six digits; fills the city">
              <input
                className="field"
                value={draft.pincode}
                inputMode="numeric"
                maxLength={6}
                onChange={(e) => {
                  const pin = e.target.value.replace(/\D/g, "").slice(0, 6);
                  setDraft({ ...draft, pincode: pin });
                  if (pin.length === 6) void parseTyped(`${draft.line} ${pin}`);
                }}
                placeholder="560041"
              />
            </LabelledField>
            <LabelledField label="Landmark" hint="Cuts the chance of a failed delivery">
              <input
                className="field"
                value={draft.landmark}
                onChange={(e) => setDraft({ ...draft, landmark: e.target.value })}
                placeholder="Axis Bank"
              />
            </LabelledField>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: ".7rem" }}>
            <LabelledField label="City">
              <input
                className="field"
                value={draft.city}
                onChange={(e) => setDraft({ ...draft, city: e.target.value })}
              />
            </LabelledField>
            <LabelledField label="State">
              <input
                className="field"
                value={draft.state}
                onChange={(e) => setDraft({ ...draft, state: e.target.value })}
              />
            </LabelledField>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: ".7rem" }}>
            <LabelledField label="Mobile" hint="So the courier can call first">
              <input
                className="field"
                value={draft.phone}
                inputMode="numeric"
                maxLength={10}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
                placeholder="9876543210"
              />
            </LabelledField>
            <LabelledField label="Label">
              <select
                className="field"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              >
                <option>Home</option>
                <option>Work</option>
                <option>Other</option>
              </select>
            </LabelledField>
          </div>

          {fieldAdvice.length > 0 && (
            <div style={{ fontSize: ".78rem", display: "grid", gap: ".2rem" }}>
              {fieldAdvice.map((a, i) => (
                <div
                  key={i}
                  style={{
                    color: a.severity === "blocking" ? "var(--brick)" : "var(--haldi-deep)",
                  }}
                >
                  {a.message}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: ".5rem" }}>
            <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving" : editing === null ? "Save address" : "Save changes"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function LabelledField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: ".2rem" }}>
      <span style={{ fontSize: ".78rem", fontWeight: 600 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: ".72rem", color: "var(--ink-faint)" }}>{hint}</span>}
    </label>
  );
}

/** A recording as base64, which is how the dictate endpoint takes it. */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = String(r.result ?? "");
      // Strip the "data:audio/webm;base64," prefix the reader adds.
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(new Error("Could not read that recording."));
    r.readAsDataURL(blob);
  });
}
