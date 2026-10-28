import { z } from "zod";
import { readSession, requireUser } from "@/lib/auth/session";
import { callTool } from "@/lib/agent/tools";
import { handler, fail } from "@/lib/api";

/**
 * Read the cart.
 *
 * A signed-out visitor gets an empty cart rather than a 401. Browsing is
 * public now, so the shell renders a cart count on every page for everyone —
 * and answering 401 to "what is in my cart" made a guest's first page load
 * emit a console error for a question with a perfectly good answer: nothing.
 *
 * `GET` is the only method that relaxes. Adding to a cart has to belong to
 * someone, so `POST` still requires a session and says so.
 */
export async function GET() {
  const session = await readSession();
  if (!session) {
    // Not an error state. There is no cart because there is nobody yet.
    return Response.json({ items: [], count: 0, total_inr: 0, signedIn: false });
  }

  return handler(async () => {
    // Re-resolved through requireUser rather than trusting the cookie claims:
    // the session may name an account that has since been deleted.
    const u = await requireUser();
    const res = await callTool("view_cart", {}, { userId: String(u._id), agent: "ShoppingAgent" });
    return res.ok ? { ...(res.data as object), signedIn: true } : fail(res.error, 400);
  });
}

const Body = z.object({
  action: z.enum(["add", "remove"]),
  sku: z.string().min(1),
  qty: z.number().int().min(1).max(10).default(1),
});

export async function POST(req: Request) {
  return handler(async () => {
    const u = await requireUser();
    const b = Body.parse(await req.json());
    // Routed through the registry, not straight to the model, so a human click
    // and an agent call land in the same audit trail.
    const res = await callTool(
      b.action === "add" ? "add_to_cart" : "remove_from_cart",
      { sku: b.sku, qty: b.qty, rationale: "added by the buyer from the storefront" },
      { userId: String(u._id), agent: "ShoppingAgent" },
    );
    return res.ok ? res.data : fail(res.error, 400);
  });
}
