/**
 * The verifier. It only ever refuses.
 *
 * A model wrote a letter to a customer about their money. Before that letter
 * can be queued for approval, this checks it against the engine's verdict:
 *
 *  - every rupee figure in the prose must be the engine's figure
 *  - every date must be the engine's deadline
 *  - a cited clause id must exist in the policy
 *  - the remedy named in the prose must be the remedy the engine chose
 *
 * It has no model in it, so it cannot be argued with. A draft that fails is
 * binned and the caller falls back to a template built from the verdict
 * itself — which is grounded by construction.
 */
import type { Verdict } from "@/lib/types";

export type VerificationResult = {
  passed: boolean;
  notes: string[];
};

const REMEDY_WORDS: Record<string, string[]> = {
  FULL_REFUND: ["full refund", "refund"],
  PARTIAL_REFUND: ["partial refund", "part refund"],
  REPLACEMENT: ["replacement", "replace"],
  RESHIP: ["reship", "re-ship", "resend", "send again", "dispatch again"],
  PART_SHIPMENT: ["part shipment", "missing part", "accessory"],
  STORE_CREDIT: ["store credit", "credit"],
  NONE: [],
  ESCALATE_AMBIGUOUS: [],
};

export function verifyDraft(
  draft: string,
  verdict: Verdict,
  policyClauseIds: string[],
): VerificationResult {
  const notes: string[] = [];
  const text = draft ?? "";

  if (text.trim().length < 20) {
    return { passed: false, notes: ["draft is empty or too short to send"] };
  }

  /* 1. Money. Every rupee figure must be the engine's figure. */
  const amounts = [...text.matchAll(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/gi)].map((m) =>
    Math.round(Number.parseFloat(m[1].replace(/,/g, ""))),
  );
  const allowed = new Set([verdict.amountInr, 0]);
  const wrong = amounts.filter((a) => !allowed.has(a));
  if (wrong.length) {
    notes.push(
      `draft states ₹${wrong.join(", ₹")} but the engine computed ₹${verdict.amountInr} — ` +
        "a model is not permitted to restate an amount",
    );
  }
  if (verdict.amountInr > 0 && amounts.length === 0) {
    notes.push(`the remedy is worth ₹${verdict.amountInr} but the draft names no amount`);
  }

  /* 2. Dates. Every date in the prose must be one the engine itself produced.
   *
   * The deadline is the obvious one, but it is not the only legitimate date:
   * telling a buyer their return window closed on a given day is a verifiable
   * fact, and the engine states it in its own reasons. So the permitted set is
   * "the deadline, plus any date the engine wrote down" — anything else is a
   * date the model invented, which is what this check exists to catch. */
  const permittedDates = new Set<string>();
  if (verdict.deadlineAt) {
    permittedDates.add(new Date(verdict.deadlineAt).toISOString().slice(0, 10));
  }
  for (const r of verdict.reasons) {
    for (const m of r.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) permittedDates.add(m[0]);
  }

  const citedDates = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((m) => m[0]);
  const inventedDates = citedDates.filter((d) => !permittedDates.has(d));
  if (inventedDates.length) {
    notes.push(
      `draft names date(s) ${inventedDates.join(", ")}, which the engine never produced` +
        (permittedDates.size
          ? ` (it stated only ${[...permittedDates].join(", ")})`
          : " (it produced no date at all)"),
    );
  }

  /* 3. Clause citations must exist. */
  const cited = [...text.matchAll(/\b([A-Z]{2,4}-[A-Z]{2,4}-\d+(?:\.\d+)?)\b/g)].map((m) => m[1]);
  const known = new Set(policyClauseIds);
  const invented = cited.filter((c) => !known.has(c));
  if (invented.length) {
    notes.push(`draft cites clause(s) ${invented.join(", ")} which do not exist in the policy`);
  }

  /* 4. The remedy in the prose must be the remedy in the verdict. */
  const lower = text.toLowerCase();
  const expected = REMEDY_WORDS[verdict.remedy] ?? [];
  if (verdict.eligible && expected.length && !expected.some((w) => lower.includes(w))) {
    notes.push(`the engine chose ${verdict.remedy} but the draft never names it`);
  }

  // A draft must not promise a remedy the engine rejected.
  for (const [remedy, words] of Object.entries(REMEDY_WORDS)) {
    if (remedy === verdict.remedy || !words.length) continue;
    // "refund" is a substring of "partial refund", so only flag a conflicting
    // remedy when the engine picked something that is not a refund at all.
    const conflicting = words.some((w) => lower.includes(w));
    if (!conflicting) continue;
    const bothRefunds = remedy.includes("REFUND") && verdict.remedy.includes("REFUND");
    if (bothRefunds) continue;
    if (!verdict.eligible && remedy !== "NONE") {
      notes.push(`the claim was not approved but the draft mentions ${remedy.toLowerCase().replace(/_/g, " ")}`);
    }
  }

  /* 5. A rejected claim must not read like an approval. */
  if (!verdict.eligible && /\b(approved|we have approved|has been approved)\b/i.test(text)) {
    notes.push("the engine found the buyer not eligible but the draft says the claim was approved");
  }

  /* 6. Nothing may be stated as already done — everything waits for approval. */
  if (/\b(has been (?:refunded|credited|dispatched)|we have (?:refunded|credited|sent the money))\b/i.test(text)) {
    notes.push("the draft states money has already moved; nothing has been executed yet");
  }

  return { passed: notes.length === 0, notes };
}

/**
 * The template fallback. Grounded by construction: every value is substituted
 * from the verdict, so there is nothing for the verifier to catch.
 */
export function templateDraft(p: {
  buyerName: string;
  orderNo: string;
  productTitle: string;
  issueType: string;
  verdict: Verdict;
}): string {
  const { verdict } = p;
  const issue = p.issueType.replace(/_/g, " ").toLowerCase();

  if (!verdict.eligible) {
    const why = verdict.reasons.find((r) => /window|no clause|not feasible|no compensation/i.test(r));
    return [
      `Dear ${p.buyerName},`,
      "",
      `We have reviewed your report of ${issue} on order ${p.orderNo} (${p.productTitle}).`,
      "",
      `On this occasion we are not able to offer a remedy. ${why ?? verdict.reasons[0] ?? ""}`.trim(),
      verdict.clauseIds.length ? `This is governed by policy clause ${verdict.clauseIds.join(", ")}.` : "",
      "",
      "If you believe we have missed something, reply to this message and a person will review it again.",
      "",
      "Vaanijya Resolutions",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }

  const remedy = verdict.remedy.replace(/_/g, " ").toLowerCase();
  const money = verdict.amountInr > 0 ? ` of ₹${verdict.amountInr}` : "";
  const by = verdict.deadlineAt
    ? ` This will be completed by ${new Date(verdict.deadlineAt).toISOString().slice(0, 10)}.`
    : "";

  return [
    `Dear ${p.buyerName},`,
    "",
    `We have reviewed your report of ${issue} on order ${p.orderNo} (${p.productTitle}).`,
    "",
    `Your claim is eligible, and the remedy is a ${remedy}${money}.${by}`,
    verdict.clauseIds.length ? `This follows policy clause ${verdict.clauseIds.join(", ")}.` : "",
    "",
    "A platform operator is reviewing this assessment and you will be notified as soon as it is actioned.",
    "",
    "Vaanijya Resolutions",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
