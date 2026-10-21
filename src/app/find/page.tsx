"use client";

/**
 * Find by constraint — the page where the buyer stops scrolling.
 *
 * The screen is arranged around one claim: *you stated five things, and here
 * is the proof about each one.* So the order is deliberate —
 *
 *   1. the sentence you typed,
 *   2. the constraints that were read out of it, editable, because a
 *      misreading must be correctable in one click rather than silently
 *      shaping the answer,
 *   3. what satisfies all of them, with each constraint ticked against the
 *      product's actual value,
 *   4. **why everything else was rejected** — which is the part no platform
 *      shows, and the reason this page is worth having.
 *
 * Nothing on this page computes anything. Every number, date, verdict and
 * rejection sentence arrives from `/api/finder`, which gets them from pure
 * functions. A UI that recomputed a total would be a second source of truth.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Shell from "@/components/Shell";
import {
  api, Banner, Chip, Disclosure, Empty, INR, shouldSpeakAnswer, SpeakButton,
  Spinner, Toast, useRecorder, useSpeaker,
} from "@/components/ui";
import DestinationBlock from "@/components/DestinationBlock";

/* ─────────────────────────── Wire types ─────────────────────────── */

type Constraint =
  | { kind: "category"; value: string }
  | { kind: "max_price"; value: number }
  | { kind: "min_price"; value: number }
  | { kind: "brand"; value: string }
  | { kind: "min_rating"; value: number }
  | { kind: "in_stock"; value: true }
  | { kind: "attribute"; key: string; value: string | number | boolean }
  | { kind: "arrive_by"; value: string }
  | { kind: "payment_mode"; value: "COD" | "PREPAID" }
  | { kind: "max_true_cost"; value: number }
  | { kind: "max_seller_defect_rate"; value: number };

type CostLine = { label: string; amountInr: number; detail: string; probabilistic?: boolean };

type Candidate = {
  sku: string; title: string; brand: string; category: string; subcategory?: string;
  priceInr: number; mrpInr?: number; ratingAvg: number; ratingCount?: number;
  stock: number; codEligible: boolean; imageEmoji?: string; accentHex?: string;
  attributes: Record<string, unknown>;
  seller: { sellerId: string; name: string; city?: string; ratingAvg?: number; defectRatePct: number; fulfilmentSlaDays: number };
};

type Forecast = {
  likelyAt: string; confidentAt: string; confidencePct: number;
  slackDays: number; reasons: string[];
  deadline: null | { at: string; likelyMeets: boolean; confidentMeets: boolean; verdict: "SAFE" | "TIGHT" | "WILL_MISS"; sentence: string };
};

type SolvedOffer = {
  candidate: Candidate;
  satisfied: { constraint: string; kind: string; evidence: string }[];
  cost: {
    stickerInr: number; payableNowInr: number; expectedTotalInr: number;
    returnRiskInr: number; lines: CostLine[]; summary: string;
  };
  forecast: Forecast;
  rank: number;
  rankReason: string;
};

type RejectedOffer = {
  candidate: Candidate;
  failed: { constraint: string; kind: string; actual: string }[];
  primary: { constraint: string; kind: string; actual: string };
};

type AcceptResponse = {
  added: {
    sku: string; title: string; seller: string; qty: number;
    stickerInr: number; rationale: string;
  };
  checkout: {
    expectedTotalInr: number;
    payableNowInr: number;
    costLines: CostLine[];
    costSummary: string;
    forecast: Forecast;
    satisfied: { constraint: string; kind: string; evidence: string }[];
    paymentMode: "COD" | "PREPAID";
    address: { line: string; city: string; pincode: string; pinTier: number } | null;
    alternatives: {
      sku: string; title: string; seller: string;
      expectedTotalInr: number; confidentAt: string; rankReason: string;
    }[];
  };
  cart: { count: number; totalInr: number };
  awaitingApproval: boolean;
  nextStep: string;
  spoken: string;
};

type FinderResponse = {
  source: "model" | "rules" | "buyer";
  query: string;
  constraints: { kind: string; text: string }[];
  considered: number;
  satisfied: SolvedOffer[];
  rejected: RejectedOffer[];
  rejectionSummary: { kind: string; constraint: string; count: number }[];
  relaxation: null | { kind: string; constraint: string; wouldAdmit: number; sentence: string };
  scope: { products: number; offers: number; sellers: number };
  buyer: { pinTier: number; priorRto: number; paymentMode: "COD" | "PREPAID"; city: string };
  headline: string;
  needUnmatched?: boolean;
  hiddenByCategory?: number;
  /** One or two sentences written for a voice, not the screen. */
  spoken: string;
  asOf: string;
};

/* ─────────────────────────── Examples ─────────────────────────── */

/**
 * Worked examples, chosen so each demonstrates a different capability rather
 * than the same one three times: an attribute rejection, a deadline that is
 * met only on the optimistic date, and a seller-quality constraint.
 */
const EXAMPLES = [
  {
    label: "The cooker",
    sentence:
      "A pressure cooker for my induction hob, 5 litres at most, under ₹2000, must be in stock, and I need it before the 28th",
    shows: "rejects on a spec and a date",
  },
  {
    label: "Earbuds, in a hurry",
    sentence: "Noise cancelling earbuds under ₹2700 from a reliable seller, delivered within 5 days",
    shows: "seller defect rate as a constraint",
  },
  {
    label: "Shoes, cash on delivery",
    sentence: "Running shoes size 9 under ₹2000, 4 star and above, cash on delivery",
    shows: "size inside a stated range",
  },
];

