/**
 * Dictated addresses, and what a pincode implies.
 *
 * A misheard address is the one input error no later step can catch: the
 * engine will happily forecast a delivery to the wrong city, and the parcel
 * fails a week later. So the parser is pinned on the things that actually
 * arrive from speech — digits spoken as words, a landmark named by its
 * preposition, a lead-in verb, a city the buyer calls by its old name — and
 * on refusing to invent what was not said.
 */
import { describe, it, expect } from "vitest";
import { parseAddress, wordsToDigits } from "@/lib/agent/address-extractor";
import { pinFacts, pinTier, isPincode, adviseAddress } from "@/lib/engines/pincode";
import { newAddress, formatAddress, spokenAddress, AddressError } from "@/lib/addresses";

/* ─────────────────────────────── Pincodes ─────────────────────────────── */

describe("what a pincode implies", () => {
  it("places the metros at tier 1", () => {
    // Tier 1 here means same-city warehousing, which is what makes a
    // three-day forecast honest rather than optimistic.
    for (const [pin, city] of [
      ["560001", "Bengaluru"], ["400001", "Mumbai"], ["110001", "New Delhi"],
      ["600001", "Chennai"], ["700001", "Kolkata"], ["500001", "Hyderabad"],
      ["411001", "Pune"], ["380001", "Ahmedabad"],
    ] as const) {
      const f = pinFacts(pin);
      expect(f.tier, pin).toBe(1);
      expect(f.city, pin).toBe(city);
    }
  });

  it("places regional hubs at tier 2 and towns at tier 3", () => {
    expect(pinFacts("641001").tier).toBe(2); // Coimbatore
    expect(pinFacts("641001").city).toBe("Coimbatore");
    expect(pinFacts("572101").tier).toBe(3); // Tumakuru, as the seed uses
    expect(pinFacts("572101").city).toBe("Tumakuru");
  });

  it("names the state even for a town it cannot place", () => {
    // The field buyers most often leave blank, and the circle is enough.
    const f = pinFacts("574199");
    expect(f.valid).toBe(true);
    expect(f.state).toBe("Karnataka");
    expect(f.city).toBe("");
  });

  it("assumes the slower tier for a pincode it cannot place", () => {
    // Guessing metro speed for an unknown pincode is how a buyer misses a
    // deadline they were promised.
    expect(pinFacts("999999").tier).toBeGreaterThanOrEqual(3);
  });

  it("rejects what cannot be an Indian pincode", () => {
    for (const bad of ["", "12345", "1234567", "012345", "abcdef", "56 00 01"]) {
      expect(isPincode(bad), bad).toBe(false);
    }
    expect(isPincode("560001")).toBe(true);
    // Still answers with a conservative tier rather than throwing.
    expect(pinFacts("nonsense").valid).toBe(false);
    expect(pinFacts("nonsense").tier).toBe(3);
  });

  it("exposes the tier on its own, under the name the codebase uses", () => {
    expect(pinTier("560001")).toBe(1);
    expect(pinTier("572101")).toBe(3);
  });
});

/* ──────────────────────────── Address advice ──────────────────────────── */

describe("advice on an address", () => {
  const good = {
    line: "Flat 402, Sai Residency, 12th Cross",
    landmark: "Axis Bank",
    city: "Bengaluru",
    pincode: "560041",
    phone: "9876543210",
  };

  it("says nothing about a complete address", () => {
    expect(adviseAddress(good)).toEqual([]);
  });

  it("blocks an address that cannot be delivered to", () => {
    const bad = adviseAddress({ ...good, line: "12", pincode: "55" });
    const blocking = bad.filter((a) => a.severity === "blocking").map((a) => a.field);
    expect(blocking).toContain("line");
    expect(blocking).toContain("pincode");
  });

  it("presses harder about a missing landmark on a tier-3 pincode", () => {
    // The risk engine charges for this. Saying so at entry is the only moment
    // it is free to fix.
    const tier3 = adviseAddress({ ...good, landmark: "", pincode: "572101", city: "Tumakuru" });
    const metro = adviseAddress({ ...good, landmark: "", pincode: "560041" });

    const t3 = tier3.find((a) => a.field === "landmark");
    const m = metro.find((a) => a.field === "landmark");
    expect(t3?.message).toMatch(/commonest reason/i);
    expect(m?.message).not.toMatch(/commonest reason/i);
  });

  it("never blocks on a missing landmark or phone", () => {
    // These cost the buyer a risk score, not the order. Refusing the order
    // over them would be worse than the risk.
    const advice = adviseAddress({ ...good, landmark: "", phone: "" });
    expect(advice.every((a) => a.severity === "worth_fixing")).toBe(true);
  });
});

/* ───────────────────── Spoken digits into a pincode ───────────────────── */

