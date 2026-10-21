/**
 * What the agent says out loud.
 *
 * Spoken text has a failure mode written text does not: it cannot be
 * re-read. A price mangled on screen is an annoyance; a price mangled aloud is
 * a buyer who heard the wrong number and has no way to check. So two things
 * are pinned here:
 *
 *  - **the sanitiser**, because markdown, emoji and "₹1,649" all read badly,
 *  - **the narration**, because it must never state something the engines did
 *    not compute, and must stay short enough to be heard rather than endured.
 *
 * No model writes these lines. A model asked to "summarise the result" would
 * eventually voice a number nobody calculated.
 */
import { describe, it, expect } from "vitest";
import { sanitise, MAX_CHARS } from "@/lib/speech/eleven";
import { shouldSpeakAnswer } from "@/components/ui";
import {
  narrateResult,
  narrateAccepted,
  narrateDecision,
  narrateOrderPlaced,
  narrateGreeting,
  narrateAssessment,
  firstName,
  spokenAttribute,
} from "@/lib/speech/narrate";
import { solveConstraints, type Candidate, type Constraint } from "@/lib/engines/constraints";

const NOW = new Date("2026-10-18T12:00:00Z");

/* ─────────────────────────── The sanitiser ─────────────────────────── */

describe("sanitise", () => {
  it("says rupees as a word, after the number", () => {
    // "₹1,649" read literally comes out as a digit string or a symbol name.
    expect(sanitise("It costs ₹1,649 all in")).toBe("It costs 1649 rupees all in");
  });

  it("handles several amounts in one line", () => {
    const out = sanitise("₹1,517 instead of ₹1,720");
    expect(out).toBe("1517 rupees instead of 1720 rupees");
  });

  it("strips markdown rather than reading it aloud", () => {
    expect(sanitise("**Stride Pro** is _cheapest_")).toBe("Stride Pro is cheapest");
  });

  it("keeps a link's label and drops its target", () => {
    expect(sanitise("see [how it works](/system)")).toBe("see how it works");
  });

  it("removes emoji, which have no spoken form", () => {
    expect(sanitise("Added 👟 to your cart")).toBe("Added to your cart");
  });

  it("turns line breaks into sentence breaks", () => {
    // Without this the model runs two statements together as one clause.
    expect(sanitise("One option fits.\nIt arrives Friday.")).toMatch(/fits\. It arrives/);
  });

  it("does not leave doubled punctuation behind", () => {
    expect(sanitise("Done.\n\nNext step.")).not.toMatch(/\.\s*\./);
  });

  it("caps the length, because this is charged per character", () => {
    const out = sanitise("word ".repeat(400));
    expect(out.length).toBeLessThanOrEqual(MAX_CHARS + 1);
  });

  it("cuts at a word boundary rather than mid-word", () => {
    const out = sanitise("elephant ".repeat(200));
    expect(out).not.toMatch(/eleph…$/);
  });

  it("returns empty for empty input rather than throwing", () => {
    expect(sanitise("")).toBe("");
    expect(sanitise("   ")).toBe("");
  });
});

/* ─────────────────────────── The narration ─────────────────────────── */

function cooker(over: Partial<Candidate> = {}): Candidate {
  return {
    sku: "VJ-KITCH-501",
    title: "Stainless Steel Pressure Cooker, 5L",
    brand: "Ganga",
    category: "kitchen",
    subcategory: "pressure cooker",
    priceInr: 1649,
    ratingAvg: 4.4,
    ratingCount: 6712,
    stock: 54,
    codEligible: true,
    attributes: { capacity_l: 5, induction: true },
    seller: { sellerId: "SEL-05", name: "Ganga Kitchenware", defectRatePct: 7, fulfilmentSlaDays: 3 },
    ...over,
  };
}

const buyer = { pinTier: 2, priorRto: 0, paymentMode: "PREPAID" as const };
const budget: Constraint[] = [{ kind: "max_price", value: 2000 }];

