/**
 * Build the database from scratch, including the scenarios the demo relies on.
 *
 * The scenarios are not decoration. Each one exists so a specific claim about
 * the system can be checked by clicking rather than taken on trust: a HIGH-risk
 * COD parcel to a tier-3 pincode with no landmark, a delivered order inside its
 * return window ready for a genuine claim, a buyer with two rejected claims
 * already on record, and an order whose courier record contradicts the story.
 */
import { connectDb } from "@/lib/db/connect";
import {
  AgentSession, Cart, Claim, Event, MailLog, Offer, Order,
  Policy, Product, Refund, Seller, Setting, Shipment, User,
} from "@/models";
import { PRODUCTS, POLICIES, SELLERS, USERS, OFFERS, DEMO_PASSWORD } from "@/lib/seed-data";
import { hashPassword } from "@/lib/auth/session";
import { emit } from "@/lib/events";
import { resetClock } from "@/lib/clock";
import { canSeed } from "@/lib/seed-guard";
import { nanoid } from "nanoid";

export type SeedReport = {
  sellers: number;
  policies: number;
  products: number;
  offers: number;
  users: number;
  orders: number;
  shipments: number;
  scenarios: string[];
  password: string;
};

/**
 * Build the demo database, destructively.
 *
 * Gated by `canSeed()` unless `force` is passed: this deletes every
 * collection, so running it against a database holding real registrations
 * would delete those people's accounts and orders. The test suites pass
 * `force` because they run against a throwaway in-process MongoDB.
 */