const DAY = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export default function FindPage() {
  const router = useRouter();
  const [user, setUser] = useState<{ name: string; role: string } | null>(null);
  const [sentence, setSentence] = useState("");
  const [result, setResult] = useState<FinderResponse | null>(null);
  const [constraints, setConstraints] = useState<Constraint[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ m: string; t: "ok" | "err" } | null>(null);
  const [showRejected, setShowRejected] = useState(true);
  const [cartCount, setCartCount] = useState(0);
  const [accepted, setAccepted] = useState<AcceptResponse | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [spokenAs, setSpokenAs] = useState("");
  /** ISO code for the reply voice — whatever the buyer last spoke. */
  const [spokenLang, setSpokenLang] = useState("en");
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const { recording, error: micError, start, stop } = useRecorder();
  const speaker = useSpeaker();
  /**
   * Speak replies without being asked.
   *
   * Off by default and never auto-played on the first load: browsers block it
   * and it startles people. It turns itself on when the buyer uses the mic —
   * someone who spoke their need almost certainly wants the answer spoken
   * back, and that is a better signal than a setting nobody finds.
   */
  const [autoSpeak, setAutoSpeak] = useState(false);
  /**
   * Which address the order goes to.
   *
   * Zero is the buyer's default, which is what `placeOrder` assumed before
   * this existed. It is state rather than a constant because changing it
   * changes the delivery forecast, and the buyer has to be able to see that
   * before they approve anything.
   */
  const [addressIndex, setAddressIndex] = useState(0);
  /**
   * What the courier should know, for this delivery only.
   *
   * Held here rather than in the panel so that discarding the order clears it
   * too: an instruction left over from an abandoned checkout would silently
   * attach itself to the next one.
   */
  const [instructions, setInstructions] = useState("");

  /* The arrival greeting lives in the shell, so every page gets exactly one. */

  useEffect(() => {
    api<{ user: { name: string; role: string } | null }>("/api/auth/me")
      .then((r) => (r.user ? setUser(r.user) : router.push("/signin")))
      .catch(() => router.push("/signin"));
    api<{ count: number }>("/api/cart")
      .then((r) => setCartCount(r.count ?? 0))
      .catch(() => undefined);
  }, [router]);

  /**
   * Run the solve.
   *
   * Two modes: a sentence (which is read into constraints first) or an
   * explicit constraint list (which is not re-interpreted, because it came
   * from the buyer correcting a chip).
   */
  const solve = useCallback(
    async (body: { sentence?: string; constraints?: Constraint[]; query?: string }) => {
      setLoading(true);
      try {
        const r = await api<FinderResponse>("/api/finder", { json: body });
        setResult(r);
        // A new solve invalidates the previous acceptance: the cart line stays
        // (the buyer can still see and remove it) but the checkout summary on
        // screen must not outlive the result it was computed from.
        setAccepted(null);
        // Mirror the enforced constraints into local state, so editing a chip
        // starts from what was actually applied rather than what was typed.
        setConstraints(toConstraints(r));
        setShowRejected(true);
        requestAnimationFrame(() =>
          resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
        );
        // Spoken unprompted the first time this session: a results page is
        // dense, and hearing "4 options, the best is 1517 rupees all in"
        // beats finding the 🔊 button. See `shouldSpeakAnswer`.
        if (r.spoken && shouldSpeakAnswer("find", autoSpeak)) {
          void speaker.speak(r.spoken, spokenLang);
          setAutoSpeak(true);
        }
      } catch (e) {
        setToast({ m: e instanceof Error ? e.message : "That search failed.", t: "err" });
      }
      setLoading(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [autoSpeak, spokenLang],
  );

  /** Drop one constraint and re-solve. The whole point of showing them. */
  const dropConstraint = useCallback(
    (index: number) => {
      const next = constraints.filter((_, i) => i !== index);
      setConstraints(next);
      if (next.length === 0) {
        setResult(null);
        return;
      }
      solve({ constraints: next, query: result?.query });
    },
    [constraints, result?.query, solve],
  );

  /**
   * Speak the need instead of typing it.
   *
   * This matters more here than anywhere else in the product. The buyers who
   * most need to describe a need rather than guess a product name are the ones
   * least comfortable typing it in English — and a need is a whole sentence,
   * which is exactly what nobody wants to type on a phone. Whisper detects the
   * language itself, so no picker is needed.
   *
   * The transcript is shown before it is acted on, so a mis-hearing is visible
   * rather than silently shaping the search.
   */
  async function toggleMic() {
    if (!recording) {
      await start();
      return;
    }
    const blob = await stop();
    if (!blob) return;

    setTranscribing(true);
    try {
      const fd = new FormData();
      fd.append("audio", blob, "need.webm");
      const r = await api<{ text: string; scriptLanguage: string }>("/api/agent/voice", {
        method: "POST",
        body: fd,
      });
      setTranscribing(false);
      if (!r.text?.trim()) {
        setToast({ m: "I could not hear anything in that. Try again.", t: "err" });
        return;
      }
      setSentence(r.text);
      setSpokenAs(r.scriptLanguage || "");
      if (r.scriptLanguage) setSpokenLang(r.scriptLanguage);
      // They spoke to us, so speak back — this is the enabling signal.
      setAutoSpeak(true);
      await solve({ sentence: r.text });
    } catch (e) {
      setTranscribing(false);
      setToast({ m: e instanceof Error ? e.message : "Transcription failed.", t: "err" });
    }
  }

  /**
   * Accept an offer: the agent puts it in the cart and asks.
   *
   * With no sku, the server takes its own top-ranked offer — the "just handle
   * it" path. Either way the server re-solves rather than trusting what this
   * page last displayed, so the thing added is the thing that wins right now.
   */
  const accept = useCallback(
    async (sku?: string, sellerId?: string) => {
      setAccepting(true);
      try {
        const r = await api<AcceptResponse>("/api/finder/accept", {
          json: {
            sentence: sentence.trim() || undefined,
            constraints: constraints.length ? constraints : undefined,
            query: result?.query,
            sku,
            sellerId,
            paymentMode: result?.buyer.paymentMode,
          },
        });
        setAccepted(r);
        setCartCount(r.cart.count);
        // Spoken whether or not auto-speak is on: "it is in your cart and
        // nothing has been ordered" is the message a buyer most needs to not
        // miss, and it is the stage where a misunderstanding costs money.
        if (r.spoken) void speaker.speak(r.spoken, spokenLang);
        requestAnimationFrame(() =>
          document.getElementById("confirm")?.scrollIntoView({ behavior: "smooth", block: "center" }),
        );
      } catch (e) {
        setToast({ m: e instanceof Error ? e.message : "Could not add that.", t: "err" });
      }
      setAccepting(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sentence, constraints, result?.query, result?.buyer.paymentMode, spokenLang],
  );

  /**
   * The one thing the agent is not allowed to do.
   *
   * `place_order` sits in BUYER_CONFIRM_REQUIRED and the tool registry refuses
   * it from any agent turn, so this handler exists because a human pressed a
   * button — which is the whole point of the gate.
   */
  async function placeOrder() {
    if (!accepted) return;
    setPlacing(true);
    try {
      const r = await api<{ orderNo: string; amountInr: number; risk: { band: string } }>(
        "/api/orders",
        // The address is named explicitly. It used to be omitted, which meant
        // the order went to `addresses[0]` whatever the buyer had selected.
        {
          json: {
            paymentMode: accepted.checkout.paymentMode,
            addressIndex,
            deliveryInstructions: instructions.trim() || undefined,
          },
        },
      );
      setAccepted(null);
      setCartCount(0);
      setInstructions("");
      setToast({
        m: `${r.orderNo} placed for ${INR(r.amountInr)}. Delivery risk: ${r.risk.band.toLowerCase()}.`,
        t: "ok",
      });
    } catch (e) {
      setToast({ m: e instanceof Error ? e.message : "The order could not be placed.", t: "err" });
    }
    setPlacing(false);
  }

  async function addToCart(sku: string, rationale: string) {
    try {
      await api("/api/cart", { json: { action: "add", sku, qty: 1 } });
      const c = await api<{ count: number }>("/api/cart");
      setCartCount(c.count ?? 0);
      setToast({ m: `Added. ${rationale}`, t: "ok" });
    } catch (e) {
      setToast({ m: e instanceof Error ? e.message : "Could not add that.", t: "err" });
    }
  }

  if (!user) {
    return (
      <main style={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}>
        <Spinner label="Loading" />
      </main>
    );
  }

  return (
    <Shell user={user} cartCount={cartCount}>
      <main className="page">
        <h1 style={{ marginBottom: ".5rem" }}>State what you need</h1>
        <p style={{ color: "var(--ink-soft)", maxWidth: "58ch", lineHeight: 1.6, marginBottom: "1.2rem" }}>
          Describe it in your own words. You get what fits, and why the rest did not.
        </p>

        {/* ── The sentence ──────────────────────────────────────────── */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (sentence.trim()) solve({ sentence: sentence.trim() });
          }}
          className="card"
          style={{ padding: "1.1rem", marginBottom: "1rem" }}
        >
          <label
            htmlFor="need"
            style={{ display: "block", fontSize: ".82rem", fontWeight: 600, marginBottom: ".4rem" }}
          >
            What has to be true?
          </label>
          <textarea
            id="need"
            className="field"
            rows={3}
            style={{ resize: "vertical", lineHeight: 1.6 }}
            placeholder="A pressure cooker for my induction hob, 5 litres at most, under ₹2000, in stock, needed before the 28th"
            value={sentence}
            onChange={(e) => setSentence(e.target.value)}
          />
          <div
            style={{
              display: "flex", gap: ".5rem", flexWrap: "wrap",
              alignItems: "center", marginTop: ".7rem",
            }}
          >
            <button className="btn btn-primary" disabled={loading || !sentence.trim()}>
              {loading ? "Solving" : "Find what satisfies this"}
            </button>

            {/* Speaking a need is easier than typing one, especially on a
                phone and especially not in English. */}
            <button
              type="button"
              className={recording ? "btn btn-reject" : "btn btn-ghost"}
              onClick={toggleMic}
              disabled={transcribing}
              aria-pressed={recording}
              aria-label={recording ? "Stop recording and search" : "Say what you need"}
            >
              <span className={recording ? "pulse-rec" : undefined} aria-hidden>
                {recording ? "■" : "🎙"}
              </span>
              {transcribing ? "Transcribing" : recording ? "Stop and search" : "Say it instead"}
            </button>

            <span style={{ fontSize: ".78rem", color: "var(--ink-faint)" }}>
              Any of 8 languages.
            </span>
          </div>

          {micError && (
            <div style={{ marginTop: ".6rem" }}>
              <Banner tone="brick">{micError}</Banner>
            </div>
          )}

          {speaker.error && speaker.available && (
            <p style={{ fontSize: ".78rem", color: "var(--brick)", margin: ".6rem 0 0" }}>
              {speaker.error}
            </p>
          )}

          {recording && (
            <p style={{ fontSize: ".8rem", color: "var(--brick)", margin: ".6rem 0 0" }}>
              Listening — say what you need, then press stop.
            </p>
          )}

          {spokenAs && !recording && (
            <p style={{ fontSize: ".78rem", color: "var(--ink-faint)", margin: ".6rem 0 0" }}>
              Heard in {spokenAs}. Edit it above if that is wrong.
            </p>
          )}

          <div style={{ marginTop: ".9rem", paddingTop: ".8rem", borderTop: "1px solid var(--rule)" }}>
            <div style={{ fontSize: ".76rem", color: "var(--ink-faint)", marginBottom: ".45rem" }}>
              Or try one of these:
            </div>
            <div style={{ display: "flex", gap: ".4rem", flexWrap: "wrap" }}>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setSentence(ex.sentence);
                    solve({ sentence: ex.sentence });
                  }}
                  title={`${ex.sentence} — ${ex.shows}`}
                >
                  {ex.label}
                </button>
              ))}
            </div>
          </div>
        </form>

        {loading && !result && (
          <div className="card" style={{ padding: "1.5rem", display: "grid", placeItems: "center" }}>
            <Spinner label="Checking every offer" />
          </div>
        )}

        <div ref={resultsRef}>
          {result && (
            <Results
              result={result}
              constraints={constraints}
              onDrop={dropConstraint}
              onAdd={addToCart}
              onAccept={accept}
              accepting={accepting}
              accepted={accepted}
              onPlaceOrder={placeOrder}
              addressIndex={addressIndex}
              onAddressChange={setAddressIndex}
              instructions={instructions}
              onInstructionsChange={setInstructions}
              placing={placing}
              onDiscard={() => setAccepted(null)}
              showRejected={showRejected}
              setShowRejected={setShowRejected}
              loading={loading}
              speaker={speaker}
              spokenLang={spokenLang}
              autoSpeak={autoSpeak}
              setAutoSpeak={setAutoSpeak}
            />
          )}
        </div>

        {toast && <Toast message={toast.m} tone={toast.t} onDone={() => setToast(null)} />}
      </main>
    </Shell>
  );
}