describe("spoken digits", () => {
  it("joins a pincode dictated as words", () => {
    // Whisper transcribes dictated digits as words about as often as numerals.
    expect(wordsToDigits("five six zero zero four one")).toContain("560041");
  });

  it("leaves a lone number word alone", () => {
    // "flat two" must not become "flat 2" mid-street, and "12th Cross" must
    // survive untouched.
    expect(wordsToDigits("flat two 12th Cross")).toBe("flat two 12th Cross");
  });

  it("reads Hindi digit words", () => {
    expect(wordsToDigits("पांच छह शून्य शून्य चार एक")).toContain("560041");
  });
});

/* ───────────────────── The deterministic address parser ───────────────── */

describe("parsing a dictated address", () => {
  it("splits a full spoken address", () => {
    const a = parseAddress(
      "send it to Flat 402, Sai Residency, 12th Cross, near Axis Bank, Bangalore 560041",
    );
    expect(a.pincode).toBe("560041");
    expect(a.landmark).toBe("Axis Bank");
    expect(a.city).toBe("Bengaluru");
    expect(a.state).toBe("Karnataka");
    expect(a.line).toMatch(/Sai Residency/);
    // The lead-in verb is not part of the street.
    expect(a.line).not.toMatch(/send it to/i);
  });

  it("strips the preposition from the landmark", () => {
    for (const [said, expected] of [
      ["opposite Reliance Fresh", "Reliance Fresh"],
      ["behind the bus stand", "the bus stand"],
      ["next to Apollo Pharmacy", "Apollo Pharmacy"],
      ["beside SBI ATM", "SBI ATM"],
    ] as const) {
      const a = parseAddress(`14 Main Road, ${said}, Mysore 570001`);
      expect(a.landmark, said).toBe(expected);
    }
  });

  it("stops the landmark at the comma, not at the end of the sentence", () => {
    // "near Axis Bank, Jayanagar" means the bank is the landmark. Swallowing
    // Jayanagar too puts the area on the wrong line of the label.
    const a = parseAddress("12 Cross, near Axis Bank, Jayanagar, Bangalore 560041");
    expect(a.landmark).toBe("Axis Bank");
  });

  it("takes the city the buyer said over the one the pincode implies", () => {
    // People know their own town; the prefix table only knows the metro.
    const a = parseAddress("5 Church Street, Mysore 570001");
    expect(a.city).toBe("Mysuru");
  });

  it("accepts the names people actually use", () => {
    expect(parseAddress("1 A Road, Bombay 400001").city).toBe("Mumbai");
    expect(parseAddress("1 A Road, Bangalore 560001").city).toBe("Bengaluru");
    expect(parseAddress("1 A Road, Calcutta 700001").city).toBe("Kolkata");
    expect(parseAddress("1 A Road, Trichy 620001").city).toBe("Tiruchirappalli");
  });

  it("reads a phone number and drops the country code", () => {
    expect(parseAddress("4 Park Lane, Pune 411001, call +91 98765 43210").phone).toBe("9876543210");
    expect(parseAddress("4 Park Lane, Pune 411001, 09876543210").phone).toBe("9876543210");
  });

  it("refuses a half-remembered phone number", () => {
    // A seven-digit number is not a phone number, and storing it as one means
    // a courier calling nobody.
    expect(parseAddress("4 Park Lane, Pune 411001, 98765").phone).toBe("");
  });

  it("joins a pincode spoken in two groups", () => {
    expect(parseAddress("8 Lake View, Chennai 600 018").pincode).toBe("600018");
  });

  it("reads the label when the buyer said which address this is", () => {
    expect(parseAddress("my office, 9 Tech Park, Bangalore 560103").label).toBe("Work");
    expect(parseAddress("my home, 9 Green Street, Bangalore 560103").label).toBe("Home");
  });

  it("defaults the label rather than leaving it blank", () => {
    expect(parseAddress("9 Green Street, Bangalore 560103").label).toBe("Home");
  });

  it("does not leave the label phrase in the street", () => {
    // "my office, 9 Tech Park" means the label is Work and the street is
    // "9 Tech Park". Leaving it in printed "my office" on the courier label.
    const a = parseAddress("my office, 9 Tech Park, Mysore 570001");
    expect(a.label).toBe("Work");
    expect(a.line).not.toMatch(/office/i);
    expect(a.line).toMatch(/Tech Park/);
  });

  it("reports what it could not fill rather than inventing it", () => {
    // The whole point: the UI asks for exactly the missing fields, and a
    // confident guess here misroutes a parcel.
    const a = parseAddress("somewhere nice");
    expect(a.missing).toContain("pincode");
    expect(a.pincode).toBe("");
    expect(a.city).toBe("");
    expect(a.landmark).toBe("");
  });

  it("never invents a landmark", () => {
    const a = parseAddress("22 MG Road, Bangalore 560001");
    expect(a.landmark).toBe("");
  });

  it("survives an empty utterance", () => {
    const a = parseAddress("");
    expect(a.missing).toContain("line");
    expect(a.missing).toContain("pincode");
  });

  it("is deterministic", () => {
    const said = "Flat 7, Lotus Apartments, near City Hospital, Hubli 580020";
    expect(parseAddress(said)).toEqual(parseAddress(said));
  });
});

