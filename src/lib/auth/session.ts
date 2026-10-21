/**
 * Session handling: a signed JWT in an httpOnly cookie.
 *
 * Deliberately small. No OAuth, no provider, no refresh dance — the demo needs
 * to know who is asking and whether they may operate the desk, and that is all
 * this does. `requireOperator` exists so the approval gate cannot be opened by
 * a buyer calling the API directly: a gate enforced only in the UI is not a gate.
 */
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { connectDb } from "@/lib/db/connect";
import { User, type UserDoc } from "@/models";

const COOKIE = "vaanijya_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function key(): Uint8Array {
  return new TextEncoder().encode(env.auth.secret);
}

export type SessionClaims = {
  sub: string;
  email: string;
  name: string;
  role: "buyer" | "operator" | "seller";
};

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function createSession(user: {
  _id: unknown;
  email: string;
  name: string;
  role: string;
}): Promise<void> {
  const token = await new SignJWT({
    email: user.email,
    name: user.name,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(user._id))
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(key());

  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.app.isProd,
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

/** The claims in the cookie, or null. Does not hit the database. */
export async function readSession(): Promise<SessionClaims | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    if (!payload.sub) return null;
    return {
      sub: String(payload.sub),
      email: String(payload.email ?? ""),
      name: String(payload.name ?? ""),
      role: (payload.role as SessionClaims["role"]) ?? "buyer",
    };
  } catch {
    return null;
  }
}

/** The full user document for the current session, or null. */
export async function currentUser(): Promise<UserDoc | null> {
  const s = await readSession();
  if (!s) return null;
  await connectDb();
  return User.findById(s.sub).lean<UserDoc>();
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function requireUser(): Promise<UserDoc> {
  const u = await currentUser();
  if (!u) throw new AuthError("Sign in to continue.", 401);
  return u;
}

/**
 * Enforced on every route that approves, rejects or releases money.
 * The UI hides those controls from a buyer; this is what actually stops them.
 */
export async function requireOperator(): Promise<UserDoc> {
  const u = await requireUser();
  if (u.role !== "operator") {
    throw new AuthError("This action is restricted to platform operators.", 403);
  }
  return u;
}
