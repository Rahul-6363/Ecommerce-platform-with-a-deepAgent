/**
 * What the agent says out loud, at each stage.
 *
 * PURE FUNCTIONS. Every line is built from engine output that is already on
 * screen, so the spoken version can never claim something the page does not.
 * No model writes these: a language model asked to "summarise the result"
 * would eventually say a number nobody computed, and a wrong price spoken
 * aloud is worse than a wrong price written down — nobody can re-read it.
 *
 * The brief for every line here: **what a buyer needs to hear, and nothing
 * else.** A spoken sentence cannot be skimmed, so it has a much lower budget
 * than the screen. One or two sentences, the decision first, then the single
 * most useful caveat.
 */
import type { SolveResult, SolvedOffer } from "@/lib/engines/constraints";
import { isoDay } from "@/lib/engines/offers";

/**
 * Rupees, spoken the way they are said rather than written.
 *
 * Deliberately NOT grouped: "2,499" is read with a pause at the comma, which
 * turns one number into two. The digits run together and the voice says
 * "two thousand four hundred and ninety nine".
 */
function rupees(n: number): string {
  return `${Math.trunc(n)} rupees`;
}

/** A date said as "24 October" rather than read as digits. */
function spokenDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "long" });
}

/**
 * The result of a search, spoken.
 *
 * Leads with the count because that is the one thing that changes what the
 * buyer does next: one result means read it, twelve means narrow it, none
 * means relax something. Then the recommendation and the single rejection
 * reason that mattered most — not the whole tally, which is a table and reads
 * as noise aloud.
 */
export function narrateResult(result: SolveResult): string {
  if (result.satisfied.length === 0) {
    const relax = result.relaxation;
    if (relax) {
      return (
        `Nothing matches all of that. If you drop ${spokenConstraint(relax.constraint)}, ` +
        `${relax.wouldAdmit} ${relax.wouldAdmit === 1 ? "option opens" : "options open"} up.`
      );
    }
    return "Nothing in the catalogue matches that. Try describing it differently.";
  }

  const top = result.satisfied[0];
  const c = top.candidate;
  const n = result.satisfied.length;

  // The count, framed by what the buyer should do with it.
  //
  // With no hard constraints the buyer described a need rather than stating
  // conditions, and claiming their conditions were "satisfied" is both wrong
  // and faintly odd to hear — there were none.
  const stated = result.constraints.length > 0;
  const lead = result.needUnmatched
    ? // Nothing matched the thing they asked for. Saying so is the whole
      // message; a spoken "satisfies everything you asked for" over an
      // unrelated product cannot be taken back or re-read.
      //
      // When a constraint is what hid it, the way out is spoken too: someone
      // listening cannot see the chip they would need to remove.
      `I could not find that.` +
      (result.relaxation
        ? ` If you drop ${spokenConstraint(result.relaxation.constraint)}, ` +
          `${result.relaxation.wouldAdmit} more ${result.relaxation.wouldAdmit === 1 ? "option opens" : "options open"} up.`
        : ` Here ${n === 1 ? "is one other option" : `are ${n} other options`} in case they help.`)
    : stated
      ? n === 1
        ? "One option satisfies everything you asked for."
        : `${n} options satisfy everything you asked for.`
      : n === 1
        ? "I found one good match."
        : `I found ${n} good matches.`;

  const pick =
    `The best is ${c.title} from ${c.seller.name}, ` +
    `${rupees(top.cost.expectedTotalInr)} all in` +
    (top.cost.returnRiskInr > 0
      ? `, including this seller's ${c.seller.defectRatePct} percent failure rate`
      : "") +
    ".";

  const when = top.forecast.deadline
    ? deadlineSentence(top)
    : `Likely ${spokenDate(top.forecast.likelyAt)}.`;

  // One rejection reason, the commonest. The full tally belongs on screen.
  const rejected =
    result.rejectionSummary.length > 0 && result.rejected.length > 0
      ? ` ${result.rejected.length} ${result.rejected.length === 1 ? "other was" : "others were"} ` +
        `rejected, mostly because ${spokenRejection(result.rejectionSummary[0])}.`
      : "";

  return `${lead} ${pick} ${when}${rejected}`;
}

/** The delivery verdict, which is the part people most want spoken. */
function deadlineSentence(o: SolvedOffer): string {
  const d = o.forecast.deadline;
  if (!d) return "";
  if (d.verdict === "SAFE") {
    return `It arrives by ${spokenDate(o.forecast.confidentAt)}, comfortably before your date.`;
  }
  if (d.verdict === "TIGHT") {
    return (
      `It will probably arrive ${spokenDate(o.forecast.likelyAt)}, but I am only confident ` +
      `by ${spokenDate(o.forecast.confidentAt)}, so that date is tight.`
    );
  }
  return `It cannot reach you by ${spokenDate(d.at)}.`;
}

