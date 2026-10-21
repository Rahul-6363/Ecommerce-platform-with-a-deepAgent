import { z } from "zod";
import { connectDb } from "@/lib/db/connect";
import { User } from "@/models";
import type { LeanUser } from "@/models";
import { createSession, verifyPassword } from "@/lib/auth/session";
import { handler, fail } from "@/lib/api";

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: Request) {
  return handler(async () => {
    const { email, password } = Body.parse(await req.json());
    await connectDb();
    const user = await User.findOne({ email: email.toLowerCase() }).lean<LeanUser>();
    // One message for both failure modes: a different message for "no such
    // account" tells an attacker which addresses are registered.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return fail("That email and password do not match.", 401);
    }
    await createSession(user);
    return { email: user.email, name: user.name, role: user.role, lang: user.lang };
  });
}
