/**
 * Placing an order, and moving it through the delivery lifecycle.
 *
 * `placeOrder` is the one write the agent cannot perform — the buyer confirms
 * it. Everything after that (packing, dispatch, scans, delivery) is driven by
 * `advanceFulfilment`, which the operator desk calls to walk a parcel forward
 * so a reviewer can watch the whole pre-delivery lane in one sitting.
 */
import { connectDb } from "@/lib/db/connect";
import { Cart, Order, Product, Shipment, User } from "@/models";
import type { LeanCart, LeanOrder, LeanShipment, LeanUser } from "@/models";
import { emit } from "@/lib/events";
import { recordFulfilment } from "@/lib/sellers";
import { sendMail } from "@/lib/mail/mailer";
import { orderPlaced, orderStatus, buyerQuestion } from "@/lib/mail/templates";
import { riskScore, chooseIntervention } from "@/lib/engines/risk";
import { TRANSIT_DAYS_BY_TIER } from "@/lib/engines/offers";
import { now } from "@/lib/clock";
import { nanoid } from "nanoid";

const COURIERS = ["BlueDart", "Delhivery", "Ekart", "XpressBees", "India Post"];

export type PlaceOrderInput = {
  userId: string;
  paymentMode: "COD" | "PREPAID";
  addressIndex?: number;
  /**
   * What the courier should know about this delivery, in the buyer's words.
   *
   * Trimmed and capped here rather than trusted: it reaches a courier label
   * and an email, so an unbounded string from the client would be a way to
   * push arbitrary text into both.
   */
  deliveryInstructions?: string;
  /** Set when the shopping agent assembled this cart. */
  agentSessionId?: string;
};

export type PlaceOrderResult = {
  orderNo: string;
  amountInr: number;
  promisedBy: string;
  itemCount: number;
  risk: { score: number; band: string; intervention: string | null };
  mailStatus: string;
};

