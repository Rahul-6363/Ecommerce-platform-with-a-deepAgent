import { z } from "zod";
import { connectDb } from "@/lib/db/connect";
import { User } from "@/models";
import type { LeanUser } from "@/models";
import { createSession, verifyPassword } from "@/lib/auth/session";
import { handler, fail } from "@/lib/api";
import { hit, clear, clientIp, LOGIN_LIMIT } from "@/lib/auth/throttle";

const Body = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  return handler(async () => {
    const { email, password } = Body.parse(await req.json());

    /* Two keys, because the two attacks fail differently.
     *
     * Someone working one email through a password list is stopped by the
     * email key. Someone working many emails from one address is stopped by
     * the IP key. Limiting only one leaves the other wide open.
     *
     * Counted before the bcrypt compare: a limiter consulted afterwards has
     * already paid the CPU cost it exists to avoid, which is itself the
     * cheapest denial-of-service there is against a login endpoint. */
    const ip = clientIp(req);
    for (const key of [`login:email:${email}`, `login:ip:${ip}`]) {
      const gate = hit(key, LOGIN_LIMIT);
      if (!gate.allowed) {
        return fail(
          `Too many sign-in attempts. Try again in ${Math.ceil(gate.retryAfterSeconds / 60)} minutes.`,
          429,
          { retryAfterSeconds: gate.retryAfterSeconds },
        );
      }
    }

    await connectDb();
    const user = await User.findOne({ email }).lean<LeanUser>();

    // One message for both failure modes: a different message for "no such
    // account" tells an attacker which addresses are registered.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return fail("That email and password do not match.", 401);
    }

    // Only a success clears the counters, so two mistypes followed by the
    // right password do not leave someone near a lockout. A failure keeps
    // counting, which is the whole point.
    clear(`login:email:${email}`);
    clear(`login:ip:${ip}`);

    await createSession(user);
    return { email: user.email, name: user.name, role: user.role, lang: user.lang };
  });
}
