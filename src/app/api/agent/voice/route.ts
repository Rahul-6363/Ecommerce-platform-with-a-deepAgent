import { requireUser } from "@/lib/auth/session";
import { transcribe } from "@/lib/groq/client";
import { detectScript } from "@/lib/agent/triage";
import { handler, fail } from "@/lib/api";
import { env } from "@/lib/env";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = [
  "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4",
  "audio/wav", "audio/x-wav", "audio/flac", "video/webm",
];

/**
 * Speech to text, so a buyer can say what they want or what went wrong rather
 * than typing it in a second language. Whisper detects the language itself.
 */
export async function POST(req: Request) {
  return handler(async () => {
    await requireUser();

    if (!env.groq.enabled) {
      return fail(
        "Voice input needs a GROQ_API_KEY. Type your message instead — everything else works.",
        503,
      );
    }

    const form = await req.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) return fail("Attach an audio file as 'audio'.", 422);
    if (file.size === 0) return fail("The recording was empty. Try again.", 422);
    if (file.size > MAX_BYTES) {
      return fail(`That recording is ${(file.size / 1e6).toFixed(1)}MB; the limit is 10MB.`, 413);
    }
    // The type comes from the browser, so it is a hint, not a guarantee —
    // Whisper rejects anything it cannot decode regardless.
    if (file.type && !ALLOWED.some((t) => file.type.startsWith(t.split("/")[0]))) {
      return fail(`Unsupported audio type ${file.type}.`, 415);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const result = await transcribe(buf, file.name || "recording.webm");

    if (!result) {
      return fail(
        "We could not transcribe that recording. Please try again, or type your message.",
        502,
      );
    }

    return {
      text: result.text,
      language: result.language,
      // Whisper's own language label and the script we detect usually agree;
      // when they do not, the script is the more reliable signal for replying.
      scriptLanguage: detectScript(result.text),
      bytes: buf.length,
    };
  });
}
