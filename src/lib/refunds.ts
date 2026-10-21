/**
 * The refund ledger.
 *
 * `paymentStatus: "REFUNDED"` on an order is technically true and practically
 * useless. It does not say how much came back, where it went, or when it will
 * land — which is the entire content of every "where is my refund" message a
 * support desk ever receives. So each money movement gets a row that answers
 * all three, with a settlement date taken from the policy SLA rather than
 * invented, and the buyer sees the same row the operator does.
 *
 * The amount is never computed here. It arrives from `checkEntitlement` via
 * the approval, and this module only records and settles it — so there is
 * exactly one place in the platform that decides what a buyer is owed.
 */
import { nanoid } from "nanoid";
import { connectDb } from "@/lib/db/connect";
import { Order, Policy, Refund, User } from "@/models";
import type { LeanOrder, LeanPolicy, LeanRefund, LeanUser } from "@/models";
import { emit } from "@/lib/events";
import { now } from "@/lib/clock";

/** How a remedy is paid out, and what the buyer is told about it. */
const METHOD_FOR: Record<string, "ORIGINAL_PAYMENT" | "BANK_TRANSFER" | "STORE_CREDIT"> = {
  FULL_REFUND: "ORIGINAL_PAYMENT",
  PARTIAL_REFUND: "ORIGINAL_PAYMENT",
  STORE_CREDIT: "STORE_CREDIT",
};

/** Store credit is on the platform's own books, so it is available at once. */
const STORE_CREDIT_SLA_DAYS = 0;

/**
 * Open a refund against an approved claim.
 *
 * The expected settlement date comes from the governing policy's
 * `refundSlaDays`, the same field `checkEntitlement` uses for the claim
 * deadline, so the two can never quote the buyer different dates.
 */
export async function openRefund(input: {
  claimId: string | null;
  orderId: string;
  userId: string;
  remedy: string;
  amountInr: number;
  clauseIds?: string[];
  note?: string;
}): Promise<LeanRefund | null> {
  await connectDb();
  if (input.amountInr <= 0) return null; // a goods remedy moves no money

  const order = await Order.findById(input.orderId).lean<LeanOrder>();
  if (!order) return null;

  const method = METHOD_FOR[input.remedy] ?? "ORIGINAL_PAYMENT";
  const nowAt = await now();

  // COD was paid in cash at the door, so there is no instrument to reverse —
  // that money has to go to a bank account instead. Saying so up front is the
  // difference between a clear refund and a fortnight of confusion.
  const resolvedMethod =
    method === "ORIGINAL_PAYMENT" && order.paymentMode === "COD" ? "BANK_TRANSFER" : method;

  const policy = order.items[0]?.policyId
    ? await Policy.findOne({ policyId: order.items[0].policyId })
        .select("refundSlaDays")
        .lean<LeanPolicy>()
    : null;

  const slaDays =
    resolvedMethod === "STORE_CREDIT" ? STORE_CREDIT_SLA_DAYS : (policy?.refundSlaDays ?? 7);

  const refundNo = `RFD-${nanoid(8).toUpperCase()}`;
  const expectedBy = new Date(nowAt.getTime() + slaDays * 86_400_000);

  await Refund.create({
    refundNo,
    claimId: input.claimId,
    orderId: order._id,
    userId: input.userId,
    sellerId: order.items[0]?.sellerId ?? "",
    remedy: input.remedy,
    amountInr: Math.trunc(input.amountInr),
    method: resolvedMethod,
    destination: await describeDestination(input.userId, order, resolvedMethod),
    // Store credit is instant; everything else has to clear a provider.
    status: resolvedMethod === "STORE_CREDIT" ? "SETTLED" : "PROCESSING",
    initiatedAt: nowAt,
    expectedBy,
    settledAt: resolvedMethod === "STORE_CREDIT" ? nowAt : null,
    clauseIds: input.clauseIds ?? [],
    note: input.note ?? "",
  });

  await emit({
    type: "refund.initiated",
    actor: "ActionAgent",
    summary:
      `${refundNo}: ₹${Math.trunc(input.amountInr).toLocaleString("en-IN")} via ` +
      `${label(resolvedMethod)}` +
      (resolvedMethod === "STORE_CREDIT"
        ? " — credited immediately"
        : `, expected by ${expectedBy.toISOString().slice(0, 10)} (${slaDays}-day policy SLA)`),
    payload: {
      refundNo,
      amountInr: Math.trunc(input.amountInr),
      method: resolvedMethod,
      expectedBy: expectedBy.toISOString(),
      slaDays,
      clauseIds: input.clauseIds ?? [],
    },
    claimId: input.claimId,
    orderId: order._id,
    userId: input.userId,
  });

  return Refund.findOne({ refundNo }).lean<LeanRefund>();
}