/* ──────────────────────────── Results ──────────────────────────── */

function Results({
  result, constraints, onDrop, onAdd, onAccept, accepting, accepted,
  onPlaceOrder, placing, onDiscard, showRejected, setShowRejected, loading,
  addressIndex, onAddressChange, instructions, onInstructionsChange,
  speaker, spokenLang, autoSpeak, setAutoSpeak,
}: {
  result: FinderResponse;
  constraints: Constraint[];
  onDrop: (i: number) => void;
  onAdd: (sku: string, rationale: string) => void;
  onAccept: (sku?: string, sellerId?: string) => void;
  accepting: boolean;
  accepted: AcceptResponse | null;
  onPlaceOrder: () => void;
  addressIndex: number;
  instructions: string;
  onInstructionsChange: (next: string) => void;
  onAddressChange: (i: number) => void;
  placing: boolean;
  onDiscard: () => void;
  showRejected: boolean;
  setShowRejected: (v: boolean) => void;
  loading: boolean;
  speaker: ReturnType<typeof useSpeaker>;
  spokenLang: string;
  autoSpeak: boolean;
  setAutoSpeak: (v: boolean) => void;
}) {
  const nothing = result.satisfied.length === 0;

  return (
    <div style={{ opacity: loading ? 0.55 : 1, transition: "opacity .15s ease" }}>
      {/* ── What was understood, and who understood it ──────────────── */}
      <div className="card" style={{ padding: "1.1rem", marginBottom: "1rem" }}>
        <div
          style={{
            display: "flex", justifyContent: "space-between",
            gap: ".75rem", flexWrap: "wrap", alignItems: "baseline", marginBottom: ".6rem",
          }}
        >
          <h3>Constraints being enforced</h3>
          <span style={{ fontSize: ".75rem", color: "var(--ink-faint)" }}>
            {result.source === "model"
              ? "read from your sentence by a language model"
              : result.source === "rules"
                ? "read by the deterministic parser — no model was available"
                : "edited by you"}
          </span>
        </div>

        {constraints.length === 0 ? (
          <Banner tone="gold">{result.headline}</Banner>
        ) : (
          <>
            <div style={{ display: "flex", gap: ".4rem", flexWrap: "wrap" }}>
              {result.constraints.map((c, i) => (
                <span
                  key={`${c.kind}-${i}`}
                  className="chip chip-indigo"
                  style={{ display: "inline-flex", alignItems: "center", gap: ".4rem" }}
                >
                  {c.text}
                  <button
                    onClick={() => onDrop(i)}
                    aria-label={`Remove the constraint: ${c.text}`}
                    title="Drop this constraint and solve again"
                    style={{
                      background: "none", border: "none", padding: 0, cursor: "pointer",
                      color: "inherit", fontSize: ".95rem", lineHeight: 1, opacity: 0.6,
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <p style={{ fontSize: ".78rem", color: "var(--ink-faint)", margin: ".55rem 0 0" }}>
              Tap × on any one to drop it.
            </p>
          </>
        )}
      </div>

      {constraints.length > 0 && (
        <>
          {/* ── The headline: the count and the rejection tally ───────── */}
          <div
            className="card"
            style={{
              padding: "1.1rem", marginBottom: "1rem",
              borderLeft: `3px solid ${nothing ? "var(--haldi-deep)" : "var(--moss)"}`,
            }}
          >
            <div
              style={{
                display: "flex", gap: ".75rem", alignItems: "flex-start",
                justifyContent: "space-between", flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: "1.02rem", fontWeight: 600, lineHeight: 1.5 }}>
                  {result.headline}
                </div>
                {/* A category the buyer never typed can hide the very thing
                    they searched for. Saying how many, with the way out. */}
                {result.source !== "buyer" && (result.hiddenByCategory ?? 0) > 0 && (
                  <div style={{ fontSize: ".8rem", color: "var(--haldi-deep)", marginTop: ".4rem", fontWeight: 400 }}>
                    {result.hiddenByCategory}{" "}
                    {result.hiddenByCategory === 1 ? "match was" : "matches were"} hidden by the
                    category above, which was read from your words rather than stated. Remove that
                    chip to see {result.hiddenByCategory === 1 ? "it" : "them"}.
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: ".4rem", alignItems: "center", flexShrink: 0 }}>
                <SpeakButton text={result.spoken} lang={spokenLang} speaker={speaker} />
                {speaker.available && (
                  <label
                    style={{
                      display: "inline-flex", alignItems: "center", gap: ".3rem",
                      fontSize: ".76rem", color: "var(--ink-faint)", cursor: "pointer",
                    }}
                    title="Read every result aloud as it arrives"
                  >
                    <input
                      type="checkbox"
                      checked={autoSpeak}
                      onChange={(e) => setAutoSpeak(e.target.checked)}
                    />
                    speak results
                  </label>
                )}
              </div>
            </div>
            {/* Kept because it changes how the buyer reads every date and
                price below; the offer/product/seller tally that used to sit
                here did not, and is on the rejection panel anyway. */}
            <div style={{ fontSize: ".78rem", color: "var(--ink-faint)", marginTop: ".4rem" }}>
              For {result.buyer.city || "your address"},{" "}
              {result.buyer.paymentMode === "COD" ? "cash on delivery" : "prepaid"}.
            </div>

            {result.relaxation && (
              <div style={{ marginTop: ".8rem" }}>
                <Banner tone="gold">{result.relaxation.sentence}</Banner>
              </div>
            )}
          </div>

          {/* ── Hand it to the agent ──────────────────────────────────── */}
          {result.satisfied.length > 0 && !accepted && (
            <div
              className="card"
              style={{
                padding: "1rem 1.1rem", marginBottom: "1rem",
                display: "flex", gap: ".9rem", flexWrap: "wrap",
                alignItems: "center", justifyContent: "space-between",
                background: "var(--neel-wash)", border: "1px solid var(--neel-soft)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: ".92rem" }}>
                  Let the agent handle it
                </div>
                <div style={{ fontSize: ".82rem", color: "var(--ink-soft)", marginTop: ".2rem" }}>
                  It adds the best match and stops for your approval.
                </div>
              </div>
              <button
                className="btn btn-accent"
                onClick={() => onAccept()}
                disabled={accepting}
                style={{ flexShrink: 0 }}
              >
                {accepting ? "Adding" : "Add the best match to my cart"}
              </button>
            </div>
          )}

          {accepted && (
            <ConfirmPanel
              accepted={accepted}
              onPlaceOrder={onPlaceOrder}
              placing={placing}
              onDiscard={onDiscard}
              onSwitch={onAccept}
              accepting={accepting}
              speaker={speaker}
              spokenLang={spokenLang}
              addressIndex={addressIndex}
              onAddressChange={onAddressChange}
              instructions={instructions}
              onInstructionsChange={onInstructionsChange}
            />
          )}

          {/* ── What satisfies everything ─────────────────────────────── */}
          {result.satisfied.length > 0 && (
            <div className="stagger" style={{ display: "grid", gap: "1rem", marginBottom: "1.4rem" }}>
              {result.satisfied.map((o) => (
                <OfferCard
                  key={`${o.candidate.sku}-${o.candidate.seller.sellerId}`}
                  offer={o}
                  onAdd={onAdd}
                  onAccept={onAccept}
                  accepting={accepting}
                />
              ))}
            </div>
          )}

          {/* ── Why everything else was rejected: the actual feature ──── */}
          {result.rejected.length > 0 && (
            <section className="card" style={{ padding: "1.1rem" }}>
              <div
                style={{
                  display: "flex", justifyContent: "space-between",
                  gap: ".75rem", flexWrap: "wrap", alignItems: "baseline",
                }}
              >
                <div>
                  <h3>
                    Why the other {result.rejected.length} {result.rejected.length === 1 ? "offer was" : "offers were"} rejected
                  </h3>

                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowRejected(!showRejected)}
                  aria-expanded={showRejected}
                >
                  {showRejected ? "Hide" : "Show all"}
                </button>
              </div>

              {/* The tally, which is what most buyers will read and stop at. */}
              <div style={{ display: "flex", gap: ".4rem", flexWrap: "wrap", margin: ".9rem 0" }}>
                {result.rejectionSummary.map((s) => (
                  <Chip key={`${s.kind}-${s.constraint}`} tone="neutral">
                    {s.count} failed {s.constraint}
                  </Chip>
                ))}
              </div>

              {showRejected && (
                <div className="enter">
                  {result.rejected.map((r) => (
                    <RejectedRow key={`${r.candidate.sku}-${r.candidate.seller.sellerId}`} rejected={r} />
                  ))}
                </div>
              )}
            </section>
          )}

          {nothing && result.rejected.length === 0 && (
            <Empty title="Nothing to check yet">
              The catalogue had no product close enough to what you described to be worth
              checking. Try naming the product differently.
            </Empty>
          )}

          <p style={{ fontSize: ".75rem", color: "var(--ink-faint)", marginTop: "1.2rem" }}>
            Demonstration data — every seller and price here is fictional.{" "}
            <Link href="/system" style={{ color: "var(--neel)" }}>
              How this works
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

/* ───────────────────────── The approval step ───────────────────────── */

/**
 * The agent has filled the cart. This is where it stops and asks.
 *
 * Everything needed to decide is on screen — the conditions it satisfied, the
 * cost taken apart, the delivery interval, and the alternatives it passed
 * over — because a confirmation the buyer cannot check is not consent, it is
 * just a button. The numbers are the same ones the comparison produced;
 * nothing is recomputed here.
 *
 * The agent genuinely cannot proceed past this point: `place_order` sits in
 * `BUYER_CONFIRM_REQUIRED` and the tool registry refuses it from any agent
 * turn. The panel says so, because a claim like that is worth making plainly.
 */
function ConfirmPanel({
  accepted, onPlaceOrder, placing, onDiscard, onSwitch, accepting,
  speaker, spokenLang, addressIndex, onAddressChange,
  instructions, onInstructionsChange,
}: {
  accepted: AcceptResponse;
  onPlaceOrder: () => void;
  addressIndex: number;
  onAddressChange: (i: number) => void;
  instructions: string;
  onInstructionsChange: (next: string) => void;
  placing: boolean;
  onDiscard: () => void;
  onSwitch: (sku?: string, sellerId?: string) => void;
  accepting: boolean;
  speaker: ReturnType<typeof useSpeaker>;
  spokenLang: string;
}) {
  const { added, checkout } = accepted;

  return (
    <section
      id="confirm"
      className="card enter"
      style={{ padding: "1.2rem", marginBottom: "1.4rem", borderLeft: "3px solid var(--haldi)" }}
      aria-labelledby="confirm-h"
    >
      <div
        style={{
          display: "flex", gap: ".5rem", alignItems: "center", flexWrap: "wrap",
          justifyContent: "space-between", marginBottom: ".5rem",
        }}
      >
        <div style={{ display: "flex", gap: ".5rem", alignItems: "center", flexWrap: "wrap" }}>
          <Chip tone="gold">waiting for you</Chip>
          <h3 id="confirm-h">In your cart — nothing ordered yet</h3>
        </div>
        <SpeakButton text={accepted.spoken} lang={spokenLang} speaker={speaker} label="Replay" />
      </div>



      <div style={{ display: "flex", gap: ".9rem", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 650, fontSize: "1rem" }}>
            {added.title}
            {added.qty > 1 && (
              <span style={{ color: "var(--ink-faint)", fontWeight: 400 }}> × {added.qty}</span>
            )}
          </div>
          <div style={{ fontSize: ".84rem", color: "var(--ink-soft)", marginTop: ".15rem" }}>
            sold by {added.seller} ·{" "}
            {checkout.paymentMode === "COD" ? "cash on delivery" : "prepaid"}
            {checkout.address ? ` · to ${checkout.address.city} ${checkout.address.pincode}` : ""}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "1.45rem", fontWeight: 680, lineHeight: 1.1 }}>
            {INR(checkout.payableNowInr)}
          </div>
          <div style={{ fontSize: ".74rem", color: "var(--ink-faint)" }}>charged at checkout</div>
          {checkout.expectedTotalInr !== checkout.payableNowInr && (
            <div style={{ fontSize: ".78rem", color: "var(--ink-soft)", marginTop: ".2rem" }}>
              {INR(checkout.expectedTotalInr)} true expected cost
            </div>
          )}
        </div>
      </div>

      {/* Why the agent chose this one. With a pure need there are no hard
          conditions to tick, so the rationale line carries the reason instead
          of an empty checklist. */}
      <div style={{ marginTop: "1rem", paddingTop: ".85rem", borderTop: "1px solid var(--rule)" }}>
        <div style={{ fontSize: ".78rem", fontWeight: 600, marginBottom: ".5rem" }}>
          Why the agent picked this
        </div>
        {checkout.satisfied.length === 0 && (
          <p style={{ fontSize: ".82rem", color: "var(--ink-soft)", margin: "0 0 .3rem", lineHeight: 1.6 }}>
            {added.rationale}
          </p>
        )}
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: ".3rem" }}>
          {checkout.satisfied.map((sat, i) => (
            <li key={i} style={{ display: "flex", gap: ".5rem", fontSize: ".82rem", alignItems: "baseline" }}>
              <span aria-hidden style={{ color: "var(--moss)", fontWeight: 700, flexShrink: 0 }}>✓</span>
              <span style={{ color: "var(--ink-soft)" }}>
                {sat.constraint} —{" "}
                <span style={{ color: "var(--ink)", fontWeight: 550 }}>{sat.evidence}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div style={{ marginTop: ".9rem", paddingTop: ".85rem", borderTop: "1px solid var(--rule)" }}>
        <DeliveryBlock forecast={checkout.forecast} />
      </div>

      {/* Where it is actually going, stated rather than assumed.
          This used to be a collapsed "Deliver somewhere else" disclosure,
          which meant the destination was only ever implied: the order went to
          `addresses[0]` and the buyer was never actually told where. Shipping
          to the wrong city is not an error the forecast or the risk score can
          catch — both are confidently correct about the wrong place — so the
          address is now on screen, in full, above the button that commits. */}
      <div style={{ marginTop: ".9rem", paddingTop: ".85rem", borderTop: "1px solid var(--rule)" }}>
        <DestinationBlock
          addressIndex={addressIndex}
          onAddressChange={onAddressChange}
          instructions={instructions}
          onInstructionsChange={onInstructionsChange}
        />
      </div>

      <div style={{ marginTop: ".9rem", paddingTop: ".85rem", borderTop: "1px solid var(--rule)" }}>
        <Disclosure summary={`What ${INR(checkout.expectedTotalInr)} is made of`}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: ".82rem" }}>
            <tbody>
              {checkout.costLines.map((l, i) => (
                <tr key={i}>
                  <td style={{ padding: ".3rem 0", verticalAlign: "top" }}>
                    <div style={{ display: "flex", gap: ".35rem", alignItems: "baseline", flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 550 }}>{l.label}</span>
                      {l.probabilistic && <Chip tone="gold">expected, not billed</Chip>}
                    </div>
                    <div style={{ color: "var(--ink-faint)", fontSize: ".76rem", lineHeight: 1.5, maxWidth: "52ch" }}>
                      {l.detail}
                    </div>
                  </td>
                  <td className="mono" style={{ textAlign: "right", verticalAlign: "top", whiteSpace: "nowrap", fontWeight: 600 }}>
                    {l.amountInr === 0 ? "free" : INR(l.amountInr)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: ".78rem", color: "var(--ink-soft)", margin: ".7rem 0 0", lineHeight: 1.6 }}>
            {checkout.costSummary}
          </p>
        </Disclosure>
      </div>

      {/* What it passed over, so accepting is a choice and not a default. */}
      {checkout.alternatives.length > 0 && (
        <div style={{ marginTop: ".9rem", paddingTop: ".85rem", borderTop: "1px solid var(--rule)" }}>
          <Disclosure summary={`${checkout.alternatives.length} other offers it passed over`}>
            {checkout.alternatives.map((a) => (
              <div
                key={`${a.sku}-${a.seller}`}
                style={{
                  display: "flex", gap: ".6rem", alignItems: "baseline",
                  justifyContent: "space-between", flexWrap: "wrap",
                  padding: ".45rem 0", borderTop: "1px solid var(--rule)",
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: ".84rem", fontWeight: 550 }}>
                    {a.title}{" "}
                    <span style={{ color: "var(--ink-faint)", fontWeight: 400 }}>· {a.seller}</span>
                  </div>
                  <div style={{ fontSize: ".78rem", color: "var(--ink-faint)" }}>{a.rankReason}</div>
                </div>
                <div style={{ display: "flex", gap: ".5rem", alignItems: "center", flexShrink: 0 }}>
                  <span className="mono" style={{ fontWeight: 600 }}>{INR(a.expectedTotalInr)}</span>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => onSwitch(a.sku, undefined)}
                    disabled={accepting}
                  >
                    Use this instead
                  </button>
                </div>
              </div>
            ))}
          </Disclosure>
        </div>
      )}

      <div
        style={{
          marginTop: "1.1rem", paddingTop: ".9rem", borderTop: "1px solid var(--rule-strong)",
          display: "flex", gap: ".6rem", flexWrap: "wrap", alignItems: "center",
        }}
      >
        <button className="btn btn-approve" onClick={onPlaceOrder} disabled={placing}>
          {placing ? "Placing" : `Place order · ${INR(checkout.payableNowInr)}`}
        </button>
        <button className="btn btn-ghost" onClick={onDiscard} disabled={placing}>
          Not now
        </button>
        <span style={{ fontSize: ".78rem", color: "var(--ink-faint)" }}>
          Nothing is ordered until you press this.
        </span>
      </div>
    </section>
  );
}

/* ──────────────────────── One admitted offer ──────────────────────── */

function OfferCard({
  offer, onAdd, onAccept, accepting,
}: {
  offer: SolvedOffer;
  onAdd: (sku: string, rationale: string) => void;
  onAccept: (sku?: string, sellerId?: string) => void;
  accepting: boolean;
}) {
  const { candidate: c, cost, forecast, satisfied } = offer;
  const recommended = offer.rank === 1;
  const saving = cost.stickerInr - cost.expectedTotalInr;

  return (
    <article
      className="card actionable"
      style={{
        padding: "1.1rem",
        borderLeft: recommended ? "3px solid var(--moss)" : undefined,
      }}
    >
      <div style={{ display: "flex", gap: ".9rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        <div
          aria-hidden
          style={{
            width: 54, height: 54, borderRadius: 11, flexShrink: 0,
            background: `${c.accentHex ?? "#e2dcd1"}1f`,
            display: "grid", placeItems: "center", fontSize: "1.65rem",
          }}
        >
          {c.imageEmoji ?? "📦"}
        </div>

        <div style={{ flex: "1 1 16rem", minWidth: 0 }}>
          <div style={{ display: "flex", gap: ".4rem", alignItems: "center", flexWrap: "wrap" }}>
            {recommended && <Chip tone="moss">Recommended</Chip>}
            <span style={{ fontSize: ".75rem", color: "var(--ink-faint)" }}>
              #{offer.rank} by true cost
            </span>
          </div>
          <h3 style={{ margin: ".35rem 0 .15rem", fontSize: "1.02rem" }}>{c.title}</h3>
          <div style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>
            {c.brand} · sold by {c.seller.name}
            {c.seller.city ? `, ${c.seller.city}` : ""} · {c.ratingAvg}★
            {c.ratingCount ? ` (${c.ratingCount.toLocaleString("en-IN")})` : ""}
          </div>
          {offer.rankReason && (
            <div
              style={{
                fontSize: ".82rem", marginTop: ".45rem", lineHeight: 1.55,
                color: recommended ? "var(--moss)" : "var(--ink-soft)",
                fontWeight: recommended ? 550 : 400,
              }}
            >
              {offer.rankReason}
            </div>
          )}
        </div>

        <div style={{ textAlign: "right", flexShrink: 0, minWidth: "9rem" }}>
          <div style={{ fontSize: "1.3rem", fontWeight: 680, lineHeight: 1.1 }}>
            {INR(cost.expectedTotalInr)}
          </div>
          <div style={{ fontSize: ".74rem", color: "var(--ink-faint)" }}>
            true expected cost
          </div>
          {saving !== 0 && (
            <div style={{ fontSize: ".78rem", color: "var(--ink-soft)", marginTop: ".3rem" }}>
              sticker {INR(cost.stickerInr)}
            </div>
          )}
          <button
            className="btn btn-primary btn-sm"
            style={{ marginTop: ".6rem" }}
            onClick={() => onAccept(c.sku, c.seller.sellerId)}
            disabled={accepting}
          >
            Choose this one
          </button>
          <button
            className="btn btn-ghost btn-sm"
            style={{ marginTop: ".35rem" }}
            onClick={() =>
              onAdd(c.sku, `It satisfies all ${satisfied.length} of your conditions.`)
            }
          >
            Just add to cart
          </button>
        </div>
      </div>

      {/* ── Each constraint, ticked against the product's own value ── */}
      <div style={{ marginTop: "1rem", paddingTop: ".85rem", borderTop: "1px solid var(--rule)" }}>
        <div style={{ fontSize: ".78rem", fontWeight: 600, marginBottom: ".5rem" }}>
          What you asked for
        </div>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: ".3rem" }}>
          {satisfied.map((s, i) => (
            <li key={i} style={{ display: "flex", gap: ".5rem", fontSize: ".82rem", alignItems: "baseline" }}>
              <span aria-hidden style={{ color: "var(--moss)", fontWeight: 700, flexShrink: 0 }}>✓</span>
              <span style={{ color: "var(--ink-soft)" }}>
                {s.constraint} —{" "}
                <span style={{ color: "var(--ink)", fontWeight: 550 }}>{s.evidence}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* ── Delivery, as an interval ─────────────────────────────── */}
      <div style={{ marginTop: ".9rem", paddingTop: ".85rem", borderTop: "1px solid var(--rule)" }}>
        <DeliveryBlock forecast={forecast} />
      </div>

      {/* ── The cost, taken apart ────────────────────────────────── */}
      <div style={{ marginTop: ".9rem", paddingTop: ".85rem", borderTop: "1px solid var(--rule)" }}>
        <Disclosure
          summary={`What ${INR(cost.expectedTotalInr)} is made of`}
          defaultOpen={recommended}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: ".82rem" }}>
            <tbody>
              {cost.lines.map((l, i) => (
                <tr key={i}>
                  <td style={{ padding: ".32rem 0", verticalAlign: "top" }}>
                    <div style={{ display: "flex", gap: ".35rem", alignItems: "baseline", flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 550 }}>{l.label}</span>
                      {l.probabilistic && <Chip tone="gold">expected, not billed</Chip>}
                    </div>
                    <div style={{ color: "var(--ink-faint)", fontSize: ".76rem", lineHeight: 1.5, maxWidth: "52ch" }}>
                      {l.detail}
                    </div>
                  </td>
                  <td
                    className="mono"
                    style={{ padding: ".32rem 0", textAlign: "right", verticalAlign: "top", whiteSpace: "nowrap", fontWeight: 600 }}
                  >
                    {l.amountInr === 0 ? "free" : INR(l.amountInr)}
                  </td>
                </tr>
              ))}
              <tr>
                <td style={{ padding: ".5rem 0 0", borderTop: "1px solid var(--rule-strong)", fontWeight: 650 }}>
                  True expected cost
                </td>
                <td
                  className="mono"
                  style={{
                    padding: ".5rem 0 0", borderTop: "1px solid var(--rule-strong)",
                    textAlign: "right", fontWeight: 680,
                  }}
                >
                  {INR(cost.expectedTotalInr)}
                </td>
              </tr>
              <tr>
                <td style={{ paddingTop: ".2rem", fontSize: ".76rem", color: "var(--ink-faint)" }}>
                  Charged at checkout
                </td>
                <td
                  className="mono"
                  style={{ paddingTop: ".2rem", textAlign: "right", fontSize: ".76rem", color: "var(--ink-faint)" }}
                >
                  {INR(cost.payableNowInr)}
                </td>
              </tr>
            </tbody>
          </table>
          <p style={{ fontSize: ".78rem", color: "var(--ink-soft)", margin: ".7rem 0 0", lineHeight: 1.6 }}>
            {cost.summary}
          </p>
        </Disclosure>
      </div>
    </article>
  );
}

/**
 * The delivery interval.
 *
 * Two dates, not one, and the second is the one to trust. A single optimistic
 * date is what every other platform shows, and it is the reason nobody
 * believes delivery promises.
 */
function DeliveryBlock({ forecast }: { forecast: Forecast }) {
  const d = forecast.deadline;
  const tone = !d ? "neutral" : d.verdict === "SAFE" ? "moss" : d.verdict === "TIGHT" ? "gold" : "brick";
  const colour =
    tone === "moss" ? "var(--moss)" : tone === "gold" ? "var(--haldi-deep)" : tone === "brick" ? "var(--brick)" : "var(--ink-soft)";

  return (
    <div>
      <div style={{ display: "flex", gap: ".6rem", alignItems: "baseline", flexWrap: "wrap" }}>
        <div style={{ fontSize: ".78rem", fontWeight: 600 }}>Delivery</div>
        {d && (
          <Chip tone={tone as "moss"}>
            {d.verdict === "SAFE" ? "meets your date" : d.verdict === "TIGHT" ? "tight" : "will miss"}
          </Chip>
        )}
      </div>

      <div style={{ display: "flex", gap: "1.4rem", flexWrap: "wrap", marginTop: ".45rem" }}>
        <div>
          <div style={{ fontSize: ".95rem", fontWeight: 600 }}>{DAY(forecast.likelyAt)}</div>
          <div style={{ fontSize: ".74rem", color: "var(--ink-faint)" }}>likely</div>
        </div>
        <div>
          <div style={{ fontSize: ".95rem", fontWeight: 600, color: colour }}>
            {DAY(forecast.confidentAt)}
          </div>
          <div style={{ fontSize: ".74rem", color: "var(--ink-faint)" }}>
            {forecast.confidencePct}% confident
          </div>
        </div>
      </div>

      {d && (
        <p style={{ fontSize: ".82rem", color: colour, margin: ".55rem 0 0", lineHeight: 1.6, maxWidth: "62ch" }}>
          {d.sentence}
        </p>
      )}

      <div style={{ marginTop: ".5rem" }}>
        <Disclosure
          summary={
            forecast.slackDays > 0
              ? `Why ${forecast.slackDays} day${forecast.slackDays === 1 ? "" : "s"} of slack`
              : "How this date was computed"
          }
        >
          <ul className="ladder">
            {forecast.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </Disclosure>
      </div>
    </div>
  );
}

/* ──────────────────────── One rejected offer ──────────────────────── */

function RejectedRow({ rejected }: { rejected: RejectedOffer }) {
  const { candidate: c, primary, failed } = rejected;
  const others = failed.filter((f) => f !== primary);

  return (
    <div
      style={{
        display: "flex", gap: ".7rem", padding: ".6rem 0",
        borderTop: "1px solid var(--rule)", alignItems: "flex-start",
      }}
    >
      <span aria-hidden style={{ color: "var(--brick)", fontWeight: 700, flexShrink: 0, fontSize: ".9rem" }}>
        ✕
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: ".86rem", fontWeight: 550 }}>
          {c.title}{" "}
          <span style={{ color: "var(--ink-faint)", fontWeight: 400 }}>
            · {c.seller.name} · {INR(c.priceInr)}
          </span>
        </div>
        <div style={{ fontSize: ".81rem", color: "var(--ink-soft)", marginTop: ".2rem", lineHeight: 1.55 }}>
          Failed <strong style={{ fontWeight: 600 }}>{primary.constraint}</strong> — {primary.actual}
        </div>
        {others.length > 0 && (
          <div style={{ fontSize: ".76rem", color: "var(--ink-faint)", marginTop: ".2rem" }}>
            also failed: {others.map((f) => f.constraint).join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────────── Helpers ───────────────────────────── */

/**
 * Rebuild editable constraints from the server's echo.
 *
 * The server returns constraints as `{kind, text}` for display. Editing one
 * needs the typed value back, so the display text is parsed. Keeping the typed
 * form server-side and the text client-side would mean two representations of
 * the same list that could disagree — this way the echo is the single source.
 */
function toConstraints(r: FinderResponse): Constraint[] {
  return r.constraints
    .map((c) => fromText(c.kind, c.text))
    .filter((c): c is Constraint => c !== null);
}

function fromText(kind: string, text: string): Constraint | null {
  const money = () => Number.parseInt(text.replace(/[^\d]/g, ""), 10) || 0;

  switch (kind) {
    case "category":
      return { kind: "category", value: text.replace(/^category is /, "") };
    case "max_price":
      return { kind: "max_price", value: money() };
    case "min_price":
      return { kind: "min_price", value: money() };
    case "max_true_cost":
      return { kind: "max_true_cost", value: money() };
    case "brand":
      return { kind: "brand", value: text.replace(/^brand is /, "") };
    case "min_rating": {
      const m = text.match(/([\d.]+)/);
      return m ? { kind: "min_rating", value: Number.parseFloat(m[1]) } : null;
    }
    case "max_seller_defect_rate": {
      const m = text.match(/([\d.]+)%/);
      return m ? { kind: "max_seller_defect_rate", value: Number.parseFloat(m[1]) } : null;
    }
    case "in_stock":
      return { kind: "in_stock", value: true };
    case "payment_mode":
      return { kind: "payment_mode", value: /cash/.test(text) ? "COD" : "PREPAID" };
    case "arrive_by": {
      const m = text.match(/(\d{4}-\d{2}-\d{2})/);
      return m ? { kind: "arrive_by", value: `${m[1]}T23:59:00Z` } : null;
    }
    case "attribute": {
      // "induction is yes" / "capacity (l) is 5"
      const m = text.match(/^(.+?) is (.+)$/);
      if (!m) return null;
      const key = m[1].replace(/\s*\(([a-z]+)\)\s*$/, "_$1").replace(/\s+/g, "_");
      const raw = m[2].trim();
      if (raw === "yes") return { kind: "attribute", key, value: true };
      if (raw === "no") return { kind: "attribute", key, value: false };
      const n = Number.parseFloat(raw);
      return { kind: "attribute", key, value: Number.isFinite(n) && /^[\d.]+$/.test(raw) ? n : raw };
    }
    default:
      return null;
  }
}
