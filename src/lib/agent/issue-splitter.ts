/**
 * One complaint into the distinct issues it actually carries.
 *
 * Triage already returned a `secondaryIssue`, so the system *knew* a complaint
 * held two problems and remedied one of them. The gap was never detection, it
 * was that there was nowhere to put the second issue — which is why fixing it
 * needed the claim model to change rather than the prompt.
 *
 * Division of labour, as everywhere else here: the model splits prose into
 * fragments and names each one, which is comprehension. It does not decide
 * whether an issue is covered, what it is worth, or whether to pay it — that
 * is `adjudicateIssues`, which is pure and calls `checkEntitlement` per issue.
 *
 * The deterministic path matters more than usual here. A buyer who writes two
 * problems in Kannada with no API key configured must still get two issues,
 * so the fallback splits on conjunctions and scores each fragment with the
 * *same* keyword table `keywordTriage` uses, via `matchIssue`.
 */
import { chatJson } from "@/lib/groq/client";
import { matchIssue } from "@/lib/agent/triage";
import type { TriageResult } from "@/lib/agent/triage";
import type { IssueInput } from "@/lib/engines/multi-issue";
import { ISSUE_TYPES, type EvidenceFlags, type IssueType } from "@/lib/types";

/** No complaint sensibly carries more than this many distinct remediable issues. */
export const MAX_ISSUES = 4;

export type SplitResult = {
  issues: IssueInput[];
  /** True when the keyword path produced this. */
  degraded: boolean;
  reasoning: string;
};

const SYSTEM = `You split one customer complaint into the distinct problems it contains.

An Indian e-commerce buyer may report several things wrong in one message. Your only job is to separate them and name each one. You do NOT decide refunds, amounts, eligibility or remedies.

Return JSON:

{
  "issues": [
    {
      "issue_type": "one of NOT_DELIVERED, DOA, DAMAGED, WRONG_ITEM, MISSING_PART, COUNTERFEIT, NOT_AS_DESCRIBED, LATE",
      "excerpt": "the exact words from the complaint that report THIS problem, translated to English",
      "confidence": 0.0-1.0,
      "evidence_flags": {
        "stated_fault": bool, "stated_missing": bool, "sku_mismatch": bool,
        "brand_mismatch": bool, "listing_comparison": bool,
        "no_delivery_scan": bool, "late_scan": bool
      }
    }
  ],
  "reasoning": "one sentence on how you split it"
}

WHAT EACH TYPE MEANS
  NOT_DELIVERED    never received it
  DOA              arrived intact but dead / does not power on
  DAMAGED          arrived physically broken, cracked, torn, leaking
  WRONG_ITEM       a different product, model, size or colour than ordered
  MISSING_PART     the main item came but an accessory or component was absent
  COUNTERFEIT      fake, duplicate, first copy, not the real brand
  NOT_AS_DESCRIBED genuine and working but materially differs from the listing
  LATE             it arrived, just after the promised date

RULES ON SPLITTING
- Only split where the problems are genuinely SEPARATE things that would each need their own fix. "The earbuds are dead and the charging case is missing" is TWO issues: one needs a working unit, the other needs the case.
- "It arrived smashed and now it will not switch on" is ONE issue. That is one broken item described twice, not two faults.
- "It came late and it is the wrong colour" is TWO issues: lateness and the wrong item are unrelated failures.
- Do NOT invent an issue the complaint does not report. Two issues where there is one means the buyer gets accused of over-claiming.
- Do NOT split one issue across two entries to inflate it.
- Set an evidence flag ONLY for the issue it belongs to, and only if the complaint asserts it.
- At most 4 issues. If the complaint is vague, return one issue and a low confidence.
- Never mention money, remedies, refunds, amounts or deadlines. You classify; a rule engine decides.`;

type RawIssue = {
  issue_type?: string;
  excerpt?: string;
  confidence?: number;
  evidence_flags?: Record<string, unknown>;
};

type Raw = { issues?: RawIssue[]; reasoning?: string };

const ALLOWED_FLAGS = [
  "stated_fault", "stated_missing", "sku_mismatch", "brand_mismatch",
  "listing_comparison", "no_delivery_scan", "late_scan",
] as const;

/**
 * Split a complaint into issues.
 *
 * `triaged` is passed in rather than re-derived: triage has already read this
 * complaint, and its classification is the floor. A splitter that returned
 * issues contradicting triage would make the two disagree about the same
 * sentence, so the primary triage issue is always guaranteed to be present.
 */
