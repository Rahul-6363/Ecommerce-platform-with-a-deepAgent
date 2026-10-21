/**
 * Triage: a complaint in any language becomes a typed issue plus evidence flags.
 *
 * This is one of only two places a model reads buyer prose, and its output is
 * deliberately narrow: an issue type from a closed list, a set of booleans, and
 * a translation. It does not decide eligibility, amount or deadline — those come
 * from `checkEntitlement`, which has no model in it.
 *
 * When the model is unavailable, a keyword map over eight languages (native
 * script and Latin transliteration) does the same job less well but honestly,
 * and the UI says the system is degraded.
 */
import { chatJson } from "@/lib/groq/client";
import { ISSUE_TYPES, type EvidenceFlags, type IssueType, type LangCode } from "@/lib/types";

export type TriageResult = {
  issueType: IssueType;
  confidence: number;
  lang: LangCode;
  translated: string;
  evidenceFlags: EvidenceFlags;
  /**
   * What the buyer wants more: the item working, or the money back.
   *
   * `null` means the complaint expressed no preference, in which case the
   * caller keeps whatever the buyer's profile already says. Defaulting to
   * "money" here would silently overwrite a stored preference for a fast
   * replacement, and that choice decides which remedy they are offered.
   */
  buyerPriority: "speed" | "money" | null;
  reasoning: string;
  /** True when the keyword path produced this. */
  degraded: boolean;
  /** Set when the complaint plainly carries more than one distinct issue. */
  secondaryIssue: IssueType | null;
};

const SYSTEM = `You are the triage step of a returns system for an Indian e-commerce platform.

You receive one complaint, written or spoken, in any of: English, Hindi, Kannada, Tamil, Telugu, Marathi, Bengali, Gujarati — in native script or Latin transliteration (Hinglish etc.).

Return JSON with exactly these keys:

  issue_type       one of NOT_DELIVERED, DOA, DAMAGED, WRONG_ITEM, MISSING_PART, COUNTERFEIT, NOT_AS_DESCRIBED, LATE
  secondary_issue  a second issue type if the complaint clearly contains two distinct problems, else null
  confidence       0..1, how sure you are of issue_type
  lang             ISO 639-1 code of what the buyer wrote (en, hi, kn, ta, te, mr, bn, gu)
  translated       a faithful English translation of the complaint. If already English, copy it.
  buyer_priority   "speed" if they want the item working/replaced, "money" if they want a refund. Default "money".
  evidence_flags   an object of booleans, set ONLY what the complaint actually asserts:
                     stated_fault      - they say the item is faulty or does not work
                     stated_missing    - they say something was missing from the box
                     sku_mismatch      - they say a different item/model/size arrived
                     brand_mismatch    - they say it is fake or not the advertised brand
                     listing_comparison- they say it differs from the listing description
                     no_delivery_scan  - they say it never arrived
                     late_scan         - they say it arrived late
  reasoning        one sentence, in English, on why you chose issue_type

WHAT EACH TYPE MEANS
  NOT_DELIVERED    marked delivered or overdue, buyer never received it
  DOA              arrived physically intact but dead / does not power on / does not work at all
  DAMAGED          arrived physically broken, cracked, torn, leaking, dented
  WRONG_ITEM       a different product, model, size or colour than ordered
  MISSING_PART     the main item came but an accessory or component was absent
  COUNTERFEIT      fake, duplicate, first copy, not the real brand
  NOT_AS_DESCRIBED works and is genuine but materially differs from the listing
  LATE             it did arrive, just after the promised date

RULES
- Pick exactly one issue_type as primary. If two are present, put the more serious in issue_type and the other in secondary_issue.
- "Broken and does not switch on" is DAMAGED (visible damage is the stronger, provable claim).
- "Works fine but it is the wrong size" is WRONG_ITEM, not NOT_AS_DESCRIBED.
- Do NOT set an evidence flag the complaint does not assert. Absence of a flag is information.
- Do NOT mention remedies, refunds, amounts or deadlines. You classify; a rule engine decides.`;

type Raw = {
  issue_type?: string;
  secondary_issue?: string | null;
  confidence?: number;
  lang?: string;
  translated?: string;
  buyer_priority?: string;
  evidence_flags?: Record<string, unknown>;
  reasoning?: string;
};

