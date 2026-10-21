/**
 * What a six-digit Indian pincode tells you.
 *
 * Pure, and the single source of truth for pincode facts. The tier was
 * previously decided by a private function inside the registration route,
 * which meant the number driving delivery forecasts and dispatch risk lived
 * where neither of those could reach it — and where nothing tested it.
 *
 * Three things come out of a pincode here:
 *
 *  - the **tier**, which `deliveryForecast` turns into transit days and
 *    `scoreRisk` into a failure probability,
 *  - the **city and state**, so a buyer dictating an address has two fewer
 *    fields to say,
 *  - whether the code is **plausible at all**, because a typo in a pincode
 *    misroutes a parcel in a way no later step can catch.
 *
 * The data is a prefix table, not a lookup of all ~19,000 pincodes. That is a
 * deliberate limit: a full table belongs in a database or behind the India Post
 * API, and a partial one hard-coded here would answer confidently about places
 * it has never heard of. So the table covers the first two digits — the postal
 * circle, which is a state or a group of them — and the first three where that
 * identifies a city worth naming. Anything else returns the state alone, or
 * nothing, and says so rather than guessing.
 */

export type PinFacts = {
  /** The pincode as given, digits only. */
  pincode: string;
  /** False when it cannot be an Indian pincode at all. */
  valid: boolean;
  /**
   * 1 metro · 2 large city · 3 smaller city or town · 4 remote.
   *
   * Defaults to 3 for a valid code we cannot place, because assuming a parcel
   * will arrive as fast as it would in Mumbai is the error that costs a buyer
   * a missed deadline.
   */
  tier: 1 | 2 | 3 | 4;
  /** Empty when the prefix does not identify one city. */
  city: string;
  /** Empty only when the circle itself is unknown. */
  state: string;
  /** True when city and state were derived rather than supplied. */
  derived: boolean;
};

/**
 * Metro pincode prefixes, by first three digits.
 *
 * These are the eight cities with same-city warehousing, which is what tier 1
 * actually means here — not population.
 */
const METRO: Record<string, [string, string]> = {
  110: ["New Delhi", "Delhi"],
  111: ["New Delhi", "Delhi"],
  120: ["Gurugram", "Haryana"],
  121: ["Faridabad", "Haryana"],
  122: ["Gurugram", "Haryana"],
  201: ["Noida", "Uttar Pradesh"],
  380: ["Ahmedabad", "Gujarat"],
  400: ["Mumbai", "Maharashtra"],
  401: ["Thane", "Maharashtra"],
  410: ["Navi Mumbai", "Maharashtra"],
  411: ["Pune", "Maharashtra"],
  500: ["Hyderabad", "Telangana"],
  501: ["Hyderabad", "Telangana"],
  560: ["Bengaluru", "Karnataka"],
  561: ["Bengaluru", "Karnataka"],
  600: ["Chennai", "Tamil Nadu"],
  700: ["Kolkata", "West Bengal"],
};

/** Tier-2 cities: a regional hub with a local depot but no same-city stock. */
const TIER2: Record<string, [string, string]> = {
  141: ["Ludhiana", "Punjab"],
  143: ["Amritsar", "Punjab"],
  160: ["Chandigarh", "Chandigarh"],
  171: ["Shimla", "Himachal Pradesh"],
  226: ["Lucknow", "Uttar Pradesh"],
  248: ["Dehradun", "Uttarakhand"],
  282: ["Agra", "Uttar Pradesh"],
  302: ["Jaipur", "Rajasthan"],
  313: ["Udaipur", "Rajasthan"],
  360: ["Rajkot", "Gujarat"],
  390: ["Vadodara", "Gujarat"],
  395: ["Surat", "Gujarat"],
  413: ["Solapur", "Maharashtra"],
  416: ["Kolhapur", "Maharashtra"],
  422: ["Nashik", "Maharashtra"],
  431: ["Aurangabad", "Maharashtra"],
  440: ["Nagpur", "Maharashtra"],
  452: ["Indore", "Madhya Pradesh"],
  462: ["Bhopal", "Madhya Pradesh"],
  482: ["Jabalpur", "Madhya Pradesh"],
  492: ["Raipur", "Chhattisgarh"],
  520: ["Vijayawada", "Andhra Pradesh"],
  530: ["Visakhapatnam", "Andhra Pradesh"],
  570: ["Mysuru", "Karnataka"],
  575: ["Mangaluru", "Karnataka"],
  580: ["Hubballi", "Karnataka"],
  590: ["Belagavi", "Karnataka"],
  620: ["Tiruchirappalli", "Tamil Nadu"],
  625: ["Madurai", "Tamil Nadu"],
  641: ["Coimbatore", "Tamil Nadu"],
  682: ["Kochi", "Kerala"],
  695: ["Thiruvananthapuram", "Kerala"],
  751: ["Bhubaneswar", "Odisha"],
  781: ["Guwahati", "Assam"],
  800: ["Patna", "Bihar"],
  834: ["Ranchi", "Jharkhand"],
};

