/**
 * POST /api/finder/accept — put the winning offer in the cart and ask.
 *
 * This is the step that removes the last of the buyer's work. Having proved
 * which offer satisfies every stated condition, making them go and find it
 * again in the catalogue is busywork. So the agent adds it, records *why* it
 * did, and returns a checkout summary for confirmation.
 *
 * What it deliberately does NOT do is place the order. The gate is in
 * `mandate.ts` — `place_order` is in `BUYER_CONFIRM_REQUIRED`, which the tool
 * registry enforces in code, not in a prompt. An agent may fill a cart on its
 * own; a human presses the button that spends their money. This route keeps
 * that line exactly where it was.
 *
 * The offer is re-solved server-side rather than trusted from the request. A
 * client posting "add this SKU, it satisfied everything" is an assertion, and
 * the price and date it quotes may be minutes stale; re-solving means the thing
 * added to the cart is the thing that actually wins right now.
 */
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { handler } from "@/lib/api";
import { now } from "@/lib/clock";
import { emit } from "@/lib/events";
import { callTool } from "@/lib/agent/tools";
import { findOffers } from "@/lib/finder";
import { catalogueCategories, extractConstraints } from "@/lib/agent/constraint-extractor";
import type { Constraint } from "@/lib/engines/constraints";
import { ConstraintSchema } from "@/app/api/finder/schema";
import { inr } from "@/lib/text";
import { narrateAccepted } from "@/lib/speech/narrate";

const Body = z.object({
  sentence: z.string().max(600).optional(),
  constraints: z.array(ConstraintSchema).max(12).optional(),
  query: z.string().max(200).optional(),
  /**
   * The SKU and seller the buyer is accepting. Optional: with nothing named
   * the top-ranked offer is taken, which is the "just do it" path.
   */
  sku: z.string().max(40).optional(),
  sellerId: z.string().max(40).optional(),
  qty: z.number().int().min(1).max(10).default(1),
  paymentMode: z.enum(["COD", "PREPAID"]).optional(),
  addressIndex: z.number().int().min(0).max(10).optional(),
});

