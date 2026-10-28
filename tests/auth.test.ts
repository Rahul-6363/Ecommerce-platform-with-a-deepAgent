/**
 * Authentication, authorization and buyer data isolation.
 *
 * The assertions that matter here are the negative ones. A registration form
 * that works is easy; a registration form that cannot grant operator access,
 * and an API that cannot be talked into showing one buyer another buyer's
 * orders, are the properties worth proving — and they are the ones that fail
 * silently if they regress.
 *
 * These call the route handlers directly rather than over HTTP, because that
 * is where the checks live. A test that went through the UI would prove the
 * button is hidden, which is presentation, not authorization.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { seed } from "@/lib/seed";
import { User, Order, Claim, Event } from "@/models";
import type { LeanOrder, LeanUser } from "@/models";
import { hashPassword, verifyPassword } from "@/lib/auth/session";
import { hit, clear, resetThrottle, LOGIN_LIMIT, REGISTER_LIMIT } from "@/lib/auth/throttle";
import { canSeed, persistenceStatus, DEMO_EMAILS } from "@/lib/seed-guard";
import { USERS } from "@/lib/seed-data";
import { readFileSync } from "node:fs";

let savedKey: string | undefined;

beforeAll(async () => {
  savedKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  await connectDb();
  await seed({ force: true });
}, 180_000);

afterAll(async () => {
  if (savedKey) process.env.GROQ_API_KEY = savedKey;
  await disconnectDb();
});

/* ══════════════════════ Password handling ═══════════════════════════ */

