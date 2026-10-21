/**
 * The one place a model is called.
 *
 * Three capabilities, one key:
 *   chat()       — tool-calling text model, drives both agents
 *   seeImage()   — vision model, inspects defect photographs
 *   transcribe() — Whisper, turns a voice complaint into text
 *
 * Every function here is allowed to fail. A failure sets a degraded flag and
 * returns null; callers fall back to a deterministic path rather than throwing
 * a 500 at a customer. Nothing in this file decides money.
 */
import Groq from "groq-sdk";
import { env } from "@/lib/env";

const TIMEOUT_MS = 30_000;

let client: Groq | null = null;
let clientKey = "";

function groq(): Groq | null {
  if (!env.groq.enabled) return null;
  // Rebuild if the key changed. The instance is cached for reuse, but caching
  // it against a stale key means a configuration change is silently ignored.
  if (!client || clientKey !== env.groq.apiKey) {
    clientKey = env.groq.apiKey;
    // Groq's free tier is tight on tokens-per-minute, and a multi-turn agent
    // run can cross it mid-conversation. The SDK honours `retry-after` on a
    // 429, so letting it retry is the difference between a brief pause and the
    // whole turn silently dropping to the deterministic path.
    // One SDK retry, not four. A per-minute blip is worth retrying; a daily
    // cap is not, and four retries against an exhausted model just delays the
    // failover to a model that would have answered immediately.
    client = new Groq({ apiKey: clientKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  }
  return client;
}

export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatResult = {
  ok: boolean;
  content: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  error?: string;
  usage?: { promptTokens: number; completionTokens: number };
  /** Which model actually answered, when a fallback was used. */
  model?: string;
  /** True when another model is worth trying (quota, retired name, outage). */
  retryable?: boolean;
};

const EMPTY: ChatResult = { ok: false, content: "", toolCalls: [] };

/** A tool-calling chat turn. Returns ok:false rather than throwing. */
export async function chat(
  messages: ChatMessage[],
  opts: {
    tools?: ToolSchema[];
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    model?: string;
  } = {},
): Promise<ChatResult> {
  const g = groq();
  if (!g) return { ...EMPTY, error: "no GROQ_API_KEY configured" };

  // Try the configured model, then the declared fallbacks. Groq's quotas are
  // per-model and per-day, so one model can be exhausted while another has
  // headroom — and a different model's voice is a far smaller loss than
  // dropping the whole conversation to keyword search.
  const chain = opts.model
    ? [opts.model]
    : [env.groq.textModel, ...env.groq.fallbackModels];

  let last: ChatResult = { ...EMPTY, error: "no model attempted" };

  for (const model of chain) {
    const attempt = await once(model, messages, opts);
    if (attempt.ok) {
      if (model !== chain[0]) {
        console.warn(`[groq] ${chain[0]} unavailable; answered with ${model}`);
      }
      return { ...attempt, model };
    }
    last = attempt;
    // Only a quota or availability problem is worth another model. A bad
    // request is our bug and will fail identically everywhere.
    if (!attempt.retryable) break;
  }

  return last;
}

/** One attempt against one model. */
async function once(
  model: string,
  messages: ChatMessage[],
  opts: {
    tools?: ToolSchema[];
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
  },
): Promise<ChatResult> {
  const g = groq();
  if (!g) return { ...EMPTY, error: "no GROQ_API_KEY configured" };

  try {
    const res = await g.chat.completions.create({
      model,
      messages: messages as never,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1400,
      ...(opts.tools?.length ? { tools: opts.tools as never, tool_choice: "auto" as const } : {}),
      ...(opts.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
    });

    const choice = res.choices?.[0];
    const raw = choice?.message?.tool_calls ?? [];
    const toolCalls = raw.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: safeJson(tc.function.arguments),
    }));

    return {
      ok: true,
      content: choice?.message?.content ?? "",
      toolCalls,
      usage: res.usage
        ? { promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens }
        : undefined,
    };
  } catch (err) {
    const status =
      err && typeof err === "object" && "status" in err
        ? (err as { status?: number }).status
        : undefined;
    return {
      ...EMPTY,
      error: describe(err),
      // 429 is quota, 404 is a retired model name, 5xx is Groq being down.
      // All three are worth trying a different model for.
      // Also matched on the message, because the SDK does not always preserve
      // `status` after exhausting its own retries, and a failover that depends
      // on one field being present is a failover that quietly does not happen.
      retryable:
        status === 429 ||
        status === 404 ||
        (status !== undefined && status >= 500) ||
        /rate limit|quota|tokens per day|TPD|does not exist|unavailable|overloaded/i.test(
          err instanceof Error ? err.message : String(err),
        ),
    };
  }
}

