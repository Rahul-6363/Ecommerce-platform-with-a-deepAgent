/**
 * GET /api/checkout — everything the buyer should see before confirming.
 *
 * This endpoint exists because the order button did not have one. The UI
 * posted to `/api/orders` with a payment mode and nothing else, so
 * `addressIndex` silently defaulted to zero and the buyer approved an order
 * without ever being shown where it was going or when it would arrive.
 *
 * Read-only, and it writes nothing: the confirm step is still `POST
 * /api/orders`, still behind `BUYER_CONFIRM_REQUIRED`. What changed is that
 * the buyer now has something to confirm *about*.
 *
 * Everything here is recomputed for the chosen address rather than reused from
 * the search, because that is the whole point — a tier-3 pincode moves the
 * delivery date and the failure risk, and the forecast shown on the results
 * page was for whatever address happened to be first.
 */
import { z } from "zod";
import { connectDb } from "@/lib/db/connect";
import { Cart, Product, Seller, User } from "@/models";
import type { LeanAddress, LeanCart, LeanSeller } from "@/models";
import { requireUser } from "@/lib/auth/session";
import { handler, fail } from "@/lib/api";
import { addressAdvice, formatAddress } from "@/lib/addresses";
import { trueCost, deliveryForecast } from "@/lib/engines/offers";
import { riskScore } from "@/lib/engines/risk";
import { now } from "@/lib/clock";
import { rupees, spokenDate } from "@/lib/speech/narrate";

const Query = z.object({
  addressIndex: z.coerce.number().int().min(0).default(0),
  paymentMode: z.enum(["PREPAID", "COD"]).default("PREPAID"),
});

export async function GET(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const url = new URL(req.url);
    const q = Query.parse({
      addressIndex: url.searchParams.get("addressIndex") ?? 0,
      paymentMode: url.searchParams.get("paymentMode") ?? "PREPAID",
    });

    await connectDb();

    const buyer = await User.findById(user._id)
      .select("addresses priorRto phone")
      .lean<{ addresses?: LeanAddress[]; priorRto?: number; phone?: string }>();

    const addresses = buyer?.addresses ?? [];
    if (addresses.length === 0) {
      return fail("Add a delivery address before ordering.", 409, { needsAddress: true });
    }

    const index = Math.min(q.addressIndex, addresses.length - 1);
    const address = addresses[index];

    const cart = await Cart.findOne({ userId: user._id }).lean<LeanCart>();
    const lines = cart?.items ?? [];
    if (lines.length === 0) return fail("Your cart is empty.", 409, { emptyCart: true });

    const products = await Product.find({ sku: { $in: lines.map((l) => l.sku) } }).lean();
    const bySku = new Map(products.map((p) => [p.sku, p]));

    const sellers = await Seller.find({
      sellerId: { $in: [...new Set(products.map((p) => p.sellerId))] },
    }).lean<LeanSeller[]>();
    const bySeller = new Map(sellers.map((s) => [s.sellerId, s]));

    const at = await now();
    let itemsInr = 0;
    /** The worst sellers in the basket decide the parcel, so track the maxima. */
    let worstDefectPct = 0;
    let slowestSlaDays = 1;
    let anyCodBlocked = "";

    const items = lines.map((line) => {
      const p = bySku.get(line.sku);
      if (!p) return { sku: line.sku, title: line.sku, qty: line.qty, missing: true };

      const seller = bySeller.get(p.sellerId);
      itemsInr += p.priceInr * line.qty;
      worstDefectPct = Math.max(worstDefectPct, seller?.defectRatePct ?? 0);
      slowestSlaDays = Math.max(slowestSlaDays, seller?.fulfilmentSlaDays ?? 4);
      if (q.paymentMode === "COD" && !p.codEligible) anyCodBlocked = p.title;

      return {
        sku: p.sku,
        title: p.title,
        qty: line.qty,
        unitPriceInr: p.priceInr,
        lineInr: p.priceInr * line.qty,
        imageUrl: p.imageUrl ?? "",
        imageEmoji: p.imageEmoji,
        sellerName: seller?.name ?? p.sellerId,
        // Shown here because the cart is where an agent's choice gets
        // approved, and the reason it gave is the thing being approved.
        agentRationale: line.agentRationale ?? "",
        addedByAgent: Boolean(line.addedByAgent),
      };
    });

    // Priced for this address and this payment mode, not the search's.
    const cost = trueCost({
      priceInr: itemsInr,
      paymentMode: q.paymentMode,
      pinTier: address.pinTier,
      sellerDefectRatePct: worstDefectPct,
      refundable: true,
    });

    const forecast = deliveryForecast(
      {
        sellerSlaDays: slowestSlaDays,
        pinTier: address.pinTier,
        paymentMode: q.paymentMode,
        buyerPriorRto: buyer?.priorRto ?? 0,
      },
      at,
    );

    // The same scorer the desk runs before dispatch, run early — so a buyer
    // can fix a missing landmark now rather than after a failed attempt.
    const phone = address.phone || buyer?.phone || "";
    const risk = riskScore(
      {
        paymentMode: q.paymentMode,
        category: products[0]?.category,
        buyerPriorRto: buyer?.priorRto ?? 0,
        address: { line: address.line, landmark: address.landmark, pinTier: address.pinTier },
      },
      // No attempts yet, and the courier can only call if we have a number —
      // which is why a missing phone is advice on this screen rather than a
      // field nobody fills.
      { attempts: 0, phoneReachable: /^[6-9]\d{9}$/.test(phone) },
    );

    const advice = addressAdvice({ ...address, phone });

    return {
      address: {
        index,
        ...address,
        oneLine: formatAddress(address),
        isDefault: index === 0,
      },
      addresses: addresses.map((a, i) => ({
        index: i,
        label: a.label,
        oneLine: formatAddress(a),
        pinTier: a.pinTier,
      })),
      paymentMode: q.paymentMode,
      items,
      itemsInr,
      cost,
      forecast,
      risk: { band: risk.band, score: risk.score, reasons: risk.reasons },
      advice,
      /** Set when COD is impossible for something in the basket. */
      codBlockedBy: anyCodBlocked,
      /**
       * The confirmation, spoken.
       *
       * Destination, total and date — the three things a buyer about to
       * approve an order is actually checking, and nothing else.
       */
      spoken:
        // The short form: a buyer confirming an order is checking the town and
        // the pincode, not hearing their own street read back to them.
        `Delivering to ${shortDestination(address)}. ` +
        `${rupees(cost.expectedTotalInr)} all in, ` +
        `arriving by ${spokenDate(forecast.confidentAt)}. ` +
        (anyCodBlocked
          ? `But ${anyCodBlocked} cannot be paid for on delivery.`
          : `Shall I place it?`),
    };
  });
}

/**
 * The destination in as few spoken words as identify it.
 *
 * `spokenAddress` reads the whole thing, which is right after dictation —
 * the buyer is checking what was heard. Here they are checking *which* of
 * their addresses, and the label plus the town does that in two seconds.
 */
function shortDestination(a: { label?: string; city?: string; pincode?: string }): string {
  const where = (a.city ?? "").trim();
  const pin = (a.pincode ?? "").trim();
  const label = (a.label ?? "").trim().toLowerCase();
  const place = where || (pin.length === 6 ? `pincode ${pin.slice(0, 3)} ${pin.slice(3)}` : "");
  if (label && place) return `your ${label} address in ${place}`;
  return place || "your saved address";
}