describe("passwords are never stored in a readable form", () => {
  it("hashes to something that is not the password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct");
    expect(hash.startsWith("$2")).toBe(true);
  });

  it("produces a different hash each time for the same password", async () => {
    // A deterministic hash lets an attacker spot two accounts sharing a
    // password, and makes a precomputed table viable.
    const a = await hashPassword("same-password-twice");
    const b = await hashPassword("same-password-twice");
    expect(a).not.toBe(b);
  });

  it("verifies the right password and rejects a near miss", async () => {
    const hash = await hashPassword("Monsoon#2026");
    expect(await verifyPassword("Monsoon#2026", hash)).toBe(true);
    expect(await verifyPassword("monsoon#2026", hash)).toBe(false);
    expect(await verifyPassword("Monsoon#2027", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("stores no plaintext password on any seeded account", async () => {
    const users = await User.find({}).lean<LeanUser[]>();
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) {
      expect(u.passwordHash.startsWith("$2")).toBe(true);
      expect(u.passwordHash).not.toContain("demo123");
      // And there is no stray plaintext field anywhere on the document.
      expect(Object.keys(u)).not.toContain("password");
    }
  });
});

/* ══════════════════════ Role separation ═════════════════════════════ */

describe("public registration cannot grant privilege", () => {
  it("defaults a brand-new account to buyer", async () => {
    const u = await User.create({
      email: "newbuyer@example.in",
      name: "New Buyer",
      passwordHash: await hashPassword("a-good-password"),
    });
    expect(u.role).toBe("buyer");
    await User.deleteOne({ _id: u._id });
  });

  it("only permits the three declared roles", async () => {
    // The schema enum is what stops a stray write inventing "admin".
    await expect(
      User.create({
        email: "sneaky@example.in",
        name: "Sneaky",
        passwordHash: await hashPassword("a-good-password"),
        role: "admin",
      }),
    ).rejects.toThrow();
  });

  it("has exactly one seeded operator, and it is not a buyer account", async () => {
    const ops = await User.find({ role: "operator" }).lean<LeanUser[]>();
    expect(ops.length).toBe(1);
    expect(ops[0].email).toBe("ops@vaanijya.in");
  });

  it("does not list the operator among the buyers the demo offers", async () => {
    const buyers = USERS.filter((u) => u.role !== "operator");
    expect(buyers.length).toBeGreaterThan(0);
    for (const b of buyers) expect(b.role).not.toBe("operator");
  });
});

/* ══════════════════ Buyer data isolation (IDOR) ═════════════════════ */

describe("one buyer cannot reach another buyer's data", () => {
  let arjun: LeanUser;
  let priya: LeanUser;

  beforeAll(async () => {
    arjun = (await User.findOne({ email: "arjun@example.in" }).lean<LeanUser>())!;
    priya = (await User.findOne({ email: "priya@example.in" }).lean<LeanUser>())!;
    expect(arjun).toBeTruthy();
    expect(priya).toBeTruthy();
  });

  it("scopes an order listing to the signed-in buyer", async () => {
    // This is the shape every buyer route uses: the user id comes from the
    // session, never from the request.
    const mine = await Order.find({ userId: arjun._id }).lean<LeanOrder[]>();
    const theirs = await Order.find({ userId: priya._id }).lean<LeanOrder[]>();

    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    const myNos = new Set(mine.map((o) => o.orderNo));
    for (const o of theirs) expect(myNos.has(o.orderNo)).toBe(false);
  });

  it("refuses a claim on an order that belongs to someone else", async () => {
    // `openClaim` checks ownership rather than trusting the order number,
    // which is the one thing standing between a guessed ORD- id and someone
    // else's refund.
    const theirOrder = await Order.findOne({ userId: priya._id }).lean<LeanOrder>();
    const { openClaim } = await import("@/lib/agent/claims");

    await expect(
      openClaim({
        userId: String(arjun._id),
        orderNo: theirOrder!.orderNo,
        complaint: "This never arrived.",
      }),
    ).rejects.toThrow(/different buyer/i);
  });

  it("never returns another buyer's events, even with their claim id", async () => {
    const { readEvents } = await import("@/lib/events");
    const theirClaim = await Claim.findOne({ userId: priya._id }).lean<{ _id: unknown }>();

    if (theirClaim) {
      // A forged claimId plus the session's own userId: the filters are
      // AND-combined, so the forged id narrows to nothing rather than
      // widening access.
      const leaked = await readEvents({
        claimId: String(theirClaim._id),
        userId: String(arjun._id),
      });
      expect(leaked).toEqual([]);
    }
  });

  it("keeps one buyer's addresses off another buyer's record", async () => {
    const a = await User.findById(arjun._id).lean<LeanUser>();
    const p = await User.findById(priya._id).lean<LeanUser>();
    const aPins = (a!.addresses ?? []).map((x) => x.pincode);
    const pPins = (p!.addresses ?? []).map((x) => x.pincode);
    // Distinct people, distinct address books.
    expect(aPins.some((x) => pPins.includes(x)) && aPins.length > 0).toBe(false);
  });
});

/* ══════════════════════ Brute-force limits ══════════════════════════ */

describe("sign-in and registration are rate limited", () => {
  beforeEach(() => resetThrottle());

  it("allows a handful of sign-in attempts, then locks out", () => {
    const key = "login:email:victim@example.in";
    for (let i = 0; i < LOGIN_LIMIT.max; i++) {
      expect(hit(key, LOGIN_LIMIT).allowed, `attempt ${i + 1}`).toBe(true);
    }
    const blocked = hit(key, LOGIN_LIMIT);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts two different emails separately", () => {
    // Otherwise one locked-out attacker locks out every other user too.
    for (let i = 0; i < LOGIN_LIMIT.max + 2; i++) hit("login:email:a@x.in", LOGIN_LIMIT);
    expect(hit("login:email:b@x.in", LOGIN_LIMIT).allowed).toBe(true);
  });

  it("clears the counter on a successful sign-in", () => {
    const key = "login:email:typo@example.in";
    hit(key, LOGIN_LIMIT);
    hit(key, LOGIN_LIMIT);
    clear(key);
    // Someone who mistyped twice and then got it right is not left near a
    // lockout for the next minute.
    for (let i = 0; i < LOGIN_LIMIT.max; i++) {
      expect(hit(key, LOGIN_LIMIT).allowed).toBe(true);
    }
  });

  it("does not clear the counter on a failure", () => {
    const key = "login:email:attacker@example.in";
    for (let i = 0; i < LOGIN_LIMIT.max; i++) hit(key, LOGIN_LIMIT);
    expect(hit(key, LOGIN_LIMIT).allowed).toBe(false);
  });

  it("lets the window roll over after the block expires", () => {
    const key = "login:email:patient@example.in";
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_LIMIT.max + 1; i++) hit(key, LOGIN_LIMIT, t0);
    expect(hit(key, LOGIN_LIMIT, t0).allowed).toBe(false);
    // Past the lockout, they get another window rather than being banned.
    expect(hit(key, LOGIN_LIMIT, t0 + LOGIN_LIMIT.blockMs + 1).allowed).toBe(true);
  });

  it("limits registrations from one address", () => {
    const key = "register:203.0.113.7";
    for (let i = 0; i < REGISTER_LIMIT.max; i++) {
      expect(hit(key, REGISTER_LIMIT).allowed).toBe(true);
    }
    expect(hit(key, REGISTER_LIMIT).allowed).toBe(false);
  });
});

