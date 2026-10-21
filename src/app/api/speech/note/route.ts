/**
 * POST /api/speech/note — one spoken remark into plain text.
 *
 * The address dictation endpoint parses what it hears into a structured
 * address, which is right there and wrong here: delivery instructions are
 * free text on purpose. "Leave it with the guard, the gate code is 4417, and
 * please call before seven" has no fields to fill, and the value of it is
 * precisely that no dropdown anticipated it.
 *
 * So this route transcribes and stops. It does not interpret, extract or
 * classify, and it deliberately does not save anything: the caller shows the
 * text to the buyer, who edits it and presses the button themselves. That
 * confirmation matters more here than elsewhere, because a misheard
 * instruction reaches a courier and nothing downstream can catch it.
 */
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { handler, fail } from "@/lib/api";
import { transcribe } from "@/lib/groq/client";
import { LANGUAGES } from "@/lib/types";

const Body = z.object({
  /** Base64 audio, as the claim and address forms both post it. */
  audio: z.string().max(8_000_000),
  /** Whisper infers the codec from the extension, so the name matters. */
  filename: z.string().max(120).default("note.webm"),
  lang: z.enum(Object.keys(LANGUAGES) as [string, ...string[]]).optional(),
});

/** What a delivery instruction is allowed to be, in characters. */
const MAX_NOTE = 400;

export async function POST(req: Request) {
  return handler(async () => {
    await requireUser();
    const body = Body.parse(await req.json().catch(() => ({})));

    const heard = await transcribe(Buffer.from(body.audio, "base64"), body.filename);
    const text = (heard?.text ?? "").trim();

    if (!text) {
      return fail("Nothing was audible in that recording. Try again, or type it.", 422);
    }

    return {
      // Capped to the same length the order schema accepts, so a long ramble
      // is truncated here rather than rejected after the buyer has confirmed.
      text: text.slice(0, MAX_NOTE),
      truncated: text.length > MAX_NOTE,
      heardIn: heard?.language || body.lang || "en",
    };
  });
}
