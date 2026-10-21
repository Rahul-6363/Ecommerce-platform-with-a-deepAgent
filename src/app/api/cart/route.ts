import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { callTool } from "@/lib/agent/tools";
import { handler, fail } from "@/lib/api";

export async function GET() {
  return handler(async () => {
    const u = await requireUser();
    const res = await callTool("view_cart", {}, { userId: String(u._id), agent: "ShoppingAgent" });
    return res.ok ? res.data : fail(res.error, 400);
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