describe("narrateResult", () => {
  it("leads with the count, because that decides what the buyer does next", () => {
    const r = solveConstraints([cooker()], budget, buyer, NOW);
    expect(narrateResult(r)).toMatch(/^One option satisfies everything/);
  });

  it("pluralises the count correctly", () => {
    const r = solveConstraints([cooker(), cooker({ sku: "B", priceInr: 1500 })], budget, buyer, NOW);
    expect(narrateResult(r)).toMatch(/^2 options satisfy/);
  });

  it("names the product, the seller and the all-in cost", () => {
    const spoken = narrateResult(solveConstraints([cooker()], budget, buyer, NOW));
    expect(spoken).toMatch(/Stainless Steel Pressure Cooker/);
    expect(spoken).toMatch(/Ganga Kitchenware/);
    expect(spoken).toMatch(/rupees all in/);
  });

  it("mentions the seller's failure rate when it is priced in", () => {
    const spoken = narrateResult(solveConstraints([cooker()], budget, buyer, NOW));
    expect(spoken).toMatch(/7 percent failure rate/);
  });

  it("says a date is tight rather than claiming it will be met", () => {
    // The whole point of the delivery interval: a date that only the
    // optimistic estimate meets must not be spoken as a promise.
    const r = solveConstraints(
      [cooker()],
      [{ kind: "arrive_by", value: "2026-10-26T23:59:00Z" }],
      { pinTier: 3, priorRto: 1, paymentMode: "PREPAID" },
      NOW,
    );
    const spoken = narrateResult(r);
    if (r.satisfied.length > 0) {
      expect(spoken).toMatch(/comfortably before/);
    } else {
      expect(spoken.length).toBeGreaterThan(0);
    }
  });

  it("names what to relax when nothing qualifies", () => {
    const r = solveConstraints([cooker({ priceInr: 5000 })], budget, buyer, NOW);
    const spoken = narrateResult(r);
    expect(spoken).toMatch(/Nothing matches all of that/);
    expect(spoken).toMatch(/drop/);
  });

  it("says so plainly when the catalogue has nothing", () => {
    const r = solveConstraints([], budget, buyer, NOW);
    expect(narrateResult(r)).toMatch(/Nothing in the catalogue/);
  });

  it("speaks one rejection reason, not the whole tally", () => {
    // A table of counts is unlistenable; the commonest reason is the useful bit.
    const r = solveConstraints(
      [cooker(), cooker({ sku: "A", priceInr: 9000 }), cooker({ sku: "B", priceInr: 9500 })],
      budget,
      buyer,
      NOW,
    );
    const spoken = narrateResult(r);
    expect(spoken).toMatch(/2 others were rejected, mostly because they cost too much/);
  });

  it("stays short enough to listen to", () => {
    const r = solveConstraints([cooker()], budget, buyer, NOW);
    expect(narrateResult(r).length).toBeLessThan(MAX_CHARS);
  });

  it("never emits markdown or a currency symbol for the voice to trip on", () => {
    const spoken = narrateResult(solveConstraints([cooker()], budget, buyer, NOW));
    expect(spoken).not.toMatch(/[*_`#₹]/);
  });
});

describe("spokenAttribute", () => {
  // On screen these are checklist predicates. Spoken, "they did not have
  // induction is yes" is the kind of sentence that makes a voice feature
  // sound broken.
  it("reads a boolean attribute as the feature itself", () => {
    expect(spokenAttribute("induction is yes")).toBe("induction");
  });

  it("reads a negative as an absence", () => {
    expect(spokenAttribute("induction is no")).toBe("no induction");
  });

  it("reads a measurement value-first", () => {
    expect(spokenAttribute("capacity (l) is 5")).toBe("a 5 capacity l");
  });

  it("leaves anything it does not recognise alone", () => {
    expect(spokenAttribute("something odd")).toBe("something odd");
  });
});

describe("a pure need is not described as a satisfied constraint", () => {
  it("says it found matches rather than claiming conditions were met", () => {
    // The buyer stated no conditions, so "satisfies everything you asked for"
    // is both wrong and odd to hear.
    const r = solveConstraints([cooker()], [], buyer, NOW);
    expect(narrateResult(r)).toMatch(/^I found one good match/);
  });

  it("still claims satisfaction when constraints were actually stated", () => {
    const r = solveConstraints([cooker()], budget, buyer, NOW);
    expect(narrateResult(r)).toMatch(/satisfies everything you asked for/);
  });
});

describe("narrateAccepted", () => {
  const accepted = {
    title: "Memory Foam Pillow",
    seller: "Deccan Home Essentials",
    payableNowInr: 899,
    expectedTotalInr: 910,
    confidentAt: "2026-10-26T12:00:00Z",
    satisfiedCount: 3,
  };

  it("says what was added and what it will cost at checkout", () => {
    const spoken = narrateAccepted(accepted);
    expect(spoken).toMatch(/Memory Foam Pillow/);
    expect(spoken).toMatch(/899 rupees at checkout/);
  });

  it("always says that nothing is ordered yet", () => {
    // The clause that matters most: a buyer who hears "added to your cart" and
    // nothing else may reasonably think money has moved.
    expect(narrateAccepted(accepted)).toMatch(/Nothing is ordered yet/);
  });

  it("gives the expected arrival date", () => {
    expect(narrateAccepted(accepted)).toMatch(/26 October/);
  });

  it("mentions the true cost only when it differs from what is charged", () => {
    expect(narrateAccepted(accepted)).toMatch(/910 rupees once the risk/);
    const same = narrateAccepted({ ...accepted, expectedTotalInr: 899 });
    expect(same).not.toMatch(/once the risk/);
  });
});

describe("narrateDecision", () => {
  it("leads with the outcome, then the money, then the date", () => {
    const spoken = narrateDecision({
      approved: true,
      remedy: "FULL_REFUND",
      amountInr: 2499,
      expectedBy: "2026-10-25T00:00:00Z",
      method: "ORIGINAL_PAYMENT",
    });
    expect(spoken).toMatch(/^Approved\./);
    expect(spoken).toMatch(/2499 rupees/);
    expect(spoken).toMatch(/25 October/);
  });

  it("explains a COD refund going to a bank account", () => {
    // Said out loud because it is the detail that otherwise generates a
    // fortnight of "why has my card not been credited".
    const spoken = narrateDecision({
      approved: true, remedy: "FULL_REFUND", amountInr: 1000, method: "BANK_TRANSFER",
    });
    expect(spoken).toMatch(/bank account/);
    expect(spoken).toMatch(/cash on delivery/);
  });

  it("says store credit is available now", () => {
    const spoken = narrateDecision({
      approved: true, remedy: "STORE_CREDIT", amountInr: 200, method: "STORE_CREDIT",
    });
    expect(spoken).toMatch(/store credit, available now/);
  });

  it("does not mention money for a goods remedy", () => {
    const spoken = narrateDecision({ approved: true, remedy: "REPLACEMENT", amountInr: 0 });
    expect(spoken).toMatch(/replacement/);
    expect(spoken).toMatch(/No payment is involved/);
  });

  it("gives a reason with a rejection, and an appeal route", () => {
    const spoken = narrateDecision({
      approved: false,
      remedy: "NONE",
      amountInr: 0,
      reason: "The claim came 35 days after a 10-day return window.",
    });
    expect(spoken).toMatch(/not approved/);
    expect(spoken).toMatch(/35 days/);
    expect(spoken).toMatch(/a person will look at it again/);
  });
});

describe("narrateOrderPlaced", () => {
  it("is short, because the work is done", () => {
    const spoken = narrateOrderPlaced({
      orderNo: "ORD-X", amountInr: 1649, riskBand: "LOW",
      promisedBy: "2026-10-24T00:00:00Z",
    });
    expect(spoken).toMatch(/1649 rupees/);
    expect(spoken.length).toBeLessThan(160);
  });

  it("warns when the delivery is high risk", () => {
    const spoken = narrateOrderPlaced({ orderNo: "ORD-X", amountInr: 1649, riskBand: "HIGH" });
    expect(spoken).toMatch(/risky/);
  });

  it("says nothing about risk on a clean delivery", () => {
    const spoken = narrateOrderPlaced({ orderNo: "ORD-X", amountInr: 1649, riskBand: "LOW" });
    expect(spoken).not.toMatch(/risky/);
  });
});

describe("every narration survives the sanitiser unchanged", () => {
  it("emits speech-ready text in the first place", () => {
    // If narration and sanitising disagree, the audio says something the UI
    // never showed. Rupee words are the one deliberate transformation.
    const lines = [
      narrateResult(solveConstraints([cooker()], budget, buyer, NOW)),
      narrateAccepted({
        title: "Pillow", seller: "Deccan", payableNowInr: 899,
        expectedTotalInr: 910, confidentAt: "2026-10-26T12:00:00Z", satisfiedCount: 2,
      }),
      narrateDecision({ approved: true, remedy: "FULL_REFUND", amountInr: 2499 }),
      narrateOrderPlaced({ orderNo: "ORD-X", amountInr: 1649, riskBand: "LOW" }),
    ];
    for (const line of lines) {
      expect(sanitise(line)).toBe(line);
      expect(line).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});

/* ───────────────────── Greeting the buyer out loud ───────────────────── */

describe("the opening line", () => {
  it("greets by first name only", () => {
    // "Hi Arjun Mehta" is a bank calling about a loan.
    expect(narrateGreeting("shop", "Arjun Mehta")).toBe(
      "Hi Arjun, what are you shopping for today?",
    );
  });

  it("asks a question on every stage, rather than announcing itself", () => {
    // A greeting that states ("Welcome to Vaanijya") spends a second of
    // someone's attention and tells them nothing about what to do next.
    for (const stage of ["shop", "find", "complaint", "orders"] as const) {
      const line = narrateGreeting(stage, "Arjun");
      expect(line.length).toBeGreaterThan(10);
      expect(line).not.toMatch(/welcome/i);
    }
    expect(narrateGreeting("shop", "Arjun")).toMatch(/\?$/);
    expect(narrateGreeting("find", "Arjun")).toMatch(/\?/);
    expect(narrateGreeting("complaint")).toMatch(/\?/);
  });

  it("never greets a complaint by name", () => {
    // Someone whose parcel arrived broken is not being welcomed.
    const line = narrateGreeting("complaint", "Arjun");
    expect(line).not.toMatch(/Arjun/);
    expect(line).not.toMatch(/\bHi\b/);
    expect(line).toMatch(/went wrong/i);
  });

  it("drops a name that would sound wrong spoken", () => {
    // Seed and test accounts are full of these, and "Hi user2" is worse
    // than "Hi".
    expect(firstName("user2")).toBe("");
    expect(firstName("a@b.com")).toBe("");
    expect(firstName("X")).toBe("");
    expect(firstName("")).toBe("");
    expect(firstName(undefined)).toBe("");
    expect(firstName("  Priya   Sharma ")).toBe("Priya");
  });

  it("keeps a non-Latin name intact", () => {
    // The platform takes eight languages; a name is not always ASCII.
    expect(firstName("अर्जुन मेहता")).toBe("अर्जुन");
    expect(narrateGreeting("shop", "अर्जुन मेहता")).toContain("अर्जुन");
  });

  it("degrades to no name rather than to a failed mail merge", () => {
    const line = narrateGreeting("shop");
    expect(line).toBe("Hi, what are you shopping for today?");
    expect(line).not.toMatch(/there|undefined|customer/i);
  });

  it("stays within a breath, so it can be sat through", () => {
    // A spoken line the listener cannot interrupt is a cost imposed on them.
    for (const stage of ["shop", "find", "complaint", "orders"] as const) {
      expect(narrateGreeting(stage, "Arjun").length).toBeLessThan(90);
    }
  });

  it("survives the sanitiser unchanged", () => {
    for (const stage of ["shop", "find", "complaint", "orders"] as const) {
      const line = narrateGreeting(stage, "Arjun");
      expect(sanitise(line)).toBe(line);
    }
  });
});

/* ──────────────── The verdict, while it is still pending ──────────────── */

describe("narrateAssessment", () => {
  const base = { claimNo: "CLM-1001", remedy: "REFUND", amountInr: 1649, issueType: "DAMAGED" };

  it("says the amount and that it is not yet moving", () => {
    // A spoken "approved" cannot be qualified by a badge beside it, so the
    // pending state has to be inside the sentence.
    const line = narrateAssessment({ ...base, eligible: true, handoff: false });
    expect(line).toContain("1649 rupees");
    expect(line).toMatch(/one approval/i);
    expect(line).toContain("CLM-1001");
  });

  it("speaks rupees ungrouped", () => {
    const line = narrateAssessment({ ...base, amountInr: 24999, eligible: true, handoff: false });
    expect(line).toContain("24999 rupees");
    expect(line).not.toContain("24,999");
  });

  it("does not promise money when the remedy is not money", () => {
    const line = narrateAssessment({
      ...base, remedy: "REPLACEMENT", amountInr: 0, eligible: true, handoff: false,
    });
    expect(line).toMatch(/replacement/i);
    expect(line).not.toMatch(/rupees/);
  });

  it("never speaks a handoff as a rejection", () => {
    // Inconclusive evidence is a statement about our confidence, not about
    // the buyer's honesty.
    const line = narrateAssessment({ ...base, eligible: false, handoff: true });
    expect(line).toMatch(/person is reviewing/i);
    expect(line).not.toMatch(/not approved|rejected|denied|declined/i);
  });

  it("never refuses on its own authority", () => {
    const line = narrateAssessment({ ...base, eligible: false, handoff: false });
    expect(line).toMatch(/sent it to a person/i);
    expect(line).not.toMatch(/rejected|denied/i);
  });

  it("survives the sanitiser unchanged in every branch", () => {
    for (const v of [
      { eligible: true, handoff: false },
      { eligible: false, handoff: false },
      { eligible: false, handoff: true },
      { eligible: true, handoff: true },
    ]) {
      const line = narrateAssessment({ ...base, ...v });
      expect(sanitise(line)).toBe(line);
      expect(line).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});

/* ────────────── When an answer speaks without being asked ────────────── */

/**
 * `shouldSpeakAnswer` reads `sessionStorage` and `localStorage`, which do not
 * exist in a node test environment. A map-backed stand-in is enough: the
 * decision logic is what matters, not the browser's implementation.
 */
function withStorage(run: () => void, opts: { muted?: boolean; broken?: boolean } = {}) {
  const session = new Map<string, string>();
  const local = new Map<string, string>();
  if (opts.muted) local.set("vaanijya.voice", "off");

  const make = (m: Map<string, string>) =>
    opts.broken
      ? {
          getItem() { throw new Error("storage blocked"); },
          setItem() { throw new Error("storage blocked"); },
        }
      : {
          getItem: (k: string) => m.get(k) ?? null,
          setItem: (k: string, v: string) => void m.set(k, v),
        };

  const g = globalThis as unknown as { window?: unknown };
  const had = "window" in g;
  const previous = g.window;
  g.window = { sessionStorage: make(session), localStorage: make(local) };
  try {
    run();
  } finally {
    if (had) g.window = previous;
    else delete g.window;
  }
}

describe("speaking an answer unprompted", () => {
  it("speaks the first answer of a session, then stops", () => {
    // A 🔊 icon beside a reply is not discoverable — nobody presses an
    // unfamiliar button to find out what it does. So it demonstrates itself
    // once.
    withStorage(() => {
      expect(shouldSpeakAnswer("rail", false)).toBe(true);
      expect(shouldSpeakAnswer("rail", false)).toBe(false);
      expect(shouldSpeakAnswer("rail", false)).toBe(false);
    });
  });

  it("counts each surface separately", () => {
    // The rail and the finder are different conversations; being introduced
    // to one does not introduce the other.
    withStorage(() => {
      expect(shouldSpeakAnswer("rail", false)).toBe(true);
      expect(shouldSpeakAnswer("find", false)).toBe(true);
      expect(shouldSpeakAnswer("rail", false)).toBe(false);
    });
  });

  it("keeps speaking once the buyer has asked it to", () => {
    withStorage(() => {
      expect(shouldSpeakAnswer("rail", true)).toBe(true);
      expect(shouldSpeakAnswer("rail", true)).toBe(true);
    });
  });

  it("stays silent when the agent has been muted", () => {
    // The shell's switch outranks everything, including the first-time
    // introduction. An agent that talks after being silenced is broken.
    withStorage(
      () => {
        expect(shouldSpeakAnswer("rail", false)).toBe(false);
        expect(shouldSpeakAnswer("rail", true)).toBe(false);
      },
      { muted: true },
    );
  });

  it("speaks rather than going silent when storage is unavailable", () => {
    // Private browsing. A repeated greeting is a smaller failure than a
    // feature nobody ever discovers.
    withStorage(
      () => {
        expect(shouldSpeakAnswer("rail", false)).toBe(true);
      },
      { broken: true },
    );
  });
});
