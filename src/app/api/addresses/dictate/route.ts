/**
 * POST /api/addresses/dictate — one spoken sentence into a filled-in form.
 *
 * Deliberately does **not** save. It parses, says what it understood, and
 * hands that back for the buyer to confirm. A misheard pincode is the one
 * input error nothing downstream can catch — the forecast and the risk score
 * will both be confidently wrong about a parcel going to the wrong city — so
 * the confirmation step is the feature, not friction to be optimised away.
 *
 * Takes either `sentence` (already transcribed, or typed) or `audio` (base64,
 * transcribed here through the same Whisper path the complaint form uses), so
 * a buyer can dictate without touching the form at all.
 */
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { handler, fail } from "@/lib/api";
import { extractAddress } from "@/lib/agent/address-extractor";
import { addressAdvice, formatAddress, spokenAddress } from "@/lib/addresses";
import { pinFacts } from "@/lib/engines/pincode";
import { transcribe } from "@/lib/groq/client";
import { emit } from "@/lib/events";
import { LANGUAGES } from "@/lib/types";

const Body = z
  .object({
    sentence: z.string().max(600).optional(),
    /** Base64 audio, as the claim form posts it. */
    audio: z.string().max(8_000_000).optional(),
    /** Whisper infers the codec from the extension, so the name matters. */
    filename: z.string().max(120).default("address.webm"),
    lang: z.enum(Object.keys(LANGUAGES) as [string, ...string[]]).optional(),
  })
  .refine((b) => (b.sentence ?? "").trim() || b.audio, {
    message: "Say or type the address first.",
  });

export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const body = Body.parse(await req.json().catch(() => ({})));

    let sentence = (body.sentence ?? "").trim();
    let heardIn = body.lang ?? "en";

    if (!sentence && body.audio) {
      // Whisper detects the language itself, as it does for a spoken
      // complaint; `lang` only names the voice we answer in.
      const heard = await transcribe(Buffer.from(body.audio, "base64"), body.filename);
      if (!heard?.text?.trim()) {
        return fail("That recording could not be understood. Try again, or type it.", 422);
      }
      sentence = heard.text.trim();
      heardIn = heard.language || heardIn;
    }

    const address = await extractAddress(sentence);
    const facts = pinFacts(address.pincode);
    const advice = addressAdvice(address);

    await emit({
      type: "address.dictated",
      actor: address.source === "model" ? "AddressAgent" : "AddressParser",
      userId: String(user._id),
      summary:
        `Read a dictated address` +
        (facts.city ? ` in ${facts.city}` : "") +
        (address.missing.length ? ` — still needs ${address.missing.join(", ")}` : ""),
      // The sentence is kept because a wrong parse is only debuggable against
      // what was actually said.
      payload: { sentence, heardIn, source: address.source, missing: address.missing },
    });

    return {
      heard: sentence,
      heardIn,
      address,
      facts,
      advice,
      oneLine: formatAddress(address),
      /**
       * What the agent says back.
       *
       * Ends in a question, because the buyer has to answer it before anything
       * is saved — and a statement invites them to assume it was saved.
       */
      spoken: address.missing.length
        ? `I got ${spokenAddress(address) || "very little of that"}. ` +
          `I still need the ${spokenMissing(address.missing)}.`
        : `I have ${spokenAddress(address)}. Shall I save it?`,
      /** True when nothing else is needed before it can be saved. */
      complete: address.missing.length === 0,
    };
  });
}

/** "line and pincode" rather than "line, pincode". */
function spokenMissing(missing: string[]): string {
  const words = missing.map((m) =>
    m === "line" ? "street address" : m === "pincode" ? "pincode" : "city",
  );
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