export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  await connectDb();
  const nowAt = await now();

  const buyer = await User.findById(input.userId).lean<LeanUser>();
  if (!buyer) throw new Error("Sign in to place an order.");

  const cart = await Cart.findOne({ userId: input.userId }).lean<LeanCart>();
  if (!cart?.items?.length) throw new Error("Your cart is empty.");

  const products = await Product.find({ sku: { $in: cart.items.map((i) => i.sku) } }).lean();
  const bySku = new Map(products.map((p) => [p.sku, p]));

  // Stock is re-checked at order time, not just when the agent added it: the
  // gap between a chat turn and a confirmation is exactly where oversell lives.
  const items = [];
  for (const line of cart.items) {
    const p = bySku.get(line.sku);
    if (!p) throw new Error(`${line.sku} is no longer available.`);
    if ((p.stock ?? 0) < line.qty) {
      throw new Error(`Only ${p.stock ?? 0} left of ${p.title}. Adjust the quantity and try again.`);
    }
    if (input.paymentMode === "COD" && !p.codEligible) {
      throw new Error(`${p.title} is not available for cash on delivery.`);
    }
    items.push({
      sku: p.sku, title: p.title, qty: line.qty, unitPriceInr: p.priceInr,
      sellerId: p.sellerId, policyId: p.policyId, category: p.category,
      brand: p.brand, boxContents: p.boxContents ?? [],
    });
  }

  const address = (buyer.addresses ?? [])[input.addressIndex ?? 0];
  if (!address) throw new Error("Add a delivery address before ordering.");

  const amountInr = items.reduce((s, i) => s + i.unitPriceInr * i.qty, 0);
  const orderNo = `ORD-${nanoid(8).toUpperCase()}`;

  // A tier-3/4 pincode genuinely takes longer; the promise reflects that
  // rather than quoting a flat number the courier cannot meet.
  //
  // Read from the same table `deliveryForecast` uses, because the promise on
  // the order and the forecast shown before the buyer pressed order have to be
  // the same number. The local copy this replaced had no tier-4 case, so a
  // remote pincode was promised a tier-3 date.
  const transitDays = TRANSIT_DAYS_BY_TIER[address.pinTier] ?? 4;
  const promisedBy = new Date(nowAt.getTime() + transitDays * 86_400_000);

  const order = await Order.create({
    orderNo,
    userId: input.userId,
    items,
    amountInr,
    paymentMode: input.paymentMode,
    paymentStatus: input.paymentMode === "PREPAID" ? "PAID" : "PENDING",
    status: "PLACED",
    address: {
      line: address.line, landmark: address.landmark, city: address.city,
      state: address.state, pincode: address.pincode, pinTier: address.pinTier,
      // Carried onto the order so the courier has a number to call even if the
      // buyer later edits the address on their account.
      phone: address.phone ?? "",
    },
    deliveryInstructions: (input.deliveryInstructions ?? "").trim().slice(0, 400),
    placedAt: nowAt,
    promisedBy,
    buyerPriority: buyer.priority,
    buyerPriorRto: buyer.priorRto,
    stockAvailable: true,
    placedByAgent: Boolean(input.agentSessionId),
    agentSessionId: input.agentSessionId ?? "",
  });

  for (const line of items) {
    await Product.updateOne({ sku: line.sku }, { $inc: { stock: -line.qty } });
  }
  await Cart.updateOne({ userId: input.userId }, { $set: { items: [] } });

  const shipment = await Shipment.create({
    shipmentId: `SHP-${nanoid(8).toUpperCase()}`,
    orderId: order._id,
    courier: COURIERS[Math.floor(Math.random() * COURIERS.length)],
    awb: `AWB${Math.floor(1e11 + Math.random() * 9e11)}`,
    promisedBy,
    status: "PENDING",
    scans: [{ at: nowAt, location: "Seller warehouse", note: "Order received by the seller", code: "PLACED" }],
  });

  await emit({
    type: "order.placed",
    actor: input.agentSessionId ? "ShoppingAgent+buyer" : "buyer",
    summary:
      `${orderNo} placed — ${items.length} item(s), ₹${amountInr}, ${input.paymentMode}` +
      (input.agentSessionId ? " (cart assembled by the agent)" : ""),
    payload: {
      orderNo, amountInr, paymentMode: input.paymentMode,
      items: items.map((i) => ({ sku: i.sku, title: i.title, qty: i.qty })),
      promisedBy: promisedBy.toISOString(),
      placedByAgent: Boolean(input.agentSessionId),
    },
    orderId: order._id,
    userId: input.userId,
    sessionId: input.agentSessionId,
  });

  /* ── Score it immediately: prevention happens before dispatch ───── */

  const verdict = riskScore(
    {
      orderNo, paymentMode: input.paymentMode, category: items[0]?.category,
      buyerPriorRto: buyer.priorRto, address: order.address,
    },
    { shipmentId: shipment.shipmentId, attempts: 0, phoneReachable: true },
  );

  await Shipment.updateOne(
    { _id: shipment._id },
    { $set: { riskScore: verdict.score, riskBand: verdict.band } },
  );

  await emit({
    type: "risk.scored",
    actor: "RiskAgent",
    summary: `${shipment.shipmentId} scored ${verdict.score}/100 (${verdict.band}) before dispatch`,
    payload: verdict,
    orderId: order._id, userId: input.userId,
  });

  const intervention = chooseIntervention(
    {
      orderNo, paymentMode: input.paymentMode, category: items[0]?.category,
      buyerPriorRto: buyer.priorRto, address: order.address,
    },
    { shipmentId: shipment.shipmentId, attempts: 0, phoneReachable: true },
    verdict,
  );

  if (intervention) {
    await emit({
      type: "risk.intervention_proposed",
      actor: "RiskAgent",
      summary: `${intervention.action} — ${intervention.expectedEffect}`,
      payload: { ...intervention, shipmentId: shipment.shipmentId },
      orderId: order._id, userId: input.userId,
    });

    // Asking the buyer a question leaves the platform, so it is gated — but a
    // question about their own address is the cheapest possible fix, so the
    // desk surfaces it immediately rather than burying it in a queue.
    if (intervention.action === "ask_buyer") {
      const q = buyerQuestion({
        name: buyer.name,
        orderNo,
        question: String(intervention.args.question ?? ""),
        why:
          "Before we dispatch this, one detail would make the delivery much more " +
          "likely to succeed the first time.",
      });
      await sendMail({
        to: buyer.email, subject: q.subject, html: q.html,
        template: "buyer_question", orderId: String(order._id),
      });
    }
  } else {
    await emit({
      type: "risk.intervention_declined",
      actor: "RiskAgent",
      summary: `Band ${verdict.band} — no intervention is warranted, so none is taken`,
      payload: { score: verdict.score, band: verdict.band },
      orderId: order._id, userId: input.userId,
    });
  }

  const mail = orderPlaced({
    name: buyer.name,
    orderNo,
    items: items.map((i) => ({ title: i.title, qty: i.qty, unitPriceInr: i.unitPriceInr })),
    amountInr,
    paymentMode: input.paymentMode,
    promisedBy,
    address: `${address.line}, ${address.city} ${address.pincode}`,
    placedByAgent: Boolean(input.agentSessionId),
  });
  const sent = await sendMail({
    to: buyer.email, subject: mail.subject, html: mail.html,
    template: "order_placed", orderId: String(order._id),
  });

  return {
    orderNo,
    amountInr,
    promisedBy: promisedBy.toISOString(),
    itemCount: items.length,
    risk: { score: verdict.score, band: verdict.band, intervention: intervention?.action ?? null },
    mailStatus: sent.status,
  };
}

