/**
 * Text to speech, through ElevenLabs.
 *
 * The agent already listens — Whisper takes a spoken need in any of eight
 * languages. This is the other half: it answers out loud, so a buyer who spoke
 * their need does not then have to read three paragraphs to find out what
 * happened.
 *
 * Three rules, in the same spirit as the rest of the platform:
 *
 *  1. **Optional.** With no key the UI never offers to speak and nothing else
 *     changes. A voice vendor being unreachable must never break a demo.
 *  2. **It speaks a summary, never the screen.** The text handed here is a
 *     purpose-written line or two — the things a buyer actually needs to hear.
 *     Reading a cost table aloud would be worse than silence.
 *  3. **It states nothing the engines did not compute.** Callers pass a
 *     summary built from engine output, so the spoken version cannot drift
 *     from the numbers on screen.
 */
import { env } from "@/lib/env";

const API = "https://api.elevenlabs.io/v1/text-to-speech";

/** Hard cap on what we will synthesise. Charged per character, so bounded. */
export const MAX_CHARS = 600;

/** How long to wait before giving up and letting the page stay silent. */
const TIMEOUT_MS = 15_000;

export type SpeechResult =
  | { ok: true; audio: Buffer; mimeType: string; chars: number }
  | { ok: false; error: string; status: number };

/**
 * ISO 639-1 codes for the languages this platform accepts.
 *
 * Passed as `language_code` so the model does not have to guess from the text,
 * which matters for transliterated input: "mujhe cooker chahiye" is Hindi
 * written in Latin script, and without the hint it is read as English.
 */
const LANG_CODES: Record<string, string> = {
  en: "en", hi: "hi", kn: "kn", ta: "ta",
  te: "te", mr: "mr", bn: "bn", gu: "gu",
};

export async function speak(
  text: string,
  opts: { lang?: string; voiceId?: string } = {},
): Promise<SpeechResult> {
  if (!env.eleven.enabled) {
    return { ok: false, error: "no ELEVENLABS_API_KEY configured", status: 503 };
  }

  const clean = sanitise(text);
  if (!clean) return { ok: false, error: "nothing to say", status: 422 };

  const voiceId = opts.voiceId || env.eleven.voiceId;
  const url = `${API}/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(env.eleven.outputFormat)}`;

  const body: Record<string, unknown> = {
    text: clean,
    model_id: env.eleven.model,
    // Tuned for information rather than performance: high stability keeps a
    // price or a date from being swallowed by expressive delivery, and a
    // slightly slower rate keeps rupee amounts intelligible.
    voice_settings: { stability: 0.6, similarity_boost: 0.75, speed: 0.95 },
  };

  const code = LANG_CODES[opts.lang ?? "en"];
  // `language_code` is rejected by the multilingual_v2 family, so it is only
  // sent for models that accept it.
  if (code && !env.eleven.model.includes("multilingual")) body.language_code = code;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": env.eleven.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // ElevenLabs returns a JSON detail on failure; surface it rather than a
      // bare status, because "quota exceeded" and "bad voice id" need
      // different fixes and look identical as a 401.
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        error: `ElevenLabs ${res.status}${detail ? `: ${truncate(detail, 200)}` : ""}`,
      };
    }

    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.byteLength === 0) {
      return { ok: false, error: "ElevenLabs returned empty audio", status: 502 };
    }

    return {
      ok: true,
      audio,
      mimeType: mimeFor(env.eleven.outputFormat),
      chars: clean.length,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 502,
      error: aborted
        ? `ElevenLabs did not respond within ${TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prepare text for a voice.
 *
 * Markdown, emoji and currency symbols all read badly aloud: a model will
 * either say "asterisk" or swallow the emphasis entirely, and "₹1,649" can
 * come out as a digit string. So the markup is stripped and rupees are spoken
 * as words.
 */
export function sanitise(text: string): string {
  let out = (text ?? "")
    .replace(/[*_`#>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their label
    .replace(/\s*\n+\s*/g, ". ") // line breaks become sentence breaks
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "") // emoji
    .replace(/\s{2,}/g, " ")
    .trim();

  // "₹1,649" → "1649 rupees". Said after the number, as in Indian English.
  out = out.replace(/₹\s?([\d,]+)/g, (_m, n: string) => `${n.replace(/,/g, "")} rupees`);

  // Tidy the double punctuation the newline substitution can leave behind.
  out = out.replace(/\.\s*\./g, ".").replace(/\s+([.,!?])/g, "$1").trim();

  return out.length > MAX_CHARS ? `${out.slice(0, MAX_CHARS).replace(/\s+\S*$/, "")}…` : out;
}

function mimeFor(format: string): string {
  if (format.startsWith("mp3")) return "audio/mpeg";
  if (format.startsWith("opus")) return "audio/ogg";
  if (format.startsWith("wav")) return "audio/wav";
  if (format.startsWith("pcm")) return "audio/basic";
  return "audio/mpeg";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