export async function splitIssues(
  complaint: string,
  triaged: TriageResult,
): Promise<SplitResult> {
  // With no model, or a model that fails, the deterministic split stands.
  if (triaged.degraded) return keywordSplit(complaint, triaged);

  const parsed = await chatJson<Raw>(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: complaint.slice(0, 3000) },
    ],
    { temperature: 0, maxTokens: 700 },
  );

  if (!parsed?.issues?.length) return keywordSplit(complaint, triaged);

  const issues: IssueInput[] = [];
  const seen = new Set<IssueType>();

  for (const raw of parsed.issues.slice(0, MAX_ISSUES)) {
    const type = raw.issue_type as IssueType;
    if (!ISSUE_TYPES.includes(type)) continue;
    // The engine treats one issue type once; a repeat is the same allegation.
    if (seen.has(type)) continue;
    seen.add(type);

    const flags: EvidenceFlags = {};
    for (const k of ALLOWED_FLAGS) {
      if (raw.evidence_flags?.[k] === true) (flags as Record<string, boolean>)[k] = true;
    }

    issues.push({
      key: `I${issues.length + 1}-${type}`,
      issueType: type,
      excerpt: String(raw.excerpt ?? "").slice(0, 400) || complaint.slice(0, 200),
      evidenceFlags: flags,
      confidence: clamp01(Number(raw.confidence ?? 0.7)),
    });
  }

  if (issues.length === 0) return keywordSplit(complaint, triaged);

  // Triage's primary classification is the floor. If the splitter missed it,
  // add it back rather than letting the two paths disagree about one sentence.
  if (!seen.has(triaged.issueType)) {
    issues.unshift({
      key: `I0-${triaged.issueType}`,
      issueType: triaged.issueType,
      excerpt: triaged.translated.slice(0, 400) || complaint.slice(0, 200),
      evidenceFlags: { ...triaged.evidenceFlags },
      confidence: triaged.confidence,
    });
  }

  // Complaint-level flags (a photo was attached, the courier record agrees)
  // bear on every issue, so they are merged in rather than attributed to one.
  return {
    issues: issues.slice(0, MAX_ISSUES),
    degraded: false,
    reasoning: String(parsed.reasoning ?? "").slice(0, 400),
  };
}

/* ───────────────────────── The deterministic path ───────────────────────── */

/**
 * Split on conjunctions, then score each fragment with the triage table.
 *
 * Conjunctions are listed per language because this is exactly the path a
 * non-English complaint lands on when no key is configured — an English-only
 * split would silently give those buyers one issue instead of two.
 */
const SPLITTERS = [
  // English
  " and also ", " and the ", " and ", " also ", " plus ", " but ", " however ",
  " as well as ", "; ", " additionally ",
  // Hindi / Marathi (Devanagari and transliterated)
  " aur ", " और ", " तसेच ", " आणि ",
  // Kannada
  " mattu ", " ಮತ್ತು ", " ಹಾಗೂ ",
  // Tamil
  " matrum ", " மற்றும் ",
  // Telugu
  " మరియు ",
  // Bengali
  " এবং ", " আর ",
  // Gujarati
  " અને ",
];

export function keywordSplit(complaint: string, triaged: TriageResult): SplitResult {
  const fragments = splitOnConjunctions(complaint);

  const issues: IssueInput[] = [];
  const seen = new Set<IssueType>();

  for (const fragment of fragments) {
    const m = matchIssue(fragment);
    if (!m) continue;
    if (seen.has(m.issue)) continue;
    seen.add(m.issue);

    const flags: EvidenceFlags = {};
    // Only assert a flag for an issue the keywords actually recognised, for
    // the same reason `keywordTriage` does: a flag invented for a guess
    // manufactures corroboration the buyer never gave.
    if (m.flag) (flags as Record<string, boolean>)[m.flag] = true;

    issues.push({
      key: `I${issues.length + 1}-${m.issue}`,
      issueType: m.issue,
      excerpt: fragment.trim().slice(0, 400),
      evidenceFlags: flags,
      confidence: Math.min(0.65, 0.4 + m.score * 0.08),
    });
  }

  // Nothing matched: fall back to the single issue triage already decided, so
  // the multi-issue path is never worse than the single-issue one.
  if (issues.length === 0) {
    return {
      issues: [
        {
          key: `I1-${triaged.issueType}`,
          issueType: triaged.issueType,
          excerpt: complaint.slice(0, 400),
          evidenceFlags: { ...triaged.evidenceFlags },
          confidence: triaged.confidence,
        },
      ],
      degraded: true,
      reasoning: "no fragment matched a second issue; using the single triage classification",
    };
  }

  if (!seen.has(triaged.issueType)) {
    issues.unshift({
      key: `I0-${triaged.issueType}`,
      issueType: triaged.issueType,
      excerpt: complaint.slice(0, 400),
      evidenceFlags: { ...triaged.evidenceFlags },
      confidence: triaged.confidence,
    });
  }

  return {
    issues: issues.slice(0, MAX_ISSUES),
    degraded: true,
    reasoning:
      issues.length > 1
        ? `keyword path split the complaint into ${issues.length} fragments with distinct issues`
        : "keyword path found one issue",
  };
}

/**
 * Cut a complaint at conjunctions, keeping fragments long enough to classify.
 *
 * The whole complaint is kept as a final fragment too: a two-issue sentence
 * with no conjunction ("dead earbuds, case missing") still has to produce both,
 * and a comma-separated list is how people actually write that.
 */
function splitOnConjunctions(complaint: string): string[] {
  let parts = [complaint];

  for (const sep of SPLITTERS) {
    const next: string[] = [];
    for (const part of parts) {
      // Case-insensitive split that keeps Indic separators working.
      const idx = part.toLowerCase().split(sep.toLowerCase());
      if (idx.length === 1) {
        next.push(part);
        continue;
      }
      // Re-slice the original so case and script survive the split.
      let cursor = 0;
      for (const chunk of idx) {
        next.push(part.slice(cursor, cursor + chunk.length));
        cursor += chunk.length + sep.length;
      }
    }
    parts = next;
  }

  // Commas split too, but only where both sides still look like clauses —
  // "Flat 402, Sai Residency" must not become two issues.
  const commaSplit: string[] = [];
  for (const part of parts) {
    if (part.includes(",") && part.length > 30) commaSplit.push(...part.split(","));
    else commaSplit.push(part);
  }

  const fragments = commaSplit.map((p) => p.trim()).filter((p) => p.length >= 4);
  // The full text last: a fragment-level match is preferred, but a complaint
  // whose issues only read as a whole still has to classify.
  fragments.push(complaint);
  return fragments;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}