/**
 * Towns the seed data uses, so a demo address resolves to a real place.
 *
 * Tier 3 is the default anyway; these exist to give the town a name, because
 * "Tumakuru, Karnataka" on a confirmation screen reads as a system that knows
 * where it is sending the parcel and "pincode 572101" does not.
 */
const TIER3_TOWNS: Record<string, [string, string]> = {
  572: ["Tumakuru", "Karnataka"],
  577: ["Davanagere", "Karnataka"],
  583: ["Ballari", "Karnataka"],
  586: ["Vijayapura", "Karnataka"],
  613: ["Thanjavur", "Tamil Nadu"],
  627: ["Tirunelveli", "Tamil Nadu"],
  630: ["Sivaganga", "Tamil Nadu"],
  676: ["Malappuram", "Kerala"],
  713: ["Durgapur", "West Bengal"],
  735: ["Jalpaiguri", "West Bengal"],
};

/**
 * Postal circles by first two digits, as a fallback for the state.
 *
 * A buyer in a town none of the tables name still gets their state filled in,
 * which is the field people most often leave blank.
 */
const CIRCLES: Record<string, string> = {
  11: "Delhi",
  12: "Haryana", 13: "Haryana",
  14: "Punjab", 15: "Punjab", 16: "Punjab",
  17: "Himachal Pradesh",
  18: "Jammu and Kashmir", 19: "Jammu and Kashmir",
  20: "Uttar Pradesh", 21: "Uttar Pradesh", 22: "Uttar Pradesh",
  23: "Uttar Pradesh", 25: "Uttar Pradesh",
  26: "Uttar Pradesh", 27: "Uttar Pradesh", 28: "Uttar Pradesh",
  // 24x is split between the two states; Uttarakhand holds 24[46-9] and
  // 263-essentials. The circle fallback names the commoner one and the
  // tier tables above override it where a town is known.
  24: "Uttarakhand",
  30: "Rajasthan", 31: "Rajasthan", 32: "Rajasthan", 33: "Rajasthan",
  34: "Rajasthan",
  36: "Gujarat", 37: "Gujarat", 38: "Gujarat", 39: "Gujarat",
  40: "Maharashtra", 41: "Maharashtra", 42: "Maharashtra",
  43: "Maharashtra", 44: "Maharashtra",
  45: "Madhya Pradesh", 46: "Madhya Pradesh", 47: "Madhya Pradesh",
  48: "Madhya Pradesh",
  49: "Chhattisgarh",
  50: "Telangana", 51: "Andhra Pradesh", 52: "Andhra Pradesh",
  53: "Andhra Pradesh",
  56: "Karnataka", 57: "Karnataka", 58: "Karnataka", 59: "Karnataka",
  60: "Tamil Nadu", 61: "Tamil Nadu", 62: "Tamil Nadu", 63: "Tamil Nadu",
  64: "Tamil Nadu",
  67: "Kerala", 68: "Kerala", 69: "Kerala",
  70: "West Bengal", 71: "West Bengal", 72: "West Bengal", 73: "West Bengal",
  74: "West Bengal",
  75: "Odisha", 76: "Odisha", 77: "Odisha",
  78: "Assam", 79: "Assam, Arunachal Pradesh and Nagaland",
  80: "Bihar", 81: "Bihar", 82: "Jharkhand", 83: "Jharkhand",
  84: "Bihar", 85: "Bihar",
};

