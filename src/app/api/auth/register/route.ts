/**
 * Public registration.
 *
 * Anyone may create an account here, and every account created here is a
 * **buyer**. The role is set by this file and never read from the request:
 * accepting a `role` field would make operator access self-service, which is
 * the one thing public registration must not grant. Operators are provisioned
 * with `npm run setup -- --operator <email>` from the machine that owns the
 * database.
 *
 * The delivery address is optional. Requiring one at sign-up was a real
 * obstacle: a buyer who wants to browse has to invent a pincode before they
 * can see a price, and an address typed under that pressure is the one that
 * later produces a confidently wrong delivery date. They add it at checkout,
 * where `DestinationBlock` already shows it before the button.
 */
import { z } from "zod";
import { connectDb } from "@/lib/db/connect";
import { User } from "@/models";
import { createSession, hashPassword } from "@/lib/auth/session";
import { handler, fail } from "@/lib/api";
import { LANGUAGES } from "@/lib/types";
import { newAddress, AddressError } from "@/lib/addresses";
import { hit, clientIp, REGISTER_LIMIT } from "@/lib/auth/throttle";
import { persistenceStatus } from "@/lib/seed-guard";
import { emit } from "@/lib/events";

const Body = z
  .object({
    name: z.string().trim().min(2, "Give your name, at least 2 characters."),
    email: z.string().trim().toLowerCase().email("That is not an email address."),
    // 8 is the floor, not a recommendation. Below it a password list beats any
    // rate limit given enough addresses.
    password: z.string().min(8, "Use at least 8 characters."),
    confirmPassword: z.string().optional(),
    phone: z.string().trim().max(20).default(""),
    lang: z.enum(Object.keys(LANGUAGES) as [string, ...string[]]).default("en"),
    priority: z.enum(["speed", "money"]).default("money"),
    /** Optional at sign-up; added at checkout otherwise. */
    address: z
      .object({
        line: z.string().trim().min(5, "Give a full street address."),
        landmark: z.string().trim().default(""),
        city: z.string().trim().default(""),
        state: z.string().trim().default(""),
        pincode: z.string().regex(/^\d{6}$/, "An Indian pincode is 6 digits."),
      })
      .optional(),
  })
  // Checked on the server as well as in the form: a client-side match is a
  // convenience, not a guarantee.
  .refine((b) => !b.confirmPassword || b.confirmPassword === b.password, {
    message: "The two passwords do not match.",
    path: ["confirmPassword"],
  })
  // A password that is just the email is the commonest weak choice there is.
  .refine((b) => !b.password.toLowerCase().includes(b.email.split("@")[0]!.toLowerCase()), {
    message: "Do not use your email address as your password.",
    path: ["password"],
  });

export async function POST(req: Request) {
  return handler(async () => {
    // Before any work, including the bcrypt hash: a limiter consulted after
    // the expensive step has already paid the cost it exists to avoid.
    const gate = hit(`register:${clientIp(req)}`, REGISTER_LIMIT);
    if (!gate.allowed) {
      return fail(
        `Too many accounts created from here. Try again in ${Math.ceil(gate.retryAfterSeconds / 60)} minutes.`,
        429,
        { retryAfterSeconds: gate.retryAfterSeconds },
      );
    }

    const b = Body.parse(await req.json());
    await connectDb();

    // Say plainly that an account will not survive a restart rather than
    // letting someone register and lose it.
    const persistence = persistenceStatus();
    if (persistence.fatal) return fail(persistence.message, 503);

    if (await User.findOne({ email: b.email })) {
      return fail("An account already exists for that email. Sign in instead.", 409);
    }

    let addresses: ReturnType<typeof newAddress>[] = [];
    if (b.address) {
      try {
        addresses = [newAddress({ label: "Home", ...b.address, phone: b.phone })];
      } catch (err) {
        if (err instanceof AddressError) return fail(err.message, 422, { advice: err.advice });
        throw err;
      }
    }

    const user = await User.create({
      email: b.email,
      passwordHash: await hashPassword(b.password),
      name: b.name,
      phone: b.phone,
      lang: b.lang,
      priority: b.priority,
      // Set here, never taken from the body.
      role: "buyer",
      addresses,
    });

    await createSession(user);

    await emit({
      type: "auth.registered",
      actor: "buyer",
      summary: `${user.name} registered`,
      // No password material, and no address: the event stream is read on the
      // operator desk, and a registration does not need to publish where
      // someone lives.
      payload: { lang: user.lang, hasAddress: addresses.length > 0 },
      userId: user._id as never,
    });

    return {
      email: user.email,
      name: user.name,
      role: user.role,
      lang: user.lang,
      hasAddress: addresses.length > 0,
      persistent: persistence.persistent,
    };
  });
}
