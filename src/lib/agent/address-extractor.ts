/**
 * One spoken sentence into a delivery address.
 *
 * "send it to flat 402, Sai Residency, 12th Cross near Axis Bank, Jayanagar,
 * Bangalore 560041" has to become five fields, and a buyer who said it out
 * loud will not say it again field by field. So this parses the whole thing
 * at once.
 *
 * Same division of labour as `constraint-extractor`: the deterministic parser
 * runs first and is enough for most addresses, because an Indian address has
 * a pincode in it and a pincode decides the city, the state and the tier. The
 * model is asked only to split the remainder into street and landmark, which
 * is the one judgement a regex is bad at — and if it is unavailable, the
 * deterministic result stands rather than the feature failing.
 *
 * Nothing here is trusted into the database unseen: the caller shows the
 * parsed address back and the buyer confirms it. A misheard pincode would
 * otherwise misroute a parcel in a way no later step can catch.
 */
import { z } from "zod";
import { chatJson } from "@/lib/groq/client";
import { pinFacts } from "@/lib/engines/pincode";

export type ParsedAddress = {
  label: string;
  line: string;
  landmark: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  /** How the fields were arrived at, shown to the buyer so they can judge it. */
  source: "model" | "rules";
  /** Fields we could not fill, so the UI can ask for exactly those. */
  missing: ("line" | "pincode" | "city")[];
};

const SYSTEM = `You turn one spoken Indian delivery address into JSON. Output JSON only.

Return: {"line":"","landmark":"","city":"","state":"","pincode":"","phone":"","label":""}

RULES
- line is the street address: flat or house number, building name, street, area.
- landmark is only what was given as a landmark — "near X", "opposite Y",
  "behind Z", "beside W". Strip the preposition: "near Axis Bank" -> "Axis Bank".
  Empty if the buyer gave none. Never invent one.
- city and state: only if stated. Leave empty otherwise — they are derived from
  the pincode, which is more reliable than a guess.
- pincode is six digits. Spoken digits may be grouped ("five six zero zero
  four one" or "560 041") — join them.
- phone is a ten-digit Indian mobile. Drop +91, 0 prefixes and spaces.
- label is "Home", "Work" or "Other" — only if the buyer said which. Else "".
- Buyers speak English, Hindi, Kannada, Tamil, Telugu, Marathi, Bengali,
  Gujarati, or Latin transliteration. Read all of them, but output the address
  in the script it was spoken in — a courier reads the label, not us.
- Never output a field the buyer did not say. An empty string is correct and
  useful; a plausible invention is not.`;

const Shape = z.object({
  line: z.string().default(""),
  landmark: z.string().default(""),
  city: z.string().default(""),
  state: z.string().default(""),
  pincode: z.string().default(""),
  phone: z.string().default(""),
  label: z.string().default(""),
});