export async function seed(
  opts: { force?: boolean } = {},
): Promise<SeedReport> {
  await connectDb();

  if (!opts.force) {
    const verdict = await canSeed();
    if (!verdict.allowed) throw new Error(verdict.reason);
  }

  // Wipe, in dependency order. A seed that leaves yesterday's events behind
  // makes every projection wrong and every demo unrepeatable.
  await Promise.all([
    Event.deleteMany({}), Claim.deleteMany({}), Shipment.deleteMany({}),
    Order.deleteMany({}), Cart.deleteMany({}), AgentSession.deleteMany({}),
    MailLog.deleteMany({}), Product.deleteMany({}), Policy.deleteMany({}),
    Seller.deleteMany({}), User.deleteMany({}), Setting.deleteMany({}),
    Offer.deleteMany({}), Refund.deleteMany({}),
  ]);
  await resetClock();

  await Seller.insertMany(SELLERS);
  await Policy.insertMany(POLICIES);
  await Product.insertMany(PRODUCTS);
  await Offer.insertMany(OFFERS);

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const users = await User.insertMany(
    USERS.map((u) => ({ ...u, passwordHash, storeCreditInr: 0 })),
  );
  const byEmail = new Map(users.map((u) => [u.email, u]));

  const now = new Date();
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
  const scenarios: string[] = [];

  /* ── Scenario 1: HIGH delivery risk, pre-dispatch ────────────────────
   * Tier-3 pincode, COD, no landmark, one prior RTO. This is the parcel the
   * risk engine should flag before it ever leaves the warehouse.
   */
  const lakshmi = byEmail.get("lakshmi@example.in")!;
  const shoe = PRODUCTS.find((p) => p.sku === "VJ-SHOE-101")!;
  const o1 = await Order.create({
    orderNo: "ORD-DEMO001",
    userId: lakshmi._id,
    items: [{
      sku: shoe.sku, title: shoe.title, qty: 1, unitPriceInr: shoe.priceInr,
      sellerId: shoe.sellerId, policyId: shoe.policyId, category: shoe.category,
      brand: shoe.brand, boxContents: shoe.boxContents,
    }],
    amountInr: shoe.priceInr,
    paymentMode: "COD", paymentStatus: "PENDING", status: "DISPATCHED",
    address: {
      line: lakshmi.addresses[0].line, landmark: "", city: lakshmi.addresses[0].city,
      state: lakshmi.addresses[0].state, pincode: lakshmi.addresses[0].pincode, pinTier: 3,
    },
    placedAt: days(-2), promisedBy: days(3), deliveredAt: null,
    buyerPriority: "speed", buyerPriorRto: 1, stockAvailable: true,
  });
  await Shipment.create({
    shipmentId: "SHP-DEMO001", orderId: o1._id, courier: "BlueDart",
    awb: `AWB${Math.floor(1e11 + Math.random() * 9e11)}`,
    dispatchedAt: days(-1), promisedBy: days(3), attempts: 0, phoneReachable: true,
    status: "IN_TRANSIT",
    scans: [
      { at: days(-2), location: "Seller warehouse", note: "Order received by the seller", code: "PLACED" },
      { at: days(-1), location: "Agra hub", note: "Parcel collected by the courier", code: "DISPATCHED" },
      { at: days(-0.5), location: "Bengaluru hub", note: "In transit", code: "IN_TRANSIT" },
    ],
  });
  scenarios.push("ORD-DEMO001 — HIGH delivery risk before dispatch (COD, tier-3 pincode, no landmark, 1 prior RTO)");

  /* ── Scenario 2: delivered, inside the window, genuine DOA claim ─────
   * Arjun's earbuds arrived three days ago. The electronics window is 7 days,
   * so a DOA claim here should be eligible for a replacement.
   */
  const arjun = byEmail.get("arjun@example.in")!;
  const buds = PRODUCTS.find((p) => p.sku === "VJ-ELEC-201")!;
  const o2 = await Order.create({
    orderNo: "ORD-DEMO002",
    userId: arjun._id,
    items: [{
      sku: buds.sku, title: buds.title, qty: 1, unitPriceInr: buds.priceInr,
      sellerId: buds.sellerId, policyId: buds.policyId, category: buds.category,
      brand: buds.brand, boxContents: buds.boxContents,
    }],
    amountInr: buds.priceInr,
    paymentMode: "PREPAID", paymentStatus: "PAID", status: "DELIVERED",
    address: {
      line: arjun.addresses[0].line, landmark: arjun.addresses[0].landmark,
      city: arjun.addresses[0].city, state: arjun.addresses[0].state,
      pincode: arjun.addresses[0].pincode, pinTier: 1,
    },
    placedAt: days(-8), promisedBy: days(-4), deliveredAt: days(-3),
    buyerPriority: "speed", buyerPriorRto: 0, stockAvailable: true,
  });
  await Shipment.create({
    shipmentId: "SHP-DEMO002", orderId: o2._id, courier: "Delhivery",
    awb: `AWB${Math.floor(1e11 + Math.random() * 9e11)}`,
    dispatchedAt: days(-6), promisedBy: days(-4), attempts: 0, phoneReachable: true,
    status: "DELIVERED",
    scans: [
      { at: days(-8), location: "Seller warehouse", note: "Order received by the seller", code: "PLACED" },
      { at: days(-6), location: "Bengaluru hub", note: "Parcel collected by the courier", code: "DISPATCHED" },
      { at: days(-4), location: "Koramangala centre", note: "Out for delivery", code: "OUT_FOR_DELIVERY" },
      { at: days(-3), location: "Delivery address", note: "Delivered and signed for", code: "DELIVERED" },
    ],
    riskScore: 4, riskBand: "LOW",
  });
  scenarios.push("ORD-DEMO002 — delivered 3 days ago, inside the 7-day window: a genuine DOA or DAMAGED claim is eligible");

  /* ── Scenario 3: a buyer with two rejected claims on record ──────────
   * Murugan has claimed on 3 of his orders and two were rejected. The
   * authenticity engine should treat a thin new claim here sceptically — and
   * route it to a human rather than refusing him itself.
   */
  const murugan = byEmail.get("murugan@example.in")!;
  const cooker = PRODUCTS.find((p) => p.sku === "VJ-KITCH-501")!;
  const o3 = await Order.create({
    orderNo: "ORD-DEMO003",
    userId: murugan._id,
    items: [{
      sku: cooker.sku, title: cooker.title, qty: 1, unitPriceInr: cooker.priceInr,
      sellerId: cooker.sellerId, policyId: cooker.policyId, category: cooker.category,
      brand: cooker.brand, boxContents: cooker.boxContents,
    }],
    amountInr: cooker.priceInr,
    paymentMode: "COD", paymentStatus: "PENDING", status: "DELIVERED",
    address: {
      line: murugan.addresses[0].line, landmark: "", city: murugan.addresses[0].city,
      state: murugan.addresses[0].state, pincode: murugan.addresses[0].pincode, pinTier: 3,
    },
    placedAt: days(-12), promisedBy: days(-7), deliveredAt: days(-9),
    buyerPriority: "money", buyerPriorRto: 2, stockAvailable: true,
  });
  await Shipment.create({
    shipmentId: "SHP-DEMO003", orderId: o3._id, courier: "India Post",
    awb: `AWB${Math.floor(1e11 + Math.random() * 9e11)}`,
    dispatchedAt: days(-11), promisedBy: days(-7), attempts: 1, phoneReachable: true,
    status: "DELIVERED",
    scans: [
      { at: days(-12), location: "Seller warehouse", note: "Order received by the seller", code: "PLACED" },
      { at: days(-11), location: "Kanpur hub", note: "Parcel collected by the courier", code: "DISPATCHED" },
      { at: days(-10), location: "Karur centre", note: "Delivery attempted; buyer not available", code: "ATTEMPT_FAILED" },
      { at: days(-9), location: "Delivery address", note: "Delivered and signed for", code: "DELIVERED" },
    ],
    riskScore: 63, riskBand: "HIGH",
  });
  scenarios.push("ORD-DEMO003 — buyer has 2 rejected claims already; a thin claim here scores suspicious and goes to a human");

  /* ── Scenario 4: courier says delivered, nothing else corroborates ───
   * This is the honest-disagreement case. A NOT_DELIVERED claim on this order
   * sets conflicting_evidence, and the system refuses to guess.
   */
  const priya = byEmail.get("priya@example.in")!;
  const watch = PRODUCTS.find((p) => p.sku === "VJ-ELEC-203")!;
  const o4 = await Order.create({
    orderNo: "ORD-DEMO004",
    userId: priya._id,
    items: [{
      sku: watch.sku, title: watch.title, qty: 1, unitPriceInr: watch.priceInr,
      sellerId: watch.sellerId, policyId: watch.policyId, category: watch.category,
      brand: watch.brand, boxContents: watch.boxContents,
    }],
    amountInr: watch.priceInr,
    paymentMode: "PREPAID", paymentStatus: "PAID", status: "DELIVERED",
    address: {
      line: priya.addresses[0].line, landmark: priya.addresses[0].landmark,
      city: priya.addresses[0].city, state: priya.addresses[0].state,
      pincode: priya.addresses[0].pincode, pinTier: 1,
    },
    placedAt: days(-5), promisedBy: days(-2), deliveredAt: days(-1),
    buyerPriority: "money", buyerPriorRto: 0, stockAvailable: true,
  });
  await Shipment.create({
    shipmentId: "SHP-DEMO004", orderId: o4._id, courier: "Ekart",
    awb: `AWB${Math.floor(1e11 + Math.random() * 9e11)}`,
    dispatchedAt: days(-4), promisedBy: days(-2), attempts: 0, phoneReachable: true,
    status: "DELIVERED",
    scans: [
      { at: days(-5), location: "Seller warehouse", note: "Order received by the seller", code: "PLACED" },
      { at: days(-4), location: "Bengaluru hub", note: "Parcel collected by the courier", code: "DISPATCHED" },
      { at: days(-1), location: "Delivery address", note: "Delivered — left with security", code: "DELIVERED" },
    ],
    riskScore: 4, riskBand: "LOW",
  });
  scenarios.push("ORD-DEMO004 — courier recorded DELIVERED; a NOT_DELIVERED claim here conflicts and routes to HUMAN_HANDOFF");

  /* ── Scenario 5: out of window, so an honest no ──────────────────────── */
  const bedsheet = PRODUCTS.find((p) => p.sku === "VJ-HOME-401")!;
  const o5 = await Order.create({
    orderNo: "ORD-DEMO005",
    userId: priya._id,
    items: [{
      sku: bedsheet.sku, title: bedsheet.title, qty: 1, unitPriceInr: bedsheet.priceInr,
      sellerId: bedsheet.sellerId, policyId: bedsheet.policyId, category: bedsheet.category,
      brand: bedsheet.brand, boxContents: bedsheet.boxContents,
    }],
    amountInr: bedsheet.priceInr,
    paymentMode: "PREPAID", paymentStatus: "PAID", status: "DELIVERED",
    address: {
      line: priya.addresses[0].line, landmark: priya.addresses[0].landmark,
      city: priya.addresses[0].city, state: priya.addresses[0].state,
      pincode: priya.addresses[0].pincode, pinTier: 1,
    },
    placedAt: days(-40), promisedBy: days(-36), deliveredAt: days(-35),
    buyerPriority: "money", buyerPriorRto: 0, stockAvailable: true,
  });
  await Shipment.create({
    shipmentId: "SHP-DEMO005", orderId: o5._id, courier: "XpressBees",
    awb: `AWB${Math.floor(1e11 + Math.random() * 9e11)}`,
    dispatchedAt: days(-38), promisedBy: days(-36), attempts: 0, phoneReachable: true,
    status: "DELIVERED",
    scans: [
      { at: days(-40), location: "Seller warehouse", note: "Order received by the seller", code: "PLACED" },
      { at: days(-38), location: "Hyderabad hub", note: "Parcel collected by the courier", code: "DISPATCHED" },
      { at: days(-35), location: "Delivery address", note: "Delivered and signed for", code: "DELIVERED" },
    ],
    riskScore: 4, riskBand: "LOW",
  });
  scenarios.push("ORD-DEMO005 — delivered 35 days ago against a 10-day window: the engine returns an honest, clause-cited no");

  /* ── Scenario 6: delivered late, so store credit is the remedy ───────── */
  const bottle = PRODUCTS.find((p) => p.sku === "VJ-KITCH-503")!;
  const o6 = await Order.create({
    orderNo: "ORD-DEMO006",
    userId: arjun._id,
    items: [{
      sku: bottle.sku, title: bottle.title, qty: 2, unitPriceInr: bottle.priceInr,
      sellerId: bottle.sellerId, policyId: bottle.policyId, category: bottle.category,
      brand: bottle.brand, boxContents: bottle.boxContents,
    }],
    amountInr: bottle.priceInr * 2,
    paymentMode: "PREPAID", paymentStatus: "PAID", status: "DELIVERED",
    address: {
      line: arjun.addresses[0].line, landmark: arjun.addresses[0].landmark,
      city: arjun.addresses[0].city, state: arjun.addresses[0].state,
      pincode: arjun.addresses[0].pincode, pinTier: 1,
    },
    placedAt: days(-10), promisedBy: days(-6), deliveredAt: days(-2),
    buyerPriority: "money", buyerPriorRto: 0, stockAvailable: true,
  });
  await Shipment.create({
    shipmentId: "SHP-DEMO006", orderId: o6._id, courier: "Delhivery",
    awb: `AWB${Math.floor(1e11 + Math.random() * 9e11)}`,
    dispatchedAt: days(-9), promisedBy: days(-6), attempts: 2, phoneReachable: false,
    status: "DELIVERED",
    scans: [
      { at: days(-10), location: "Seller warehouse", note: "Order received by the seller", code: "PLACED" },
      { at: days(-9), location: "Kanpur hub", note: "Parcel collected by the courier", code: "DISPATCHED" },
      { at: days(-7), location: "Koramangala centre", note: "Delivery attempted; phone unreachable", code: "ATTEMPT_FAILED" },
      { at: days(-5), location: "Koramangala centre", note: "Delivery attempted; buyer not available", code: "ATTEMPT_FAILED" },
      { at: days(-2), location: "Delivery address", note: "Delivered, 4 days after the promised date", code: "DELIVERED" },
    ],
    riskScore: 45, riskBand: "MEDIUM",
  });
  scenarios.push(
    "ORD-DEMO006 — delivered 4 days late on a policy with no late compensation: an honest no",
  );

  /* ── Scenario 7: late, on a policy that does pay, where the cap binds ──
   * The electronics policy grants 5% store credit capped at Rs 200. On a
   * Rs 21,999 television, 5% is Rs 1,100 — so this is the order that proves
   * the cap is applied rather than merely declared.
   */
  const tv = PRODUCTS.find((p) => p.sku === "VJ-ELEC-205")!;
  const o7 = await Order.create({
    orderNo: "ORD-DEMO007",
    userId: priya._id,
    items: [{
      sku: tv.sku, title: tv.title, qty: 1, unitPriceInr: tv.priceInr,
      sellerId: tv.sellerId, policyId: tv.policyId, category: tv.category,
      brand: tv.brand, boxContents: tv.boxContents,
    }],
    amountInr: tv.priceInr,
    paymentMode: "PREPAID", paymentStatus: "PAID", status: "DELIVERED",
    address: {
      line: priya.addresses[0].line, landmark: priya.addresses[0].landmark,
      city: priya.addresses[0].city, state: priya.addresses[0].state,
      pincode: priya.addresses[0].pincode, pinTier: 1,
    },
    placedAt: days(-11), promisedBy: days(-7), deliveredAt: days(-2),
    buyerPriority: "money", buyerPriorRto: 0, stockAvailable: true,
  });
  await Shipment.create({
    shipmentId: "SHP-DEMO007", orderId: o7._id, courier: "BlueDart",
    awb: `AWB${Math.floor(1e11 + Math.random() * 9e11)}`,
    dispatchedAt: days(-10), promisedBy: days(-7), attempts: 1, phoneReachable: true,
    status: "DELIVERED",
    scans: [
      { at: days(-11), location: "Seller warehouse", note: "Order received by the seller", code: "PLACED" },
      { at: days(-10), location: "Bengaluru hub", note: "Parcel collected by the courier", code: "DISPATCHED" },
      { at: days(-8), location: "Delhi hub", note: "In transit", code: "IN_TRANSIT" },
      { at: days(-2), location: "Delivery address", note: "Delivered, 5 days after the promised date", code: "DELIVERED" },
    ],
    riskScore: 10, riskBand: "LOW",
  });
  scenarios.push(
    "ORD-DEMO007 — delivered 5 days late on a Rs 21,999 order: store credit capped at Rs 200",
  );

  /* ── Scenario 8: in flight, complete address, one failed attempt ─────
   *
   * The parcel the *reversible* rescue is for, and the only in-flight order
   * whose address is complete.
   *
   * Without it every rescue demo landed on ORD-DEMO001, where the missing
   * landmark is the dominant factor — so the intervention policy always chose
   * `ask_buyer` (gated) and the reversible `redirect_to_pickup` branch was
   * unreachable from the seed data. That made the more interesting half of the
   * authority story invisible: the agent acting alone, correctly, because the
   * action is reversible and moves no money.
   *
   * Priya's address has a landmark and is tier 2, the parcel is prepaid, and
   * the courier has already failed once. The only remaining lever is to stop
   * trying the door, which is exactly the action the RiskAgent may take alone.
   */
  const priyaRescue = byEmail.get("priya@example.in")!;
  const rescueItem = PRODUCTS.find((p) => p.sku === "VJ-HOME-401") ?? PRODUCTS[0];
  const o8 = await Order.create({
    orderNo: "ORD-DEMO008",
    userId: priyaRescue._id,
    items: [{
      sku: rescueItem.sku, title: rescueItem.title, qty: 1, unitPriceInr: rescueItem.priceInr,
      sellerId: rescueItem.sellerId, policyId: rescueItem.policyId, category: rescueItem.category,
      brand: rescueItem.brand, boxContents: rescueItem.boxContents,
    }],
    amountInr: rescueItem.priceInr,
    paymentMode: "PREPAID", paymentStatus: "PAID", status: "OUT_FOR_DELIVERY",
    address: {
      line: priyaRescue.addresses[0].line,
      landmark: priyaRescue.addresses[0].landmark,
      city: priyaRescue.addresses[0].city,
      state: priyaRescue.addresses[0].state,
      pincode: priyaRescue.addresses[0].pincode,
      // Tier 3 deliberately. The intervention policy only reroutes a parcel
      // that has actually reached MEDIUM risk, and a tier-2 prepaid parcel
      // with one failed attempt scores LOW — correctly, since one missed
      // doorstep is not yet a pattern. Tier 3 plus the failed attempt is the
      // cheapest fixture that reaches the reversible branch without inventing
      // a COD tag or a second failure that would change which action wins.
      pinTier: 3,
    },
    // Far enough out that the forecast does not declare the promise already
    // lost: the scenario is about the reversible redirect, not about a parcel
    // that can no longer make its date.
    placedAt: days(-4), promisedBy: days(9), deliveredAt: null,
    buyerPriority: "money", buyerPriorRto: 0, stockAvailable: true,
  });
  await Shipment.create({
    shipmentId: "SHP-DEMO008", orderId: o8._id, courier: "Delhivery",
    awb: `AWB${Math.floor(1e11 + Math.random() * 9e11)}`,
    dispatchedAt: days(-3), promisedBy: days(9),
    // The one failed attempt is the whole point of this fixture.
    attempts: 1, phoneReachable: true,
    status: "OUT_FOR_DELIVERY",
    scans: [
      { at: days(-4), location: "Seller warehouse", note: "Order received by the seller", code: "PLACED" },
      { at: days(-3), location: "Mumbai hub", note: "Parcel collected by the courier", code: "DISPATCHED" },
      { at: days(-1), location: "Local facility", note: "Out for delivery", code: "OUT_FOR_DELIVERY" },
      { at: days(-0.5), location: "Delivery address", note: "Buyer not available at the door", code: "ATTEMPT_FAILED" },
    ],
  });
  scenarios.push(
    "ORD-DEMO008 — in flight with a complete address and one failed attempt: " +
      "the rescue agent redirects it to a pickup point on its own, because that is reversible",
  );

  /* ── Backfill seller fulfilment counts ──────────────────────────────
   *
   * Every seller's defect rate is upheld claims over orders FULFILLED, and
   * that denominator is normally incremented when a parcel is delivered. The
   * seeded demo orders are written straight into their final state, so without
   * this the denominator is zero and the standing engine reports the absurd
   * "1 upheld claim in 0 orders".
   *
   * The counts are deliberately larger than the handful of demo orders: a
   * seller with three lifetime orders can never have a meaningful defect rate,
   * so each is given a plausible trading history. That is what makes a single
   * upheld claim move the rate by a believable amount rather than by 33%.
   */
  const TRADING_HISTORY: Record<string, number> = {
    "SEL-01": 180, "SEL-02": 240, "SEL-03": 95,
    "SEL-04": 140, "SEL-05": 210, "SEL-06": 120,
    "SEL-07": 310, "SEL-08": 420, "SEL-09": 160,
  };

  for (const [sellerId, orders] of Object.entries(TRADING_HISTORY)) {
    const seller = SELLERS.find((x) => x.sellerId === sellerId);
    if (!seller) continue;
    // Upheld claims consistent with the declared rate, so the observed and
    // declared numbers agree at the start and only real activity moves them.
    const upheld = Math.round((seller.defectRatePct / 100) * orders);
    await Seller.updateOne(
      { sellerId },
      { $set: { ordersFulfilled: orders, upheldClaims: upheld, listingStatus: "ACTIVE" } },
    );
  }

  await emit({
    type: "system.seeded",
    actor: "system",
    summary:
      `Seeded ${PRODUCTS.length} products, ${POLICIES.length} policies, ` +
      `${users.length} users and 6 demo orders`,
    payload: { scenarios },
  });

  return {
    sellers: SELLERS.length,
    policies: POLICIES.length,
    products: PRODUCTS.length,
    offers: OFFERS.length,
    users: users.length,
    // Counted, not hardcoded. These were literals and drifted the moment
    // ORD-DEMO008 was added for the rescue demo, so the setup output told
    // whoever ran it the wrong number.
    orders: await Order.countDocuments(),
    shipments: await Shipment.countDocuments(),
    scenarios,
    password: DEMO_PASSWORD,
  };
}