/** Ask for strict JSON and parse it. Returns null if the model is unavailable. */
export async function chatJson<T>(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; model?: string } = {},
): Promise<T | null> {
  const res = await chat(messages, { ...opts, jsonMode: true });
  if (!res.ok || !res.content) return null;
  try {
    return JSON.parse(res.content) as T;
  } catch {
    // Some models wrap JSON in prose or a fence; recover the outermost object.
    const m = res.content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}

export type VisionFindings = {
  describesProduct: string;
  defectVisible: boolean;
  defectKind: string;
  defectSeverity: "none" | "minor" | "moderate" | "severe";
  matchesClaim: "supports" | "contradicts" | "unclear";
  looksLikeScreenshot: boolean;
  looksLikeStockPhoto: boolean;
  observations: string[];
  confidence: number;
};

/**
 * Look at a defect photograph against what the buyer said.
 *
 * The prompt asks for observation, not adjudication: the model reports what is
 * in the frame, and `assessAuthenticity` decides what that is worth. Asking a
 * vision model "is this fraud?" invites it to guess at intent from pixels.
 */
export async function seeImage(
  dataUrl: string,
  claimText: string,
  productTitle: string,
): Promise<VisionFindings | null> {
  const g = groq();
  if (!g) return null;

  const instruction = [
    "You are a returns inspector looking at one photograph submitted with a",
    "product complaint. Report only what you can see in the frame.",
    "",
    `Product as sold: ${productTitle}`,
    `What the buyer says is wrong: ${claimText}`,
    "",
    "Return JSON with exactly these keys:",
    '  describesProduct   string  - what item is actually in the photo',
    '  defectVisible      boolean - is any damage/defect visible at all',
    '  defectKind         string  - e.g. "cracked screen", "torn seam", "none"',
    '  defectSeverity     "none"|"minor"|"moderate"|"severe"',
    '  matchesClaim       "supports"|"contradicts"|"unclear"',
    '  looksLikeScreenshot boolean - is this a screenshot of another screen',
    '  looksLikeStockPhoto boolean - is this a catalogue/marketing image',
    '  observations       string[] - up to 4 short factual notes',
    '  confidence         number  - 0..1, your confidence in the above',
    "",
    'Use "unclear" freely. Do not speculate about the buyer intent or honesty.',
  ].join("\n");

  try {
    const res = await g.chat.completions.create({
      model: env.groq.visionModel,
      temperature: 0.1,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ] as never,
    });
    const text = res.choices?.[0]?.message?.content ?? "";
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<VisionFindings>;
    return normaliseFindings(parsed);
  } catch {
    return null;
  }
}

function normaliseFindings(p: Partial<VisionFindings>): VisionFindings {
  const sev = ["none", "minor", "moderate", "severe"];
  const match = ["supports", "contradicts", "unclear"];
  return {
    describesProduct: String(p.describesProduct ?? "").slice(0, 300),
    defectVisible: Boolean(p.defectVisible),
    defectKind: String(p.defectKind ?? "").slice(0, 200),
    defectSeverity: (sev.includes(String(p.defectSeverity))
      ? p.defectSeverity
      : "none") as VisionFindings["defectSeverity"],
    matchesClaim: (match.includes(String(p.matchesClaim))
      ? p.matchesClaim
      : "unclear") as VisionFindings["matchesClaim"],
    looksLikeScreenshot: Boolean(p.looksLikeScreenshot),
    looksLikeStockPhoto: Boolean(p.looksLikeStockPhoto),
    observations: Array.isArray(p.observations)
      ? p.observations.slice(0, 4).map((o) => String(o).slice(0, 220))
      : [],
    confidence: clamp01(Number(p.confidence ?? 0.5)),
  };
}

