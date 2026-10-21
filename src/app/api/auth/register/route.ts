import { z } from "zod";
import { connectDb } from "@/lib/db/connect";
import { User } from "@/models";
import { createSession, hashPassword } from "@/lib/auth/session";
import { handler, fail } from "@/lib/api";
import { LANGUAGES } from "@/lib/types";
import { newAddress } from "@/lib/addresses";

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(6, "Use at least 6 characters."),
  name: z.string().min(2),
  phone: z.string().default(""),
  lang: z.enum(Object.keys(LANGUAGES) as [string, ...string[]]).default("en"),
  priority: z.enum(["speed", "money"]).default("money"),
  address: z.object({
    line: z.string().min(5, "Give a full street address."),
    landmark: z.string().default(""),
    city: z.string().default(""),
    state: z.string().default(""),
    pincode: z.string().regex(/^\d{6}$/, "An Indian pincode is 6 digits."),
  }),
});

export async function POST(req: Request) {
  return handler(async () => {
    const b = Body.parse(await req.json());
    await connectDb();
    if (await User.findOne({ email: b.email.toLowerCase() })) {
      return fail("An account already exists for that email.", 409);
    }
    const user = await User.create({
      email: b.email.toLowerCase(),
      passwordHash: await hashPassword(b.password),
      name: b.name, phone: b.phone, lang: b.lang, priority: b.priority,
      role: "buyer",
      addresses: [newAddress({ label: "Home", ...b.address, phone: b.phone })],
    });
    await createSession(user);
    return { email: user.email, name: user.name, role: user.role, lang: user.lang };
  });
}