/**
 * What was added to the cart, spoken, plus the fact that nothing was ordered.
 *
 * That last clause is the point of the whole message. A buyer who hears "added
 * to your cart" and nothing else may reasonably assume money has moved.
 */
export function narrateAccepted(input: {
  title: string;
  seller: string;
  payableNowInr: number;
  expectedTotalInr: number;
  confidentAt: string;
  satisfiedCount: number;
}): string {
  const extra =
    input.expectedTotalInr > input.payableNowInr
      ? ` ${rupees(input.expectedTotalInr)} once the risk of a return is counted.`
      : "";

  return (
    `I have put the ${input.title} from ${input.seller} in your cart — ` +
    `${rupees(input.payableNowInr)} at checkout.${extra} ` +
    `Expected by ${spokenDate(input.confidentAt)}. ` +
    `Nothing is ordered yet. Press place order when you are ready.`
  );
}

/**
 * A claim decision, spoken.
 *
 * The outcome first, then the money, then when it lands. A rejection says why
 * in the same breath, because an unexplained no is the thing people escalate.
 */
export function narrateDecision(input: {
  approved: boolean;
  remedy: string;
  amountInr: number;
  expectedBy?: string | null;
  method?: string;
  reason?: string;
}): string {
  const remedy = input.remedy.replace(/_/g, " ").toLowerCase();

  if (!input.approved) {
    return (
      `Your claim was not approved.${input.reason ? ` ${input.reason}` : ""} ` +
      `If you disagree, reply and a person will look at it again.`
    );
  }

  if (input.amountInr <= 0) {
    return `Approved — a ${remedy} is on its way. No payment is involved.`;
  }

  const where =
    input.method === "STORE_CREDIT"
      ? "as store credit, available now"
      : input.method === "BANK_TRANSFER"
        ? "to your bank account, because this order was cash on delivery"
        : "to the way you paid";

  const when = input.expectedBy ? ` You should have it by ${spokenDate(input.expectedBy)}.` : "";

  return `Approved. ${rupees(input.amountInr)} is coming back to you ${where}.${when}`;
}

/** An order placed, spoken. Short on purpose — the work is done. */
export function narrateOrderPlaced(input: {
  orderNo: string;
  amountInr: number;
  riskBand: string;
  promisedBy?: string | null;
}): string {
  const risk =
    input.riskBand === "HIGH"
      ? " This delivery looks risky, so I will watch it closely."
      : "";
  const when = input.promisedBy ? ` Expected by ${spokenDate(input.promisedBy)}.` : "";
  return `Order placed for ${rupees(input.amountInr)}.${when}${risk}`;
}

/* ─────────────────────────── Phrasing helpers ─────────────────────────── */

/**
 * A constraint, said rather than written.
 *
 * The on-screen text is deliberately precise ("price at or under ₹2,000").
 * Spoken, that is stilted — "the two thousand rupee budget" is the same fact
 * in the register a person would use.
 */
function spokenConstraint(text: string): string {
  return text
    .replace(/^price at or under /, "the ")
    .replace(/^true cost at or under /, "the all-in budget of ")
    .replace(/^arrives by /, "the delivery date of ")
    .replace(/^rated (.+) or better/, "the $1 rating")
    .replace(/^seller defect rate at or under (.+)/, "the $1 seller quality limit")
    .replace(/^category is /, "the ")
    .replace(/₹\s?([\d,]+)/g, (_m, n: string) => `${n.replace(/,/g, "")} rupee`)
    .replace(/★/g, " star");
}

/**
 * An attribute constraint, said rather than written.
 *
 * On screen it is a predicate — "induction is yes", "capacity (l) is 5" —
 * which reads correctly in a checklist and absurdly in a sentence. Spoken, it
 * has to become the thing itself: "an induction base", "a 5 litre capacity".
 */
function spokenAttribute(text: string): string {
  const m = text.match(/^(.+?) is (.+)$/);
  if (!m) return text;
  const key = m[1].replace(/\s*\(([a-z]+)\)\s*/gi, " $1 ").replace(/\s+/g, " ").trim();
  const value = m[2].trim();

  // A boolean reads as the feature itself: "induction is yes" -> "induction".
  if (value === "yes") return key;
  if (value === "no") return `no ${key}`;
  // A measurement reads value-first: "capacity l is 5" -> "a 5 l capacity".
  return `a ${value} ${key}`;
}

