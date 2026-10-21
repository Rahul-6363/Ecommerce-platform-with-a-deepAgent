/**
 * The grounding guard for shopping replies.
 *
 * The claim pipeline already has a verifier, because a model writing about
 * someone's refund cannot be trusted on its word. A model writing about
 * products has the same problem in a smaller way: it invents a product, quotes
 * a price that is not the price, or answers a policy question from memory.
 *
 * So this is the shopping-side equivalent. It does not rewrite the reply — it
 * reports what cannot be substantiated, and the caller decides whether to
 * append a correction or re-ask the model. A prompt rule is a request; this is
 * a check.
 *
 * Deliberately narrow: it flags only claims that are checkable against what
 * the tools actually returned. Ordinary conversation passes untouched.
 */

export type GroundingFacts = {
  /** Product titles the tools returned this turn. */
  titles: string[];
  /** Prices the tools returned, in rupees. */
  prices: number[];
  /**
   * Seller names the tools returned. A reply comparing offers names the
   * seller, and a seller read from a tool is as grounded as a product title —
   * without this, naming the seller that actually won the comparison is
   * reported as an invention.
   *
   * Optional: a caller that only cares about titles and prices need not
   * supply it, and the tests that predate offer comparison still compile.
   */
  sellers?: string[];
  /** True when at least one catalogue or product tool ran. */
  searched: boolean;
};

export type GroundingIssue = {
  kind: "invented_product" | "invented_price" | "unsourced_policy" | "wrong_language";
  detail: string;
};

/** Collect what the turn is allowed to assert, from the tool results. */
export function factsFromToolResults(
  calls: { name: string; ok: boolean; data?: unknown }[],
): GroundingFacts {
  const titles: string[] = [];
  const prices: number[] = [];
  const sellers: string[] = [];
  let searched = false;

  for (const c of calls) {
    if (!c.ok || !c.data) continue;
    const d = c.data as Record<string, unknown>;

    if (c.name === "search_catalogue") {
      searched = true;
      for (const r of (d.results ?? []) as Record<string, unknown>[]) {
        if (typeof r.title === "string") titles.push(r.title);
        if (typeof r.price_inr === "number") prices.push(r.price_inr);
      }
    }
    if (c.name === "get_product") {
      searched = true;
      if (typeof d.title === "string") titles.push(d.title);
      if (typeof d.price_inr === "number") prices.push(d.price_inr);
      const seller = d.seller as { name?: string } | null;
      if (seller && typeof seller.name === "string") sellers.push(seller.name);
    }
    if (c.name === "solve_constraints") {
      // The solver returns titles, a sticker price and a true cost, all read
      // from the catalogue by a pure function. Without this case every reply
      // quoting the solver's own numbers is flagged ungrounded and the buyer
      // is told not to rely on figures that are in fact the most defensible
      // ones on the page.
      searched = true;
      for (const o of (d.satisfied ?? []) as Record<string, unknown>[]) {
        if (typeof o.title === "string") titles.push(o.title);
        if (typeof o.seller === "string") sellers.push(o.seller);
        if (typeof o.sticker_inr === "number") prices.push(o.sticker_inr);
        if (typeof o.true_cost_inr === "number") prices.push(o.true_cost_inr);
      }
    }
    if (c.name === "view_cart" || c.name === "add_to_cart" || c.name === "list_my_orders") {
      // These carry titles and prices too, and quoting them back is legitimate.
      const blob = JSON.stringify(d);
      for (const m of blob.matchAll(/"title":"([^"]{3,80})"/g)) titles.push(m[1]);
      for (const m of blob.matchAll(/"(?:unit_price_inr|line_total_inr|amount_inr|price_inr)":(\d+)/g)) {
        prices.push(Number.parseInt(m[1], 10));
      }
    }
  }

  return { titles, prices, sellers, searched };
}

/** Scripts we can detect, to catch a reply in the wrong language. */
function scriptOf(s: string): "latin" | "devanagari" | "kannada" | "tamil" | "telugu" | "bengali" | "gujarati" | "mixed" {
  const has = {
    devanagari: /[ऀ-ॿ]/.test(s),
    kannada: /[ಀ-೿]/.test(s),
    tamil: /[஀-௿]/.test(s),
    telugu: /[ఀ-౿]/.test(s),
    bengali: /[ঀ-৿]/.test(s),
    gujarati: /[઀-૿]/.test(s),
  };
  const indic = Object.entries(has).filter(([, v]) => v);
  if (indic.length === 0) return "latin";
  if (indic.length > 1) return "mixed";
  return indic[0][0] as "devanagari";
}

const EXPECTED_SCRIPT: Record<string, string> = {
  en: "latin", hi: "devanagari", mr: "devanagari",
  kn: "kannada", ta: "tamil", te: "telugu", bn: "bengali", gu: "gujarati",
};

/**
 * Check a reply against the turn's facts.
 *
 * `askedLang` is what the buyer wrote in. A reply in a different script is a
 * real failure: a buyer who types English and is answered in Hindi has been
 * given something they may not read.
 */
