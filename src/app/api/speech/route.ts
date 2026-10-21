/**
 * POST /api/speech — turn a line of agent text into audio.
 *
 * Returns the audio bytes directly rather than JSON, so the browser can hand
 * the response straight to an `<audio>` element without a base64 round trip.
 *
 * The text is capped and sanitised in `speak()`. That cap is the whole safety
 * model here: this endpoint is authenticated and metered by character, so an
 * unbounded body would be a way to spend someone else's ElevenLabs quota.
 */
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { fail } from "@/lib/api";
import { speak, MAX_CHARS } from "@/lib/speech/eleven";
import { env } from "@/lib/env";
import { LANGUAGES } from "@/lib/types";

const Body = z.object({
  text: z.string().min(1).max(2000),
  lang: z.enum(Object.keys(LANGUAGES) as [string, ...string[]]).default("en"),
});

export async function POST(req: Request) {
  // Not wrapped in `handler()`: that helper JSON-encodes its return value, and
  // this route answers with audio.
  try {
    await requireUser();

    if (!env.eleven.enabled) {
      return fail(
        "Spoken replies need an ELEVENLABS_API_KEY. Everything else works without it.",
        503,
      );
    }

    const body = Body.parse(await req.json().catch(() => ({})));
    const result = await speak(body.text, { lang: body.lang });

    if (!result.ok) return fail(result.error, result.status);

    return new Response(new Uint8Array(result.audio), {
      status: 200,
      headers: {
        "content-type": result.mimeType,
        "content-length": String(result.audio.byteLength),
        // Identical text asked for twice in a session is the same audio, and
        // it is charged per character — so let the browser reuse it.
        "cache-control": "private, max-age=3600",
        "x-speech-chars": String(result.chars),
        "x-speech-model": env.eleven.model,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /sign in/i.test(message) ? 401 : 400;
    return fail(message, status);
  }
}

export { MAX_CHARS };