export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const body = Body.parse(await req.json().catch(() => ({})));

    if (!body.sentence?.trim() && !body.constraints?.length) {
      throw new Error("Tell me what you need first.");
    }

    const at = await now();
    const address = (user.addresses ?? [])[body.addressIndex ?? 0];
    const buyer = {
      pinTier: address?.pinTier ?? 2,
      priorRto: user.priorRto ?? 0,
      paymentMode: body.paymentMode ?? "PREPAID",
    };

    let constraints: Constraint[];
    let query = body.query ?? "";

    if (body.constraints?.length) {
      constraints = body.constraints as Constraint[];
    } else {
      const categories = await catalogueCategories();
      const extracted = await extractConstraints(body.sentence ?? "", at, categories);
      constraints = extracted.constraints;
      query = extracted.query;
    }

    const solved = await findOffers({
      constraints,
      buyer,
      query,
      sentence: body.sentence ?? "",
      now: at,
    });

    if (solved.satisfied.length === 0) {
      throw new Error(
        "Nothing satisfies all of those conditions, so there is nothing to add. " +
          "Relax one of them and try again.",
      );
    }

    // Honour an explicit choice; otherwise take the recommendation.
    const chosen =
      (body.sku
        ? solved.satisfied.find(
            (o) =>
              o.candidate.sku === body.sku &&
              (!body.sellerId || o.candidate.seller.sellerId === body.sellerId),
          )
        : undefined) ?? solved.satisfied[0];

    if (body.sku && chosen.candidate.sku !== body.sku) {
      throw new Error(
        `${body.sku} is not among the offers that satisfy your conditions. ` +
          "It may have gone out of stock or changed price.",
      );
    }

    const c = chosen.candidate;

    // The rationale is stored on the cart line and shown to the buyer, so an
    // item the agent put there always carries the reason it did.
    //
    // A pure need ("something for my mother's back pain") has no hard
    // constraints to list, and saying "satisfies all 0 of your conditions" is
    // both false and faintly absurd. So the two cases are worded differently:
    // what it satisfied, or why it was the closest match.
    const basis =
      chosen.satisfied.length > 0
        ? `satisfies all ${chosen.satisfied.length} of your conditions ` +
          `(${chosen.satisfied.map((x) => x.constraint).join("; ")})`
        : `the closest match to what you described, ranked first of ${solved.satisfied.length}`;

    const rationale =
      `${basis} — ${inr(chosen.cost.expectedTotalInr)} all in from ${c.seller.name}, ` +
      `${chosen.forecast.confidencePct}% confident by ` +
      `${chosen.forecast.confidentAt.slice(0, 10)}`;

    const added = await callTool(
      "add_to_cart",
      { sku: c.sku, qty: body.qty, rationale },
      { userId: String(user._id), agent: "ShoppingAgent" },
    );

    if (!added.ok) throw new Error(added.error);

    const cart = await callTool("view_cart", {}, { userId: String(user._id), agent: "ShoppingAgent" });
    const cartData = cart.ok
      ? (cart.data as { count: number; total_inr: number; items: unknown[] })
      : { count: 0, total_inr: 0, items: [] };

    await emit({
      type: "finder.offer_accepted",
      actor: "ConstraintSolver",
      summary:
        `Added ${c.title} from ${c.seller.name} to the cart — ranked first of ` +
        `${solved.satisfied.length}` +
        (constraints.length
          ? ` offers satisfying all ${constraints.length} constraint(s)`
          : " offers matching the stated need") +
        ". Awaiting the buyer's confirmation to order.",
      payload: {
        sku: c.sku,
        sellerId: c.seller.sellerId,
        expectedTotalInr: chosen.cost.expectedTotalInr,
        satisfied: chosen.satisfied.map((s) => s.constraint),
        autoSelected: !body.sku,
      },
      userId: user._id,
    });

    return {
      added: {
        sku: c.sku,
        title: c.title,
        seller: c.seller.name,
        qty: body.qty,
        stickerInr: c.priceInr,
        rationale,
      },
      /**
       * Everything the buyer needs to decide, so the confirmation step is not
       * a leap of faith. The numbers come from the same pure functions that
       * produced the comparison — nothing is recomputed for display.
       */
      checkout: {
        expectedTotalInr: chosen.cost.expectedTotalInr,
        payableNowInr: chosen.cost.payableNowInr,
        costLines: chosen.cost.lines,
        costSummary: chosen.cost.summary,
        forecast: chosen.forecast,
        satisfied: chosen.satisfied,
        paymentMode: buyer.paymentMode,
        address: address
          ? { line: address.line, city: address.city, pincode: address.pincode, pinTier: address.pinTier }
          : null,
        /** Alternatives, so accepting the recommendation is a choice not a default. */
        alternatives: solved.satisfied.slice(1, 4).map((o) => ({
          sku: o.candidate.sku,
          title: o.candidate.title,
          seller: o.candidate.seller.name,
          expectedTotalInr: o.cost.expectedTotalInr,
          confidentAt: o.forecast.confidentAt,
          rankReason: o.rankReason,
        })),
      },
      cart: { count: cartData.count, totalInr: cartData.total_inr },
      /**
       * Stated plainly and enforced elsewhere: this route cannot order. The
       * approval gate lives in the tool registry, not in this response.
       */
      awaitingApproval: true,
      nextStep:
        "Press “Place order” to confirm. Nothing has been ordered and no payment " +
        "has been taken — the agent can fill your cart but cannot spend your money.",
      // Spoken at the one stage where a misunderstanding costs money, so the
      // "nothing is ordered yet" clause is in the sentence itself.
      spoken: narrateAccepted({
        title: c.title,
        seller: c.seller.name,
        payableNowInr: chosen.cost.payableNowInr,
        expectedTotalInr: chosen.cost.expectedTotalInr,
        confidentAt: chosen.forecast.confidentAt,
        satisfiedCount: chosen.satisfied.length,
      }),
      asOf: at.toISOString(),
    };
  });
}