/**
 * Mark the money as arrived.
 *
 * In a real deployment this is a payment-provider webhook. Here the operator
 * desk or the clock advance calls it, so the settled state is reachable in a
 * demo and the buyer-facing timeline is complete rather than stuck at
 * "processing" forever.
 */
export async function settleRefund(refundNo: string): Promise<LeanRefund | null> {
  await connectDb();
  const refund = await Refund.findOne({ refundNo });
  if (!refund) return null;
  if (refund.status === "SETTLED") return Refund.findOne({ refundNo }).lean<LeanRefund>();

  const nowAt = await now();
  refund.status = "SETTLED";
  refund.settledAt = nowAt;
  await refund.save();

  const late = nowAt.getTime() > new Date(refund.expectedBy).getTime();

  await emit({
    type: "refund.settled",
    actor: "ActionAgent",
    summary:
      `${refund.refundNo}: ₹${refund.amountInr.toLocaleString("en-IN")} reached the buyer` +
      (late ? " — AFTER the date promised to them" : " within the promised window"),
    payload: {
      refundNo: refund.refundNo,
      amountInr: refund.amountInr,
      settledAt: nowAt.toISOString(),
      expectedBy: new Date(refund.expectedBy).toISOString(),
      late,
    },
    claimId: refund.claimId,
    orderId: refund.orderId,
    userId: refund.userId,
  });

  return Refund.findOne({ refundNo }).lean<LeanRefund>();
}

/** Settle every refund whose promised date has passed. Called by the ticker. */
export async function settleDueRefunds(): Promise<string[]> {
  await connectDb();
  const nowAt = await now();
  const due = await Refund.find({
    status: { $in: ["INITIATED", "PROCESSING"] },
    expectedBy: { $lte: nowAt },
  })
    .select("refundNo")
    .lean<{ refundNo: string }[]>();

  const settled: string[] = [];
  for (const r of due) {
    await settleRefund(r.refundNo);
    settled.push(r.refundNo);
  }
  return settled;
}

/** A buyer's refunds, newest first, with everything the UI needs to explain them. */
export async function refundsForUser(userId: string): Promise<LeanRefund[]> {
  await connectDb();
  return Refund.find({ userId }).sort({ createdAt: -1 }).limit(50).lean<LeanRefund[]>();
}

/** Refunds attached to specific orders, for the buyer's order timeline. */
export async function refundsForOrders(orderIds: string[]): Promise<Map<string, LeanRefund[]>> {
  await connectDb();
  const rows = await Refund.find({ orderId: { $in: orderIds } })
    .sort({ createdAt: -1 })
    .lean<LeanRefund[]>();

  const byOrder = new Map<string, LeanRefund[]>();
  for (const r of rows) {
    const k = String(r.orderId);
    byOrder.set(k, [...(byOrder.get(k) ?? []), r]);
  }
  return byOrder;
}

/**
 * Where the money is going, in words, masked.
 *
 * Never a full instrument: the buyer needs to recognise the destination, not
 * to read their own card number back off a web page.
 */
async function describeDestination(
  userId: string,
  order: LeanOrder,
  method: "ORIGINAL_PAYMENT" | "BANK_TRANSFER" | "STORE_CREDIT",
): Promise<string> {
  if (method === "STORE_CREDIT") {
    const user = await User.findById(userId).select("storeCreditInr").lean<LeanUser>();
    return `Vaanijya store credit (balance was ₹${(user?.storeCreditInr ?? 0).toLocaleString("en-IN")})`;
  }
  if (method === "BANK_TRANSFER") {
    return "your bank account — this order was cash on delivery, so there is no card or UPI payment to reverse";
  }
  return order.paymentMode === "PREPAID"
    ? "the card or UPI account you paid with"
    : "the original payment method";
}

function label(method: string): string {
  if (method === "STORE_CREDIT") return "store credit";
  if (method === "BANK_TRANSFER") return "bank transfer";
  return "the original payment method";
}

export { METHOD_FOR, STORE_CREDIT_SLA_DAYS };
