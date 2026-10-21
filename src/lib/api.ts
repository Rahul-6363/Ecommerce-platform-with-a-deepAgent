/**
 * Route helpers.
 *
 * `handler()` wraps every route so an error becomes a JSON body with a sensible
 * status instead of an HTML error page, and so AuthError carries its own 401/403
 * rather than being flattened into a 500.
 */
import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth/session";
import { ZodError } from "zod";

export function ok(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function handler<T>(fn: () => Promise<T>) {
  return (async () => {
    try {
      const data = await fn();
      return data instanceof NextResponse ? data : ok(data);
    } catch (err) {
      if (err instanceof AuthError) return fail(err.message, err.status);
      if (err instanceof ZodError) {
        return fail("The request body was not valid.", 422, {
          issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api]", message);
      return fail(message, 400);
    }
  })();
}