/* ─────────────────────── The delivery lifecycle ─────────────────────── */

const FLOW: Record<string, { next: string; shipment: string; headline: string; detail: string; location: string; code: string }> = {
  PLACED: {
    next: "CONFIRMED", shipment: "PENDING",
    headline: "Order confirmed", code: "CONFIRMED",
    location: "Seller warehouse",
    detail: "The seller has confirmed your order and is preparing it for dispatch.",
  },
  CONFIRMED: {
    next: "PACKED", shipment: "PENDING",
    headline: "Packed and ready", code: "PACKED",
    location: "Seller warehouse",
    detail: "Your item is packed and waiting for the courier pickup.",
  },
  PACKED: {
    next: "DISPATCHED", shipment: "IN_TRANSIT",
    headline: "Dispatched", code: "DISPATCHED",
    location: "Origin hub",
    detail: "The courier has collected your parcel and it is on its way.",
  },
  DISPATCHED: {
    next: "IN_TRANSIT", shipment: "IN_TRANSIT",
    headline: "In transit", code: "IN_TRANSIT",
    location: "Transit hub",
    detail: "Your parcel is moving between hubs.",
  },
  IN_TRANSIT: {
    next: "OUT_FOR_DELIVERY", shipment: "OUT_FOR_DELIVERY",
    headline: "Out for delivery", code: "OUT_FOR_DELIVERY",
    location: "Local delivery centre",
    detail: "Your parcel is with the delivery agent and arrives today.",
  },
  OUT_FOR_DELIVERY: {
    next: "DELIVERED", shipment: "DELIVERED",
    headline: "Delivered", code: "DELIVERED",
    location: "Delivery address",
    detail: "Your parcel has been delivered. If anything is wrong with it, report it in your own language and the agent will take it from there.",
  },
};

export type AdvanceResult = {
  orderNo: string;
  from: string;
  to: string;
  shipmentStatus: string;
  mailStatus: string;
};