/**
 * Does this look like an Indian pincode at all?
 *
 * Judges the string as given, not what survives stripping punctuation: "56 00
 * 01" is what a buyer types when they are unsure, and accepting it silently
 * means never asking them to check. Callers that want to be lenient normalise
 * first — `pinFacts` does, deliberately, because by then the digits have
 * already been confirmed.
 */
export function isPincode(raw: string): boolean {
  // Six digits, nothing else, and the first cannot be zero: no Indian circle
  // starts at 0.
  return /^[1-9]\d{5}$/.test((raw ?? "").trim());
}

/**
 * Read everything a pincode implies.
 *
 * Never throws. An unreadable pincode comes back `valid: false` with tier 3,
 * so a caller that ignores the flag still gets a conservative forecast rather
 * than an optimistic one.
 */
export function pinFacts(raw: string): PinFacts {
  // Normalised first: this is the lenient path, called on values the buyer has
  // already been shown and confirmed.
  const pincode = digits(raw);

  if (!isPincode(pincode)) {
    return { pincode, valid: false, tier: 3, city: "", state: "", derived: false };
  }

  const three = pincode.slice(0, 3);
  const two = pincode.slice(0, 2);

  const metro = METRO[three];
  if (metro) {
    return { pincode, valid: true, tier: 1, city: metro[0], state: metro[1], derived: true };
  }

  const t2 = TIER2[three];
  if (t2) {
    return { pincode, valid: true, tier: 2, city: t2[0], state: t2[1], derived: true };
  }

  const town = TIER3_TOWNS[three];
  if (town) {
    return { pincode, valid: true, tier: 3, city: town[0], state: town[1], derived: true };
  }

  // Known circle, unknown town: name the state and leave the city to the buyer.
  return {
    pincode,
    valid: true,
    tier: 3,
    city: "",
    state: CIRCLES[two] ?? "",
    derived: Boolean(CIRCLES[two]),
  };
}

/**
 * The tier alone, for callers that want nothing else.
 *
 * Kept as a named export because `pinTier` is the word the rest of the
 * codebase already uses for this number.
 */
export function pinTier(raw: string): 1 | 2 | 3 | 4 {
  return pinFacts(raw).tier;
}

/**
 * What is missing or weak about an address, in the buyer's own interest.
 *
 * These are not validation errors — the address is accepted either way. They
 * are the things `scoreRisk` will later penalise, said at the moment they can
 * still be fixed for free. A landmark added after a failed delivery attempt
 * has cost everyone a week.
 */
export type AddressAdvice = {
  field: "landmark" | "pincode" | "line" | "city" | "phone";
  severity: "blocking" | "worth_fixing";
  message: string;
};

export function adviseAddress(a: {
  line?: string;
  landmark?: string;
  city?: string;
  pincode?: string;
  phone?: string;
}): AddressAdvice[] {
  const out: AddressAdvice[] = [];
  const facts = pinFacts(a.pincode ?? "");

  if (!facts.valid) {
    out.push({
      field: "pincode",
      severity: "blocking",
      message: "That is not a six-digit Indian pincode.",
    });
  }

  if ((a.line ?? "").trim().length < 6) {
    out.push({
      field: "line",
      severity: "blocking",
      message: "The street address is too short to deliver to.",
    });
  }

  if (!(a.landmark ?? "").trim()) {
    // Quantified rather than nagged about, and only where it actually matters:
    // the risk engine charges for a missing landmark on a tier-3 pincode.
    out.push({
      field: "landmark",
      severity: "worth_fixing",
      message:
        facts.tier >= 3
          ? "No landmark. On a pincode like this one that is the commonest reason a courier gives up — worth adding."
          : "A landmark helps the courier find you first time.",
    });
  }

  if (!(a.city ?? "").trim() && !facts.city) {
    out.push({
      field: "city",
      severity: "worth_fixing",
      message: "We could not work out the city from that pincode. Add it so the label is right.",
    });
  }

  if (!/^[6-9]\d{9}$/.test(digits(a.phone ?? ""))) {
    out.push({
      field: "phone",
      severity: "worth_fixing",
      message: "A ten-digit mobile number lets the courier call before arriving.",
    });
  }

  return out;
}

function digits(s: string): string {
  return (s ?? "").replace(/\D/g, "");
}
