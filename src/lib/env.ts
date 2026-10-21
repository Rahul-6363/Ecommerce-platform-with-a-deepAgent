/**
 * Single source of truth for configuration.
 *
 * Nothing in here throws on a missing value. Every optional capability
 * (model, mail, real database) reports its own readiness so the UI can say
 * plainly what is live and what is running on the fallback path — a demo that
 * fails silently is worse than one that admits it is degraded.
 */

function str(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === null || v.trim() === "" ? fallback : v.trim();
}

function int(key: string, fallback: number): number {
  const n = Number.parseInt(str(key), 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback = false): boolean {
  const v = str(key).toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes";
}

export const env = {
  groq: {
    // A getter, not a captured value. `env` is built once at import, so a
    // snapshot here would ignore any later change to the environment — which
    // makes the degraded path impossible to test, and means editing .env has
    // no effect until the module is reloaded.
    get apiKey() {
      return str("GROQ_API_KEY");
    },
    // Groq retires model names without notice, and a retired name returns a
    // 404 that looks exactly like a broken key. These defaults are ones a
    // current free-tier key can reach; /api/health?deep=1 reports the truth,
    // and `npm run models` lists what your own key can actually use.
    textModel: str("GROQ_TEXT_MODEL", "qwen/qwen3.8-27b"),
    visionModel: str("GROQ_VISION_MODEL", "qwen/qwen3.8-27b"),
    audioModel: str("GROQ_AUDIO_MODEL", "whisper-large-v3-turbo"),
    /**
     * Models to try when the primary one is rate limited.
     *
     * Groq's quotas are per-model and per-day, so a busy day can exhaust one
     * model while others still have headroom. Falling back to another model
     * keeps the agent conversational instead of dropping to keyword search —
     * which is a far worse experience than a slightly different voice.
     *
     * Order matters: these are the models that passed the tool-calling and
     * JSON-mode probes in `npm run models`.
     */
    get fallbackModels(): string[] {
      const configured = str("GROQ_FALLBACK_MODELS");
      if (configured) return configured.split(",").map((m) => m.trim()).filter(Boolean);
      return ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];
    },
    get enabled() {
      return this.apiKey.startsWith("gsk_");
    },
  },
  /**
   * ElevenLabs, for the agent's spoken replies.
   *
   * Entirely optional, like every other capability here: with no key the UI
   * simply never offers to speak, and nothing else changes. A demo that breaks
   * because a voice vendor is unreachable would be a worse demo than a silent
   * one.
   */
  eleven: {
    get apiKey() {
      return str("ELEVENLABS_API_KEY");
    },
    /**
     * `eleven_v4_turbo` is ElevenLabs' recommended low-latency conversational
     * model (~100ms median inference) and covers every language this platform
     * accepts — Hindi, Kannada, Tamil, Telugu, Marathi, Gujarati and Bengali.
     *
     * That last part rules out the cheaper options: `eleven_flash_v2_5` and
     * `eleven_multilingual_v2` carry Hindi and Tamil but not Kannada, Telugu
     * or Marathi, which is most of the buyers this platform is built for.
     * `eleven_turbo_v2_5` is deprecated.
     */
    model: str("ELEVENLABS_MODEL", "eleven_v4_turbo"),
    // "Jessica" — a default voice, so it works on a free ElevenLabs key.
    // The Indian-accented voices live in the shared voice library, which the
    // API gates behind a paid plan (402 paid_plan_required), as does designing
    // one. So this stays a single env knob: paste an Indian voice id here on a
    // paid key and every spoken line switches, with no code change.
    voiceId: str("ELEVENLABS_VOICE_ID", "cgSgspJ2msm6clMCkdW9"),
    /**
     * mp3 at 64kbps: every browser plays it, and the quality difference at
     * this length is inaudible while the file is half the size. Higher
     * bitrates are a paid-tier feature anyway.
     */
    outputFormat: str("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_64"),
    get enabled() {
      return this.apiKey.length > 0;
    },
  },
  mongo: {
    uri: str("MONGODB_URI"),
    dbName: str("MONGODB_DB", "vaanijya"),
    get isExternal() {
      return this.uri.length > 0;
    },
  },
  mail: {
    host: str("SMTP_HOST"),
    port: int("SMTP_PORT", 587),
    secure: bool("SMTP_SECURE", false),
    user: str("SMTP_USER"),
    pass: str("SMTP_PASS"),
    from: str("MAIL_FROM", "Vaanijya <no-reply@vaanijya.in>"),
    ops: str("OPS_EMAIL", "ops@vaanijya.in"),
    get enabled() {
      return this.host.length > 0 && this.user.length > 0;
    },
  },
  auth: {
    secret: str("AUTH_SECRET", "dev-only-insecure-secret-please-change"),
    get isDefault() {
      return this.secret.startsWith("dev-only");
    },
  },
  app: {
    baseUrl: str("APP_BASE_URL", "http://localhost:3000"),
    isProd: process.env.NODE_ENV === "production",
  },
} as const;

/** What the header badge and /api/health report. */
export function capabilities() {
  return {
    model: env.groq.enabled
      ? { status: "live" as const, detail: `groq/${env.groq.textModel}` }
      : { status: "fallback" as const, detail: "no GROQ_API_KEY — deterministic rules path" },
    vision: env.groq.enabled
      ? { status: "live" as const, detail: `groq/${env.groq.visionModel}` }
      : { status: "fallback" as const, detail: "heuristic image checks only" },
    voice: env.groq.enabled
      ? { status: "live" as const, detail: `groq/${env.groq.audioModel}` }
      : { status: "fallback" as const, detail: "typed complaints only" },
    speech: env.eleven.enabled
      ? { status: "live" as const, detail: `elevenlabs/${env.eleven.model}` }
      : { status: "fallback" as const, detail: "no ELEVENLABS_API_KEY — the agent stays silent" },
    database: env.mongo.isExternal
      ? { status: "live" as const, detail: "external MongoDB" }
      : { status: "ephemeral" as const, detail: "in-process MongoDB (data resets on restart)" },
    mail: env.mail.enabled
      ? { status: "live" as const, detail: `SMTP ${env.mail.host}:${env.mail.port}` }
      : { status: "outbox" as const, detail: "no SMTP_HOST — mail captured to the Outbox" },
  };
}