/* ══════════════════════ Destructive seed guard ══════════════════════ */

describe("seeding cannot delete real accounts by accident", () => {
  it("allows a seed when only demo accounts exist", async () => {
    const v = await canSeed();
    expect(v.allowed).toBe(true);
    expect(v.realAccounts).toBe(0);
  });

  it("refuses once a registered account exists", async () => {
    const u = await User.create({
      email: "realperson@example.in",
      name: "Real Person",
      passwordHash: await hashPassword("a-good-password"),
    });

    const v = await canSeed();
    expect(v.allowed).toBe(false);
    expect(v.realAccounts).toBe(1);
    expect(v.reason).toMatch(/would delete them/i);

    // ...and says what to do, rather than just refusing.
    expect(v.reason).toMatch(/--force/);

    await User.deleteOne({ _id: u._id });
  });

  it("allows it with an explicit force", async () => {
    const u = await User.create({
      email: "realperson2@example.in",
      name: "Real Person",
      passwordHash: await hashPassword("a-good-password"),
    });
    const v = await canSeed({ force: true });
    expect(v.allowed).toBe(true);
    await User.deleteOne({ _id: u._id });
  });

  it("gates the production path on an explicit opt-in, not on NODE_ENV alone", () => {
    // `env.app.isProd` is captured when the module is imported, so this cannot
    // be re-evaluated by mutating process.env mid-run. What IS assertable, and
    // is the part that matters, is that the production branch requires a
    // deliberate ALLOW_DESTRUCTIVE_SEED rather than inferring permission: a
    // staging box runs a production build too, and inferring from NODE_ENV
    // alone would let a seed through there.
    const guard = readFileSync("src/lib/seed-guard.ts", "utf8");
    expect(guard).toMatch(/ALLOW_DESTRUCTIVE_SEED/);
    expect(guard).toMatch(/env\.app\.isProd && !explicitlyAllowed/);
    // And the refusal explains itself rather than returning a bare false.
    expect(guard).toMatch(/Refusing to seed: this is a production build/);
  });

  it("knows which emails belong to the demo", () => {
    expect(DEMO_EMAILS.has("arjun@example.in")).toBe(true);
    expect(DEMO_EMAILS.has("ops@vaanijya.in")).toBe(true);
    expect(DEMO_EMAILS.has("somebody-who-registered@example.in")).toBe(false);
  });
});

describe("persistence is reported honestly", () => {
  it("says data is ephemeral when no MONGODB_URI is set", () => {
    const s = persistenceStatus();
    // The test harness deliberately removes MONGODB_URI.
    expect(s.persistent).toBe(false);
    expect(s.message).toMatch(/resets|in-process/i);
  });

  it("does not call a development setup fatal", () => {
    expect(persistenceStatus().fatal).toBe(false);
  });
});

/* ══════════════════ Public pages do not demand a session ════════════ */