/** Move one order to its next lifecycle state, emitting and emailing as it goes. */
export async function advanceFulfilment(orderNo: string): Promise<AdvanceResult> {
  await connectDb();
  const nowAt = await now();

  const order = await Order.findOne({ orderNo });
  if (!order) throw new Error(`No order ${orderNo}`);

  const step = FLOW[order.status];
  if (!step) throw new Error(`${orderNo} is ${order.status} and cannot be advanced further.`);

  const from = order.status;
  order.status = step.next as typeof order.status;
  if (step.next === "DELIVERED") {
    order.deliveredAt = nowAt;
    // The denominator of every seller's defect rate. Counted on delivery
    // rather than at order time, because an order that never arrives is not
    // a fulfilment and must not flatter the seller's ratio.
    await recordFulfilment(String(order._id));
  }
  if (step.next === "DISPATCHED" || step.next === "IN_TRANSIT") {
    order.paymentStatus = order.paymentMode === "PREPAID" ? "PAID" : "PENDING";
  }
  await order.save();

  const shipment = await Shipment.findOne({ orderId: order._id });
  if (shipment) {
    shipment.status = step.shipment as typeof shipment.status;
    if (step.next === "DISPATCHED" && !shipment.dispatchedAt) shipment.dispatchedAt = nowAt;
    shipment.scans.push({ at: nowAt, location: step.location, note: step.detail, code: step.code });
    await shipment.save();
  }

  const eventType = (
    {
      CONFIRMED: "order.confirmed", PACKED: "order.packed",
      DISPATCHED: "order.dispatched", IN_TRANSIT: "order.in_transit",
      OUT_FOR_DELIVERY: "order.out_for_delivery", DELIVERED: "order.delivered",
    } as const
  )[step.next as "CONFIRMED"] ?? "shipment.scan";

  await emit({
    type: eventType,
    actor: "system",
    summary: `${orderNo}: ${from} → ${step.next}`,
    payload: { orderNo, from, to: step.next, location: step.location },
    orderId: order._id, userId: order.userId,
  });

  const buyer = await User.findById(order.userId).lean<LeanUser>();
  let mailStatus = "skipped";

  // Email the milestones a buyer cares about, not every hub scan.
  if (buyer && ["DISPATCHED", "OUT_FOR_DELIVERY", "DELIVERED"].includes(step.next)) {
    const mail = orderStatus({
      name: buyer.name, orderNo, status: step.next,
      headline: step.headline, detail: step.detail,
      promisedBy: order.promisedBy,
    });
    const sent = await sendMail({
      to: buyer.email, subject: mail.subject, html: mail.html,
      template: `order_${step.next.toLowerCase()}`, orderId: String(order._id),
    });
    mailStatus = sent.status;
  }

  return {
    orderNo, from, to: step.next,
    shipmentStatus: shipment?.status ?? "none",
    mailStatus,
  };
}

/** A failed doorstep attempt — the input that makes risk scores move. */
export async function recordFailedAttempt(orderNo: string, phoneReachable: boolean): Promise<void> {
  await connectDb();
  const nowAt = await now();
  const order = await Order.findOne({ orderNo }).lean<LeanOrder>();
  if (!order) throw new Error(`No order ${orderNo}`);
  const shipment = await Shipment.findOne({ orderId: order._id });
  if (!shipment) throw new Error("No shipment for that order.");

  shipment.attempts += 1;
  shipment.phoneReachable = phoneReachable;
  shipment.scans.push({
    at: nowAt,
    location: "Delivery address",
    note: phoneReachable
      ? "Delivery attempted; buyer not available at the address"
      : "Delivery attempted; buyer not available and phone unreachable",
    code: "ATTEMPT_FAILED",
  });
  await shipment.save();

  await emit({
    type: "shipment.attempt_failed",
    actor: "system",
    summary: `${shipment.shipmentId}: attempt ${shipment.attempts} failed${phoneReachable ? "" : ", phone unreachable"}`,
    payload: { shipmentId: shipment.shipmentId, attempts: shipment.attempts, phoneReachable },
    orderId: order._id, userId: order.userId,
  });
}