export type Transcription = { text: string; language: string };

/**
 * Voice complaint -> text, in whatever Indian language it was spoken in.
 * Whisper detects the language itself; we do not ask the buyer to declare it.
 */
export async function transcribe(
  audio: Buffer,
  filename: string,
): Promise<Transcription | null> {
  const g = groq();
  if (!g) return null;
  try {
    const file = new File([new Uint8Array(audio)], filename, {
      type: guessAudioMime(filename),
    });
    const res = await g.audio.transcriptions.create({
      file: file as never,
      model: env.groq.audioModel,
      response_format: "verbose_json",
    });
    const r = res as unknown as { text?: string; language?: string };
    if (!r.text) return null;
    return { text: r.text.trim(), language: normaliseLang(r.language) };
  } catch {
    return null;
  }
}

function guessAudioMime(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    webm: "audio/webm", ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4",
    wav: "audio/wav", flac: "audio/flac", mp4: "audio/mp4",
  };
  return map[ext] ?? "audio/webm";
}

function normaliseLang(l?: string): string {
  if (!l) return "en";
  const map: Record<string, string> = {
    english: "en", hindi: "hi", kannada: "kn", tamil: "ta", telugu: "te",
    marathi: "mr", bengali: "bn", gujarati: "gu",
  };
  const k = l.toLowerCase();
  return map[k] ?? (k.length === 2 ? k : "en");
}

/** One live call, used by the header badge to prove the key works. */
export async function pingModel(): Promise<{ ok: boolean; detail: string }> {
  if (!env.groq.enabled) {
    return { ok: false, detail: "No GROQ_API_KEY set — running the deterministic path." };
  }
  const res = await chat([{ role: "user", content: "Reply with the single word: ready" }], {
    maxTokens: 8,
    temperature: 0,
  });
  return res.ok
    ? { ok: true, detail: `groq/${env.groq.textModel} is live.` }
    : { ok: false, detail: res.error ?? "the model call failed" };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/**
 * Turn a provider error into something a person can act on.
 *
 * The 404 case matters most: Groq retires model names, and a retired name
 * fails exactly like a missing key — the agent silently drops to its fallback
 * and the UI says "running without a model", which sends you looking at the
 * wrong thing. So the model name is named, and the fix is stated.
 */
function describe(err: unknown): string {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status?: number; message?: string };
    if (e.status === 401) {
      return "the GROQ_API_KEY was rejected (401) — check the key at console.groq.com/keys";
    }
    if (e.status === 429) {
      // Groq enforces both a per-minute and a per-DAY token cap, per model.
      // The message distinguishes them, because the remedy differs: a minute
      // clears itself, a day does not.
      const msg = e.message ?? "";
      const perDay = /tokens per day|TPD/i.test(msg);
      const used = msg.match(/Limit (\d+), Used (\d+)/);
      if (perDay) {
        return (
          `the daily token quota for "${env.groq.textModel}" is exhausted` +
          (used ? ` (${used[2]} of ${used[1]} used)` : "") +
          ". It resets at 00:00 UTC. Other models have separate quotas, so set " +
          "GROQ_TEXT_MODEL to one from `npm run models`, or add GROQ_FALLBACK_MODELS"
        );
      }
      return (
        "Groq per-minute rate limit reached (429) after retries — it clears " +
        "within a minute. Reduce the burst, or set GROQ_FALLBACK_MODELS"
      );
    }
    if (e.status === 404) {
      return (
        `the model "${env.groq.textModel}" does not exist or your key cannot reach it (404). ` +
        `Groq retires model names: run "npm run models" to list what this key can use, ` +
        `then set GROQ_TEXT_MODEL in .env`
      );
    }
    if (e.status === 400 && /json/i.test(e.message ?? "")) {
      return `the model "${env.groq.textModel}" could not satisfy JSON mode (400) — try a different GROQ_TEXT_MODEL`;
    }
    return `${e.status ?? "?"}: ${e.message ?? "unknown error"}`;
  }
  return err instanceof Error ? err.message : String(err);
}