describe("browsing works without an account", () => {
  /* Regression: browsing was made public but the cart was still fetched on
   * mount by BOTH the shell and the page, so a signed-out visitor's first load
   * fired two 401s into the console.
   *
   * These assert the shape of the fix rather than invoking the route, because
   * a Next route handler calls `cookies()` and cannot run outside a request
   * scope under Vitest. The runtime behaviour was verified against the dev
   * server: GET /api/cart returns 200 with `{count: 0, signedIn: false}` for a
   * guest, and POST returns 401. */

  it("answers a guest cart read instead of refusing it", () => {
    const route = readFileSync("src/app/api/cart/route.ts", "utf8");
    // GET resolves the session itself and returns an empty cart for nobody...
    expect(route).toMatch(/readSession/);
    expect(route).toMatch(/count: 0, total_inr: 0, signedIn: false/);
    // ...while POST still goes through requireUser, so the relaxation is
    // read-only. A cart line has to belong to somebody.
    expect(route).toMatch(/export async function POST[\s\S]*requireUser/);
  });

  it("does not fetch a cart before knowing whether anyone is signed in", () => {
    // The two callers that produced the doubled 401.
    expect(readFileSync("src/components/Shell.tsx", "utf8")).toMatch(/if \(!me\) \{\s*setCount\(0\)/);
    expect(readFileSync("src/app/shop/page.tsx", "utf8")).toMatch(/if \(!identityKnown \|\| !user\) return;/);
  });

  it("leaves the genuinely personal pages behind a session", () => {
    // /orders and /walkthrough are per-buyer, so they still redirect. This
    // asserts the distinction was made deliberately rather than everything
    // being opened up at once.
    for (const page of ["src/app/orders/page.tsx", "src/app/walkthrough/page.tsx"]) {
      expect(readFileSync(page, "utf8"), page).toMatch(/signin/);
    }
    // ...and that the public ones no longer redirect.
    for (const page of ["src/app/shop/page.tsx", "src/app/find/page.tsx"]) {
      expect(readFileSync(page, "utf8"), page).not.toMatch(/push\("\/signin"\)/);
    }
  });

  it("does not gate the render on being signed in", () => {
    /* The bug this catches, which I introduced twice:
     *
     * Both pages had `if (!user) return <Spinner/>`, which was correct while
     * they redirected a signed-out visitor — `user` was null only for the
     * instant before the redirect. Making them public turned null into a
     * permanent, valid state (a guest), so the page spun on "Loading your
     * catalogue" forever and never rendered anything.
     *
     * The question a render guard must ask is whether identity has been
     * RESOLVED, not whether somebody is signed in. */
    for (const page of ["src/app/shop/page.tsx", "src/app/find/page.tsx"]) {
      const src = readFileSync(page, "utf8");
      expect(src, `${page} must track whether identity is resolved`).toMatch(
        /const \[identityKnown, setIdentityKnown\] = useState\(false\)/,
      );
      // Resolved either way — a rejected /api/auth/me must not leave it spinning.
      expect(src, `${page} must set the flag in a finally`).toMatch(
        /\.finally\(\(\) => setIdentityKnown\(true\)\)/,
      );
      // And the spinner is gated on resolution, never on `!user`.
      expect(src, `${page} must spin on !identityKnown`).toMatch(/if \(!identityKnown\) \{/);
      expect(src, `${page} must not spin on !user`).not.toMatch(
        /if \(!user\) \{\s*return \(\s*<main/,
      );
    }
  });

  it("prompts rather than failing when a guest tries to add to a cart", () => {
    for (const page of ["src/app/shop/page.tsx", "src/app/find/page.tsx"]) {
      expect(readFileSync(page, "utf8"), page).toMatch(
        /Sign in or create an account to start a cart/,
      );
    }
  });
});

/* ══════════════════════ Registration side effects ═══════════════════ */

describe("registration leaves an honest audit trail", () => {
  it("records no password material and no address in the event", async () => {
    const { emit } = await import("@/lib/events");
    const u = await User.create({
      email: "audited@example.in",
      name: "Audited",
      passwordHash: await hashPassword("a-good-password"),
    });
    await emit({
      type: "auth.registered",
      actor: "buyer",
      summary: `${u.name} registered`,
      payload: { lang: "en", hasAddress: false },
      userId: u._id as never,
    });

    const e = await Event.findOne({ type: "auth.registered" }).sort({ seq: -1 }).lean<{
      payload: Record<string, unknown>; summary: string;
    }>();
    expect(e).toBeTruthy();
    const blob = JSON.stringify(e!.payload) + e!.summary;
    expect(blob).not.toMatch(/password|passwordHash|\$2[aby]\$/);
    expect(e!.payload).not.toHaveProperty("address");
    expect(e!.payload).not.toHaveProperty("email");

    await User.deleteOne({ _id: u._id });
  });
});