export function checkGrounding(
  reply: string,
  facts: GroundingFacts,
  askedLang: string,
  /**
   * What the buyer wrote this turn. Echoing their own budget back ("nothing
   * under ₹500") is correct behaviour, not a fabricated price, so those
   * figures are permitted.
   */
  buyerText = "",
): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  const text = reply ?? "";
  if (!text.trim()) return issues;

  /* 1. Language. A reply the buyer cannot read is the worst failure here. */
  const want = EXPECTED_SCRIPT[askedLang] ?? "latin";
  const got = scriptOf(text);
  // Latin script inside an Indic reply is normal (brand names, transliteration),
  // so only flag the reverse: Indic script when Latin was asked for.
  if (want === "latin" && got !== "latin" && got !== "mixed") {
    issues.push({
      kind: "wrong_language",
      detail: `the buyer wrote in ${askedLang} but the reply is in ${got} script`,
    });
  }

  /* 2. Prices. Every rupee figure must be one a tool returned. */
  const quoted = [...text.matchAll(/₹\s?([\d,]{3,})/g)]
    .map((m) => Number.parseInt(m[1].replace(/,/g, ""), 10))
    .filter((n) => Number.isFinite(n));
  const allowed = new Set(facts.prices);
  // Numbers the buyer themselves named, in any common form: "500", "2,000",
  // "2k". Quoting these back is how you confirm you understood them.
  for (const m of buyerText.matchAll(/(\d[\d,]*)\s*k/gi)) {
    allowed.add(Number.parseInt(m[1].replace(/,/g, ""), 10) * 1000);
  }
  for (const m of buyerText.matchAll(/(\d[\d,]{2,})/g)) {
    allowed.add(Number.parseInt(m[1].replace(/,/g, ""), 10));
  }

  const invented = quoted.filter((p) => !allowed.has(p));
  if (invented.length) {
    // Quoting a price with no tool result at all is the worse case, not an
    // excused one: it means the figure came from the model's memory.
    issues.push({
      kind: "invented_price",
      detail: facts.prices.length
        ? `quotes ₹${invented.join(", ₹")} but the catalogue returned ₹${[...allowed].join(", ₹")}`
        : `quotes ₹${invented.join(", ₹")} without reading a price from the catalogue`,
    });
  }

  /* 3. Products. A bolded or numbered product name should be a real one. */
  // Checked whether or not a tool ran. Naming a product without searching is
  // the more serious failure — there is nothing behind the name at all.
  {
    const named = [
      ...text.matchAll(/\*\*([^*]{4,60})\*\*/g),
      ...text.matchAll(/[“"]([A-Z][^”"]{3,50})[”"]/g),
    ].map((m) => m[1].trim());

    const known = [...facts.titles, ...(facts.sellers ?? [])].map((t) => t.toLowerCase());
    const unknown = named.filter((n) => {
      const low = n.toLowerCase();
      // Allow a partial match: the model often shortens a long title.
      if (known.some((k) => k.includes(low) || low.includes(k))) return false;
      // Ignore headings, prices and UI labels rendered in bold. "Report a
      // problem" and "Place order" are buttons we deliberately tell buyers to
      // press, not products.
      if (/^(₹|rs\.?|price|option|note|total|free|cod|delivery|warranty|stock)/i.test(low)) return false;
      if (/report a problem|place order|add to cart|my orders|track/i.test(low)) return false;
      if (/^\d/.test(low)) return false;
      return true;
    });

    if (unknown.length) {
      issues.push({
        kind: "invented_product",
        detail:
          `names ${unknown.map((u) => `"${u}"`).join(", ")}, which ` +
          (facts.searched
            ? "the catalogue did not return"
            : "was never looked up — no catalogue search was made"),
      });
    }
  }

  /* 4. Policy numbers stated without reading a policy. */
  if (!facts.searched && /\b(\d{1,3})\s*(?:-|\s)?(?:day|days)\b/i.test(text)) {
    const m = text.match(/\b(\d{1,3})\s*(?:-|\s)?(?:day|days)\b/i);
    issues.push({
      kind: "unsourced_policy",
      detail: `states "${m?.[0]}" without reading the policy for this category`,
    });
  }

  return issues;
}

/**
 * A short correction to append when the guard found something.
 *
 * Appending beats silently re-asking the model: the buyer gets an answer, and
 * the part that could not be substantiated is named rather than quietly
 * presented as fact.
 */
export function correctionFor(issues: GroundingIssue[]): string {
  const kinds = new Set(issues.map((i) => i.kind));
  const lines: string[] = [];

  if (kinds.has("invented_product") || kinds.has("invented_price")) {
    lines.push(
      "Some of the products or prices above are not from our catalogue, so please " +
        "do not rely on them — ask me again and I will search properly.",
    );
  }
  if (kinds.has("unsourced_policy")) {
    lines.push(
      "The return window above was not read from the policy. Open the order and " +
        "use “Report a problem” for the exact terms that apply to it.",
    );
  }
  return lines.join(" ");
}