export async function extractAddress(sentence: string): Promise<ParsedAddress> {
  const text = (sentence ?? "").trim();
  if (!text) return finish({}, "rules");

  // The deterministic pass always runs. It owns the pincode and the phone —
  // digits are exactly what a parser is better at than a model — and gives a
  // complete answer on its own if the model is unavailable.
  const rules = parseAddress(text);

  // `chatJson` returns null for every failure mode there is — no key, quota
  // exhausted, unparseable output — so one check covers them all and the
  // deterministic result stands.
  const parsed = await chatJson<Record<string, unknown>>(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Buyer said: ${text.slice(0, 600)}` },
    ],
    { temperature: 0, maxTokens: 400 },
  );

  const shaped = Shape.safeParse(parsed ?? {});
  if (!shaped.success) return rules;

  // The model splits street from landmark. It does not get to overrule the
  // parser on the pincode or the phone: those are digits the regex read
  // correctly, and a model that drops one has misrouted a parcel.
  return finish(
    {
      line: pick(shaped.data.line, rules.line),
      landmark: pick(shaped.data.landmark, rules.landmark),
      city: pick(shaped.data.city, rules.city),
      state: pick(shaped.data.state, rules.state),
      pincode: rules.pincode || digits(shaped.data.pincode).slice(0, 6),
      phone: rules.phone || normalisePhone(shaped.data.phone),
      label: pick(shaped.data.label, rules.label),
    },
    "model",
  );
}

/**
 * The address without a model.
 *
 * Carries the whole feature when Groq is unreachable, which is why it reads
 * the pincode, the phone and the landmark itself rather than leaving them for
 * the model. What it cannot do well is decide where the street ends and the
 * area begins — so it keeps them together in `line`, which is wrong-looking
 * but still deliverable.
 */
export function parseAddress(sentence: string): ParsedAddress {
  let text = ` ${(sentence ?? "").trim()} `;

  // ── Pincode ─────────────────────────────────────────────────────────────
  // Spoken digits arrive grouped ("560 041") or as words ("five six zero").
  text = wordsToDigits(text);
  let pincode = "";
  // Prefer a run of six digits; fall back to 3+3 split by a space.
  const six = text.match(/\b([1-9]\d{5})\b/);
  const split = text.match(/\b([1-9]\d{2})\s+(\d{3})\b/);
  if (six) {
    pincode = six[1];
    text = text.replace(six[0], " ");
  } else if (split) {
    pincode = `${split[1]}${split[2]}`;
    text = text.replace(split[0], " ");
  }

  // ── Phone ───────────────────────────────────────────────────────────────
  let phone = "";
  // Dictated and typed numbers both arrive grouped — "+91 98765 43210",
  // "98765-43210" — so the ten digits are matched across separators and then
  // joined, rather than requiring them to be contiguous.
  const mobile = text.match(/(?:\+?91[\s-]*)?([6-9](?:[\s-]*\d){9})(?![\s-]*\d)/);
  if (mobile) {
    const ten = mobile[1].replace(/\D/g, "");
    if (/^[6-9]\d{9}$/.test(ten)) {
      phone = ten;
      text = text.replace(mobile[0], " ");
    }
  }

  // ── Landmark ────────────────────────────────────────────────────────────
  // Taken by its preposition, which is how people actually say it. The
  // landmark runs to the next comma, because "near Axis Bank, Jayanagar"
  // means the bank is the landmark and Jayanagar is not.
  let landmark = "";
  const near = text.match(/\b(?:near|opposite|opp\.?|behind|beside|next to|above|below)\s+([^,;.]{2,60})/i);
  if (near) {
    landmark = tidy(near[1]);
    text = text.replace(near[0], " ");
  }

  // ── Label ───────────────────────────────────────────────────────────────
  // Consumed, not just read: "my office, 9 Tech Park" means the label is Work
  // and the street is "9 Tech Park". Leaving the phrase in put "my office" on
  // the courier's label.
  let label = "";
  const work = text.match(/\b(?:my\s+)?(?:office|work|workplace)\b/i);
  const home = text.match(/\b(?:my\s+)?(?:home|house|ghar)\b/i);
  if (work) {
    label = "Work";
    text = text.replace(work[0], " ");
  } else if (home) {
    label = "Home";
    text = text.replace(home[0], " ");
  }

  // ── Lead-in verbs, so "send it to" does not end up in the street ────────
  text = text.replace(
    /^\s*(?:please\s+)?(?:send|deliver|ship|courier)\s+(?:it|this|them|the\s+\w+)?\s*(?:to|at)?\s*/i,
    " ",
  );
  text = text.replace(/^\s*(?:my\s+address\s+is|address\s+is|it'?s|its)\s*/i, " ");

  // ── City and state, from the pincode where possible ─────────────────────
  const facts = pinFacts(pincode);
  let city = facts.city;
  let state = facts.state;

  // A city the buyer named explicitly wins over the derived one: they know
  // their own suburb's name and the prefix table only knows the metro.
  const spokenCity = findKnownCity(text);
  if (spokenCity) {
    city = spokenCity.city;
    state = spokenCity.state || state;
    text = text.replace(new RegExp(`\\b${escapeRe(spokenCity.matched)}\\b`, "i"), " ");
  }

  const line = tidy(text);

  return finish({ line, landmark, city, state, pincode, phone, label }, "rules");
}

/* ─────────────────────────────── Internals ─────────────────────────────── */

function finish(
  a: Partial<Omit<ParsedAddress, "source" | "missing">>,
  source: "model" | "rules",
): ParsedAddress {
  const pincode = digits(a.pincode ?? "").slice(0, 6);
  const facts = pinFacts(pincode);

  const out: ParsedAddress = {
    label: a.label || "Home",
    line: tidy(a.line ?? ""),
    landmark: tidy(a.landmark ?? ""),
    // Derived values fill in behind whatever was said, never over it.
    city: tidy(a.city ?? "") || facts.city,
    state: tidy(a.state ?? "") || facts.state,
    pincode,
    phone: normalisePhone(a.phone ?? ""),
    source,
    missing: [],
  };

  if (out.line.length < 6) out.missing.push("line");
  if (!facts.valid) out.missing.push("pincode");
  if (!out.city) out.missing.push("city");

  return out;
}

/**
 * Spoken number words into digits.
 *
 * Whisper transcribes a dictated pincode as words about as often as digits,
 * and "five six zero zero four one" has to become 560041 or the address is
 * unusable. Only applied to runs of three or more number words, so "flat two"
 * and "12th Cross" survive untouched.
 */
export function wordsToDigits(text: string): string {
  const WORDS: Record<string, string> = {
    zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9",
    // The commonest Hinglish dictation, which Whisper leaves in script.
    "शून्य": "0", "एक": "1", "दो": "2", "तीन": "3", "चार": "4",
    "पांच": "5", "पाँच": "5", "छह": "6", "सात": "7", "आठ": "8", "नौ": "9",
  };

  const keys = Object.keys(WORDS).map(escapeRe).join("|");
  // `\b` is defined against ASCII word characters, so it never fires beside
  // Devanagari and "पांच छह शून्य" went through untouched. Lookarounds for
  // "not a letter or digit" hold for every script this platform accepts.
  const run = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:(?:${keys})[\\s-]+){2,}(?:${keys})(?![\\p{L}\\p{N}])`,
    "giu",
  );

  return text.replace(run, (match) =>
    match
      .split(/[\s-]+/)
      .map((w) => WORDS[w.toLowerCase()] ?? WORDS[w] ?? "")
      .join(""),
  );
}