/* ───────────────── What gets stored, and what is derived ───────────────── */

describe("saving an address", () => {
  const dictated = {
    label: "work",
    line: "  Flat 402,   Sai Residency  ",
    landmark: "Axis Bank",
    pincode: "560041",
    phone: "+91 98765 43210",
  };

  it("derives the city, state and tier from the pincode", () => {
    const a = newAddress(dictated);
    expect(a.city).toBe("Bengaluru");
    expect(a.state).toBe("Karnataka");
    expect(a.pinTier).toBe(1);
  });

  it("never takes the tier from the caller", () => {
    // This number decides the delivery promise and the dispatch risk. A client
    // that could set it could buy a three-day promise to a village.
    const a = newAddress({ ...dictated, pincode: "572101", pinTier: 1 } as never);
    expect(a.pinTier).toBe(3);
  });

  it("keeps a city the buyer stated over the one the pincode implies", () => {
    // They know their own suburb; the prefix table only knows the metro.
    const a = newAddress({ ...dictated, city: "Jayanagar" });
    expect(a.city).toBe("Jayanagar");
    // The state still fills in behind it.
    expect(a.state).toBe("Karnataka");
  });

  it("tidies what dictation leaves behind", () => {
    const a = newAddress(dictated);
    expect(a.line).toBe("Flat 402, Sai Residency");
    expect(a.phone).toBe("9876543210");
    expect(a.label).toBe("Work");
  });

  it("refuses an address that cannot be delivered to, with the reason", () => {
    expect(() => newAddress({ line: "a", pincode: "560041" })).toThrow(AddressError);
    expect(() => newAddress({ line: "22 MG Road", pincode: "99" })).toThrow(AddressError);

    try {
      newAddress({ line: "a", pincode: "99" });
      throw new Error("should have thrown");
    } catch (e) {
      // Per-field, so the form can point at what to fix instead of saying
      // "invalid".
      const fields = (e as AddressError).advice.map((a) => a.field);
      expect(fields).toContain("line");
      expect(fields).toContain("pincode");
    }
  });

  it("accepts an address missing only a landmark or a phone", () => {
    // Those cost a risk score, not the order.
    const a = newAddress({ line: "22 MG Road, Indiranagar", pincode: "560038" });
    expect(a.landmark).toBe("");
    expect(a.phone).toBe("");
    expect(a.pincode).toBe("560038");
  });

  it("defaults the label rather than storing an empty one", () => {
    expect(newAddress({ line: "22 MG Road", pincode: "560038" }).label).toBe("Home");
  });
});

/* ──────────────────────── Reading an address back ──────────────────────── */

describe("how an address reads", () => {
  const saved = newAddress({
    line: "Flat 402, Sai Residency",
    landmark: "Axis Bank",
    pincode: "560041",
    phone: "9876543210",
  });

  it("writes one line a courier could follow", () => {
    expect(formatAddress(saved)).toBe(
      "Flat 402, Sai Residency, near Axis Bank, Bengaluru, Karnataka, 560041",
    );
  });

  it("does not prefix a landmark that already says where it is", () => {
    // Seeded and hand-typed landmarks often carry their own preposition, and
    // "near Opposite Forum Mall" was printed on the checkout screen.
    for (const landmark of ["Opposite Forum Mall", "Behind the bus stand", "near SBI"]) {
      const a = newAddress({ line: "Flat 402", landmark, pincode: "560034" });
      expect(formatAddress(a), landmark).not.toMatch(/near (Opposite|Behind|near)/i);
    }
    // One that does not gets the preposition added.
    const plain = newAddress({ line: "Flat 402", landmark: "Forum Mall", pincode: "560034" });
    expect(formatAddress(plain)).toMatch(/near Forum Mall/);
  });

  it("leaves out an absent landmark rather than saying 'near'", () => {
    const plain = newAddress({ line: "22 MG Road", pincode: "560038" });
    expect(formatAddress(plain)).not.toMatch(/near/);
  });

  it("groups the pincode for speech and drops the state", () => {
    // Six digits run together are unintelligible aloud, and the buyer knows
    // which state they live in.
    const said = spokenAddress(saved);
    expect(said).toContain("pincode 560 041");
    expect(said).not.toContain("Karnataka");
    expect(said).not.toContain("560041");
  });

  it("says something useful about a half-filled address", () => {
    expect(spokenAddress({ line: "22 MG Road" })).toBe("22 MG Road");
    expect(spokenAddress({})).toBe("");
  });
});