export async function triage(complaint: string): Promise<TriageResult> {
  const parsed = await chatJson<Raw>(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: complaint.slice(0, 3000) },
    ],
    { temperature: 0, maxTokens: 700 },
  );

  if (!parsed || !parsed.issue_type) return keywordTriage(complaint);

  const issueType = ISSUE_TYPES.includes(parsed.issue_type as IssueType)
    ? (parsed.issue_type as IssueType)
    : keywordTriage(complaint).issueType;

  const secondary =
    parsed.secondary_issue && ISSUE_TYPES.includes(parsed.secondary_issue as IssueType)
      ? (parsed.secondary_issue as IssueType)
      : null;

  const flags: EvidenceFlags = {};
  const allowed = [
    "stated_fault", "stated_missing", "sku_mismatch", "brand_mismatch",
    "listing_comparison", "no_delivery_scan", "late_scan",
  ] as const;
  for (const k of allowed) {
    if (parsed.evidence_flags?.[k] === true) (flags as Record<string, boolean>)[k] = true;
  }

  return {
    issueType,
    secondaryIssue: secondary === issueType ? null : secondary,
    confidence: clamp01(Number(parsed.confidence ?? 0.7)),
    lang: normLang(parsed.lang),
    translated: String(parsed.translated ?? complaint).slice(0, 2000),
    evidenceFlags: flags,
    buyerPriority:
      parsed.buyer_priority === "speed" ? "speed"
      : parsed.buyer_priority === "money" ? "money"
      : null,
    reasoning: String(parsed.reasoning ?? "").slice(0, 400),
    degraded: false,
  };
}

/* ────────────────────── The deterministic fallback ────────────────────── */

/**
 * Keyword triage across the eight languages, matched on word boundaries so
 * "no" inside "note" does not fire. Ordered by specificity: a counterfeit
 * allegation outranks a generic damage word.
 */
const PATTERNS: { issue: IssueType; weight: number; words: string[] }[] = [
  {
    issue: "COUNTERFEIT", weight: 3,
    words: ["fake", "duplicate", "counterfeit", "first copy", "firstcopy", "nakli", "naqli", "duplicat",
      "नकली", "डुप्लिकेट", "ನಕಲಿ", "போலி", "నకిలీ", "নকল", "નકલી"],
  },
  {
    issue: "NOT_DELIVERED", weight: 3,
    words: ["not delivered", "never arrived", "not received", "nahi mila", "nahi aaya", "nahin aaya",
      "not reached", "no parcel", "missing parcel", "didnt arrive", "did not arrive", "not come",
      "नहीं मिला", "नहीं आया", "ಬಂದಿಲ್ಲ", "ಸಿಕ್ಕಿಲ್ಲ", "வரவில்லை", "கிடைக்கவில்லை", "రాలేదు", "আসেনি", "નથી આવ્યું"],
  },
  {
    issue: "DAMAGED", weight: 2,
    words: ["damaged", "damage", "broken", "break", "cracked", "crack", "torn", "tear", "dented", "dent",
      "leaking", "leak", "scratch", "scratched", "smashed", "shattered", "toota", "tuta", "tut gaya", "kharab",
      "टूटा", "टूट गया", "खराब", "ಮುರಿದ", "ಒಡೆದ", "உடைந்த", "விரிசல்", "పగిలిన", "ভাঙ্গা", "તૂટેલું"],
  },
  {
    issue: "DOA", weight: 2,
    words: ["not working", "doesnt work", "does not work", "dead", "wont turn on", "will not turn on",
      "not switching on", "not turning on", "no power", "defective", "faulty", "chalu nahi", "chal nahi raha",
      "kaam nahi", "on nahi ho raha",
      "काम नहीं", "चालू नहीं", "ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ", "ಆನ್ ಆಗುತ್ತಿಲ್ಲ", "வேலை செய்யவில்லை", "ఆన్ కావడం లేదు", "কাজ করছে না", "કામ કરતું નથી"],
  },
  {
    issue: "WRONG_ITEM", weight: 2,
    words: ["wrong item", "wrong product", "wrong size", "wrong colour", "wrong color", "wrong model",
      "different item", "different product", "not what i ordered", "galat", "dusra", "doosra saman",
      "alag item", "size galat",
      "गलत", "दूसरा", "ಬೇರೆ", "ತಪ್ಪು", "தவறான", "வேறு", "తప్పు", "ভুল", "ખોટું"],
  },
  {
    issue: "MISSING_PART", weight: 2,
    words: ["missing", "not in the box", "no charger", "without charger", "no cable", "no adapter",
      "accessory missing", "part missing", "incomplete", "nahi tha box me", "gayab",
      "गायब", "नहीं था", "ಇಲ್ಲ ಬಾಕ್ಸ್", "ಕಾಣೆ", "இல்லை", "காணவில்லை", "లేదు", "নেই", "ગુમ"],
  },
  {
    issue: "LATE", weight: 2,
    // "after the promised date" carries no "late" token, and it is how people
    // actually phrase this. A keyword list is only as good as its phrasing.
    words: ["late", "lately", "delayed", "delay", "too long", "still waiting", "der se",
      "late aaya", "deri", "after the promised", "past the promised", "overdue",
      "days after the promised", "behind schedule", "took too long",
      "देर", "लेट", "ತಡವಾಗಿ", "ತಡ", "தாமதம்", "ఆలస్యం", "দেরি", "મોડું"],
  },
  {
    issue: "NOT_AS_DESCRIBED", weight: 1,
    words: ["not as described", "different from listing", "photo different", "looks different",
      "quality poor", "poor quality", "cheap quality", "misleading", "picture me alag",
      "जैसा दिखाया", "अलग दिख", "ಬೇರೆ ಕಾಣುತ್ತದೆ", "படத்தில் வேறு", "ভিন্ন দেখাচ্ছে"],
  },
];