/**
 * Cities worth recognising by name in a spoken address.
 *
 * Only where the name adds something the pincode cannot: a suburb the prefix
 * table reads as its metro, or a city whose pincode the buyer may not know.
 * Aliases matter more than coverage — people say Bangalore, not Bengaluru.
 */
const CITY_ALIASES: [RegExp, string, string][] = [
  [/\bbangalore\b|\bbengaluru\b|\bbengluru\b/i, "Bengaluru", "Karnataka"],
  [/\bmumbai\b|\bbombay\b/i, "Mumbai", "Maharashtra"],
  [/\bdelhi\b|\bnew delhi\b/i, "New Delhi", "Delhi"],
  [/\bgurgaon\b|\bgurugram\b/i, "Gurugram", "Haryana"],
  [/\bnoida\b/i, "Noida", "Uttar Pradesh"],
  [/\bhyderabad\b|\bhyd\b/i, "Hyderabad", "Telangana"],
  [/\bchennai\b|\bmadras\b/i, "Chennai", "Tamil Nadu"],
  [/\bkolkata\b|\bcalcutta\b/i, "Kolkata", "West Bengal"],
  [/\bpune\b|\bpoona\b/i, "Pune", "Maharashtra"],
  [/\bahmedabad\b|\bamdavad\b/i, "Ahmedabad", "Gujarat"],
  [/\bmysore\b|\bmysuru\b/i, "Mysuru", "Karnataka"],
  [/\bmangalore\b|\bmangaluru\b/i, "Mangaluru", "Karnataka"],
  [/\bhubli\b|\bhubballi\b/i, "Hubballi", "Karnataka"],
  [/\bbelgaum\b|\bbelagavi\b/i, "Belagavi", "Karnataka"],
  [/\btumkur\b|\btumakuru\b/i, "Tumakuru", "Karnataka"],
  [/\bcoimbatore\b|\bkovai\b/i, "Coimbatore", "Tamil Nadu"],
  [/\bmadurai\b/i, "Madurai", "Tamil Nadu"],
  [/\btrichy\b|\btiruchirappalli\b/i, "Tiruchirappalli", "Tamil Nadu"],
  [/\bkochi\b|\bcochin\b|\bernakulam\b/i, "Kochi", "Kerala"],
  [/\btrivandrum\b|\bthiruvananthapuram\b/i, "Thiruvananthapuram", "Kerala"],
  [/\bvizag\b|\bvisakhapatnam\b/i, "Visakhapatnam", "Andhra Pradesh"],
  [/\bvijayawada\b/i, "Vijayawada", "Andhra Pradesh"],
  [/\bjaipur\b/i, "Jaipur", "Rajasthan"],
  [/\blucknow\b/i, "Lucknow", "Uttar Pradesh"],
  [/\bindore\b/i, "Indore", "Madhya Pradesh"],
  [/\bbhopal\b/i, "Bhopal", "Madhya Pradesh"],
  [/\bnagpur\b/i, "Nagpur", "Maharashtra"],
  [/\bsurat\b/i, "Surat", "Gujarat"],
  [/\bchandigarh\b/i, "Chandigarh", "Chandigarh"],
  [/\bpatna\b/i, "Patna", "Bihar"],
  [/\bguwahati\b/i, "Guwahati", "Assam"],
  [/\bbhubaneswar\b/i, "Bhubaneswar", "Odisha"],
];

function findKnownCity(text: string): { city: string; state: string; matched: string } | null {
  for (const [re, city, state] of CITY_ALIASES) {
    const m = text.match(re);
    if (m) return { city, state, matched: m[0] };
  }
  return null;
}

/** Trim, collapse whitespace, and drop the punctuation dictation leaves behind. */
function tidy(s: string): string {
  return (s ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*,+/g, ", ")
    .replace(/^[\s,;.&-]+|[\s,;.&-]+$/g, "")
    .trim();
}

function digits(s: string): string {
  return (s ?? "").replace(/\D/g, "");
}

/** A ten-digit Indian mobile, or empty. Never a half-number. */
function normalisePhone(s: string): string {
  const d = digits(s);
  const ten = d.length > 10 ? d.slice(-10) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : "";
}

function pick(preferred: string, fallback: string): string {
  return tidy(preferred) || tidy(fallback);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
