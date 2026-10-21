/**
 * Seller accountability — the impure shell around `sellerStanding`.
 *
 * Called from exactly one place: the claim decision path in `approval.ts`.
 * That is deliberate. The only moment the platform honestly knows whether a
 * fault was real is when an operator has upheld or rejected the claim, so
 * that is the only moment a seller's record should move. Incrementing from
 * anywhere earlier would count allegations as facts.
 */
import { connectDb } from "@/lib/db/connect";
import { Order, Seller } from "@/models";
import type { LeanOrder, LeanSeller } from "@/models";
import { emit } from "@/lib/events";
import {
  sellerStanding,
  type SellerAction,
  type SellerStanding,
} from "@/lib/engines/seller-standing";

/** Listing status implied by each action the standing engine returns. */
const STATUS_FOR: Record<SellerAction, "ACTIVE" | "THROTTLED" | "SUSPENDED"> = {
  NONE: "ACTIVE",
  WATCH: "ACTIVE",
  THROTTLE_LISTINGS: "THROTTLED",
  RECOMMEND_SUSPENSION: "SUSPENDED",
};

/**
 * Record a claim outcome against the seller who fulfilled the order.
 *
 * `upheld` is the operator's decision, not the engine's recommendation and not
 * the buyer's allegation. A rejected claim is still recorded — as a rejected
 * claim — so a seller can see that the platform reviewed it and found nothing.
 */
export async function recordClaimOutcome(input: {
  orderId: string;
  sku?: string;
  upheld: boolean;
  /** Rupees actually paid out to the buyer, 0 for a goods remedy. */
  refundedInr: number;
  claimNo?: string;
}): Promise<SellerStanding | null> {
  await connectDb();

  const order = await Order.findById(input.orderId).lean<LeanOrder>();
  if (!order) return null;

  // The seller on the claimed line, or the first line when no SKU is named.
  const line = input.sku
    ? order.items.find((i) => i.sku === input.sku) ?? order.items[0]
    : order.items[0];
  if (!line?.sellerId) return null;

  const inc: Record<string, number> = input.upheld
    ? { upheldClaims: 1, refundedInr: Math.max(0, Math.trunc(input.refundedInr)) }
    : { rejectedClaims: 1 };

  await Seller.updateOne({ sellerId: line.sellerId }, { $inc: inc });

  return applyStanding(line.sellerId, { claimNo: input.claimNo, upheld: input.upheld });
}

/** Count a fulfilled order against the seller, the denominator of the rate. */
export async function recordFulfilment(orderId: string): Promise<void> {
  await connectDb();
  const order = await Order.findById(orderId).lean<LeanOrder>();
  if (!order) return;

  // One increment per distinct seller on the order, not per line: two faulty
  // items from one seller in one parcel is one fulfilment, and inflating the
  // denominator would quietly flatter a bad seller.
  for (const sellerId of new Set(order.items.map((i) => i.sellerId).filter(Boolean))) {
    await Seller.updateOne({ sellerId }, { $inc: { ordersFulfilled: 1 } });
  }
}

/**
 * Recompute a seller's standing and apply what follows from it.
 *
 * The listing status is written back so the consequence is real rather than
 * advisory, and a change of status emits an event — a seller being throttled
 * is exactly the kind of thing that must be in the audit trail rather than
 * only in a database field.
 */
export async function applyStanding(
  sellerId: string,
  context: { claimNo?: string; upheld?: boolean } = {},
): Promise<SellerStanding | null> {
  await connectDb();
  const seller = await Seller.findOne({ sellerId }).lean<LeanSeller>();
  if (!seller) return null;

  const standing = sellerStanding({
    sellerId,
    orders: seller.ordersFulfilled ?? 0,
    upheldClaims: seller.upheldClaims ?? 0,
    rejectedClaims: seller.rejectedClaims ?? 0,
    refundedInr: seller.refundedInr ?? 0,
    declaredDefectRatePct: seller.defectRatePct ?? 0,
  });

  const nextStatus = STATUS_FOR[standing.action];
  const changed = (seller.listingStatus ?? "ACTIVE") !== nextStatus;

  await Seller.updateOne({ sellerId }, { $set: { listingStatus: nextStatus } });

  if (context.claimNo) {
    await emit({
      type: "seller.standing_updated",
      actor: "SellerStandingEngine",
      summary:
        `${seller.name}: ${standing.upheldClaims} upheld claim(s) in ` +
        `${standing.orders} order(s) — effective defect rate ` +
        `${standing.effectiveDefectRatePct}% (${standing.band})`,
      payload: {
        sellerId,
        claimNo: context.claimNo,
        upheld: context.upheld,
        observedDefectRatePct: standing.observedDefectRatePct,
        effectiveDefectRatePct: standing.effectiveDefectRatePct,
        band: standing.band,
        action: standing.action,
        confident: standing.confident,
        reasons: standing.reasons,
      },
    });
  }

  if (changed) {
    await emit({
      type: nextStatus === "ACTIVE" ? "seller.listings_restored" : "seller.listings_restricted",
      actor: "SellerStandingEngine",
      summary: `${seller.name}: listings ${nextStatus.toLowerCase()} — ${standing.notice}`,
      payload: { sellerId, from: seller.listingStatus ?? "ACTIVE", to: nextStatus, standing },
    });
  }

  return standing;
}

/** Every seller's standing, for the operator desk and the seller view. */
export async function allStandings(): Promise<SellerStanding[]> {
  await connectDb();
  const sellers = await Seller.find({}).lean<LeanSeller[]>();

  return sellers
    .map((s) =>
      sellerStanding({
        sellerId: s.sellerId,
        orders: s.ordersFulfilled ?? 0,
        upheldClaims: s.upheldClaims ?? 0,
        rejectedClaims: s.rejectedClaims ?? 0,
        refundedInr: s.refundedInr ?? 0,
        declaredDefectRatePct: s.defectRatePct ?? 0,
      }),
    )
    .sort((a, b) => b.effectiveDefectRatePct - a.effectiveDefectRatePct);
}

/**
 * The defect rate the buyer-facing comparison should use.
 *
 * `trueCost` prices a seller's failure rate into what the buyer pays, and this
 * is where that number comes from once there is evidence. Returned as a map so
 * the finder can resolve every seller in one read.
 */
export async function effectiveDefectRates(): Promise<Map<string, number>> {
  const standings = await allStandings();
  return new Map(standings.map((s) => [s.sellerId, s.effectiveDefectRatePct]));
}