const FLAG_FOR: Record<IssueType, keyof EvidenceFlags | null> = {
  DOA: "stated_fault",
  DAMAGED: null,
  MISSING_PART: "stated_missing",
  WRONG_ITEM: "sku_mismatch",
  COUNTERFEIT: "brand_mismatch",
  NOT_AS_DESCRIBED: "listing_comparison",
  NOT_DELIVERED: "no_delivery_scan",
  LATE: "late_scan",
};

export function keywordTriage(complaint: string): TriageResult {
  const text = ` ${complaint.toLowerCase().replace(/[.,!?;:()"']/g, " ")} `;

  const scores = new Map<IssueType, number>();
  for (const p of PATTERNS) {
    for (const w of p.words) {
      const needle = w.toLowerCase();
      // Word-boundary match for Latin script; substring for Indic script,
      // which does not use spaces the same way.
      const hit = /^[\x20-\x7e]+$/.test(needle)
        ? new RegExp(`(^|[^a-z])${escapeRe(needle)}([^a-z]|$)`, "i").test(text)
        : text.includes(needle);
      if (hit) scores.set(p.issue, (scores.get(p.issue) ?? 0) + p.weight);
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const matched = ranked.length > 0;

  // With no keyword match this is a guess, not a classification. DAMAGED is
  // the least-harmful placeholder because it is the most provable by photo,
  // but the confidence below stays under the acting threshold so the case
  // routes to a person rather than being decided on a guess.
  const issueType = ranked[0]?.[0] ?? "DAMAGED";
  const secondary = ranked[1]?.[0] ?? null;

  const flags: EvidenceFlags = {};
  // Only assert an evidence flag for an issue we actually recognised. Setting
  // one for a guessed issue manufactures corroboration the buyer never gave,
  // and the entitlement engine would read it as the required evidence.
  if (matched) {
    const f = FLAG_FOR[issueType];
    if (f) (flags as Record<string, boolean>)[f] = true;
  }

  // Confidence is honestly low here: this is a keyword map, not comprehension.
  const confidence = ranked.length === 0 ? 0.3 : Math.min(0.65, 0.4 + ranked[0][1] * 0.08);

  // Only claim a preference when the buyer voiced one. Otherwise return null
  // and let their stored profile stand — this choice decides which remedy
  // they are offered, so guessing it is worse than deferring.
  const wantsReplacement =
    /replace|replacement|exchange|swap|badal|badl|nayi|naya|बदल|ಬದಲಿ|மாற்ற|બદલી/i.test(complaint);
  const wantsMoney =
    /refund|money back|my money|paisa|paise|वापस|पैसा|ಹಣ|ಮರುಪಾವತಿ|பணம்|પૈસા/i.test(complaint);

  return {
    issueType,
    secondaryIssue: secondary,
    confidence: Math.round(confidence * 100) / 100,
    lang: detectScript(complaint),
    translated: complaint.slice(0, 2000),
    evidenceFlags: flags,
    buyerPriority: wantsReplacement ? "speed" : wantsMoney ? "money" : null,
    reasoning:
      ranked.length === 0
        ? "no keyword matched; defaulted to DAMAGED and flagged low confidence for human review"
        : `keyword path matched ${issueType} (score ${ranked[0][1]})`,
    degraded: true,
  };
}

/** Which script was used — enough to pick a reply language without a model. */
export function detectScript(s: string): LangCode {
  if (/[ऀ-ॿ]/.test(s)) return /[ळऱ]/.test(s) ? "mr" : "hi";
  if (/[ಀ-೿]/.test(s)) return "kn";
  if (/[஀-௿]/.test(s)) return "ta";
  if (/[ఀ-౿]/.test(s)) return "te";
  if (/[ঀ-৿]/.test(s)) return "bn";
  if (/[઀-૿]/.test(s)) return "gu";
  return "en";
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

function normLang(l?: string): LangCode {
  const ok: LangCode[] = ["en", "hi", "kn", "ta", "te", "mr", "bn", "gu"];
  const k = (l ?? "en").toLowerCase().slice(0, 2) as LangCode;
  return ok.includes(k) ? k : "en";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