/** The commonest rejection, in one spoken clause. */
function spokenRejection(summary: { kind: string; constraint: string; count: number }): string {
  switch (summary.kind) {
    case "category": return "they were the wrong kind of product";
    case "max_price":
    case "max_true_cost": return "they cost too much";
    case "min_price": return "they were below your price floor";
    case "brand": return "they were a different brand";
    case "min_rating": return "they were not rated highly enough";
    case "in_stock": return "they were out of stock";
    case "attribute": return `they did not have ${spokenAttribute(summary.constraint)}`;
    case "arrive_by": return "they arrive too late";
    case "payment_mode": return "they do not take cash on delivery";
    case "max_seller_defect_rate": return "the seller fails too many orders";
    default: return `they failed ${spokenConstraint(summary.constraint)}`;
  }
}

/**
 * The line spoken when a buyer arrives somewhere, before they have typed
 * anything.
 *
 * These are deliberately questions. A greeting that states ("Welcome to
 * Vaanijya") is decoration and wastes a second of someone's attention; a
 * greeting that asks tells them what this page wants from them, which is the
 * one thing a first-time visitor does not know.
 *
 * Short on purpose, and not only for quota: a spoken line the listener cannot
 * interrupt is a cost imposed on them, so it stays near a single breath.
 *
 * The first name alone, never the full name — "Hi Arjun" is a greeting,
 * "Hi Arjun Mehta" is a bank calling about your loan.
 */
/**
 * What the agent says once a complaint has been assessed but not yet approved.
 *
 * Distinct from `narrateDecision`, which states a settled outcome. Here the
 * assessment exists and a person has not signed it off, and the difference
 * matters more aloud than on screen: a spoken "approved" cannot be qualified
 * by a badge next to it, so the pending state has to be in the sentence.
 *
 * It leads with the amount, because that is the only thing the buyer is
 * listening for, then names the one condition on it.
 */
export function narrateAssessment(input: {
  claimNo: string;
  eligible: boolean;
  remedy: string;
  amountInr: number;
  handoff: boolean;
  issueType?: string;
}): string {
  const remedy = input.remedy.replace(/_/g, " ").toLowerCase();

  if (input.handoff) {
    // Never spoken as a rejection. The evidence was inconclusive, which is a
    // statement about our confidence, not about the buyer's honesty.
    return (
      `Thank you — ${input.claimNo} is filed. The evidence was not clear enough ` +
      `for me to decide, so a person is reviewing it. You will hear back either way.`
    );
  }

  if (!input.eligible) {
    return (
      `${input.claimNo} is filed. Going by the policy I do not think this one ` +
      `qualifies, but I have sent it to a person rather than refusing it myself.`
    );
  }

  const money = input.amountInr > 0 ? `${rupees(input.amountInr)} as a ${remedy}` : `a ${remedy}`;
  return (
    `${input.claimNo} is filed. You are owed ${money}. ` +
    `It needs one approval before the money moves, and then it is on its way.`
  );
}

export type GreetingStage = "shop" | "find" | "complaint" | "orders";

export function narrateGreeting(stage: GreetingStage, name?: string): string {
  // A missing or unhelpful name degrades to no name rather than to "Hi there,"
  // which reads as a mail merge that failed.
  const first = firstName(name);
  const hi = first ? `Hi ${first}` : "Hi";

  switch (stage) {
    case "shop":
      return `${hi}, what are you shopping for today?`;
    case "find":
      // Said where a buyer states a need rather than a product name, so the
      // greeting has to signal that plain speech is accepted here.
      return `${hi}. What do you need? Describe it however you like.`;
    case "complaint":
      // No name here. Someone whose parcel arrived broken is not being
      // welcomed, and a cheerful first name reads as indifference.
      return "What went wrong with your order? Tell me in your own words.";
    case "orders":
      return `${hi}. Here are your orders. Ask me about any of them.`;
  }
}

/**
 * The usable first name, or nothing.
 *
 * Returns empty for a name that would sound wrong spoken: an email address, a
 * single letter, or anything with a digit in it — seeded and test accounts are
 * full of these, and "Hi user2" is worse than "Hi".
 */
function firstName(name?: string): string {
  const raw = (name ?? "").trim();
  if (!raw || raw.includes("@") || /\d/.test(raw)) return "";
  const first = raw.split(/\s+/)[0].replace(/[^\p{L}\p{M}'-]/gu, "");
  return first.length >= 2 ? first : "";
}

export { rupees, spokenDate, spokenConstraint, spokenAttribute, spokenRejection, isoDay, firstName };
