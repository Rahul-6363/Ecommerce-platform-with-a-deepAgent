/**
 * The tool registry — the only way an agent touches the world.
 *
 * Three things happen here that cannot happen in a prompt:
 *
 *  1. **Mandate check.** The calling agent must hold the capability the tool
 *     requires, or the call is refused before any work is done.
 *  2. **Approval gate.** Tools in APPROVAL_REQUIRED return a `pending_approval`
 *     result instead of executing. The agent is told plainly that it must wait.
 *  3. **Audit.** Every call, allowed or refused, emits an event. The trace the
 *     operator reads is the same stream the agent actually walked.
 */
import { connectDb } from "@/lib/db/connect";
import { Cart, Claim, Order, Policy, Product, Seller, Shipment, User } from "@/models";
import type { LeanCart, LeanClaim, LeanOrder, LeanPolicy, LeanShipment, LeanUser } from "@/models";
import { checkEntitlement } from "@/lib/engines/entitlement";
import { riskScore, chooseIntervention } from "@/lib/engines/risk";
import { findOffers } from "@/lib/finder";
import type { Constraint } from "@/lib/engines/constraints";
import { assessAuthenticity } from "@/lib/engines/authenticity";
import { emit } from "@/lib/events";
import { APPROVAL_REQUIRED, BUYER_CONFIRM_REQUIRED, may, TOOL_CAPABILITY } from "@/lib/agent/mandate";
import { now } from "@/lib/clock";
import type { EvidenceFlags, IssueType } from "@/lib/types";
import type { ToolSchema } from "@/lib/groq/client";

/** How long an injected "slow" tool takes. Long enough to be visible. */
const SLOW_MS = 2500;

export type ToolContext = {
  userId: string;
  /** The agent making the call — checked against the mandate. */
  agent: string;
  sessionId?: string;
  /** Set by the demo controls to make a named tool fail, to prove replanning. */
  brokenTool?: string;
  /** Set to make a named tool slow rather than broken. */
  slowTool?: string;
};

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; code: "refused" | "pending_approval" | "not_found" | "failed" };

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

const str = (v: unknown, d = "") => (typeof v === "string" ? v.trim() : d);
const num = (v: unknown, d = 0) => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : d;
};
const bool = (v: unknown) => v === true || v === "true" || v === 1;

/* ──────────────────────────── Read tools ──────────────────────────── */

const searchCatalogue: Handler = async (args) => {
  await connectDb();
  const q = str(args.query);
  const category = str(args.category);
  const brand = str(args.brand);
  const maxPrice = num(args.max_price_inr, 0);
  const minPrice = num(args.min_price_inr, 0);
  const minRating = num(args.min_rating, 0);
  const inStockOnly = args.in_stock_only === undefined ? true : bool(args.in_stock_only);
  const limit = Math.min(Math.max(Math.trunc(num(args.limit, 6)), 1), 12);
  let unmatchedCategory = "";

  const filter: Record<string, unknown> = { active: true };
  // A category the catalogue does not have must not silently exclude
  // everything. A model passes the buyer's phrasing ("pressure cooker",
  // "running shoes") where the real value is "kitchen" or "footwear", and an
  // exact match then tells the buyer the product does not exist when it does.
  if (category) {
    const real = (await Product.distinct("category", { active: true })) as string[];
    const match =
      real.find((c) => c.toLowerCase() === category.toLowerCase()) ??
      real.find((c) => category.toLowerCase().includes(c.toLowerCase()));

    if (match) {
      filter.category = match;
    } else {
      // Unrecognised: fold it into the free-text query instead of filtering on
      // it, so "pressure cooker" still finds the pressure cooker.
      unmatchedCategory = category;
    }
  }
  if (brand) filter.brand = new RegExp(escapeRe(brand), "i");
  if (minRating > 0) filter.ratingAvg = { $gte: minRating };
  if (inStockOnly) filter.stock = { $gt: 0 };
  if (maxPrice > 0 || minPrice > 0) {
    filter.priceInr = {
      ...(minPrice > 0 ? { $gte: minPrice } : {}),
      ...(maxPrice > 0 ? { $lte: maxPrice } : {}),
    };
  }

  // Keyword retrieval over title/tags/brand/description. A regex OR beats a
  // text index here because the tags carry transliterated Hindi/Kannada/Tamil
  // words and we want partial matches on those, which $text will not give.
  const terms = [q, unmatchedCategory]
    .filter(Boolean)
    .join(" ")
    .split(/[\s,]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (terms.length) {
    filter.$or = terms.flatMap((t) => {
      const re = new RegExp(escapeRe(t), "i");
      return [{ title: re }, { tags: re }, { brand: re }, { description: re }, { subcategory: re }];
    });
  }

  const rows = await Product.find(filter)
    .sort({ ratingAvg: -1, ratingCount: -1 })
    .limit(limit)
    .lean();

  // Rank by how many distinct query terms a row actually matched, so "cheap
  // running shoes under 2000" puts running shoes above a random cheap item.
  const scored = rows
    .map((p) => {
      const hay = `${p.title} ${p.brand} ${p.subcategory} ${(p.tags ?? []).join(" ")} ${p.description}`.toLowerCase();
      const hits = terms.filter((t) => hay.includes(t.toLowerCase())).length;
      return { p, hits };
    })
    .sort((a, b) => b.hits - a.hits || (b.p.ratingAvg ?? 0) - (a.p.ratingAvg ?? 0));

  return {
    ok: true,
    data: {
      count: scored.length,
      query: { q, category, brand, minPrice, maxPrice, minRating },
      results: scored.map(({ p, hits }) => ({
        sku: p.sku,
        title: p.title,
        brand: p.brand,
        category: p.category,
        subcategory: p.subcategory,
        price_inr: p.priceInr,
        mrp_inr: p.mrpInr,
        discount_pct: p.mrpInr > 0 ? Math.round((1 - p.priceInr / p.mrpInr) * 100) : 0,
        rating: p.ratingAvg,
        rating_count: p.ratingCount,
        in_stock: (p.stock ?? 0) > 0,
        attributes: p.attributes ?? {},
        cod_eligible: p.codEligible,
        matched_terms: hits,
        description: String(p.description ?? "").slice(0, 220),
      })),
    },
  };
};

const getProduct: Handler = async (args) => {
  await connectDb();
  const p = await Product.findOne({ sku: str(args.sku) }).lean();
  if (!p) return { ok: false, error: `no product with sku ${str(args.sku)}`, code: "not_found" };
  const seller = await Seller.findOne({ sellerId: p.sellerId }).lean();
  return {
    ok: true,
    data: {
      sku: p.sku, title: p.title, brand: p.brand, category: p.category,
      price_inr: p.priceInr, mrp_inr: p.mrpInr, rating: p.ratingAvg,
      rating_count: p.ratingCount, in_stock: (p.stock ?? 0) > 0, stock: p.stock,
      attributes: p.attributes ?? {}, box_contents: p.boxContents ?? [],
      description: p.description, cod_eligible: p.codEligible,
      seller: seller ? { name: seller.name, city: seller.city, rating: seller.ratingAvg } : null,
    },
  };
};

const viewCart: Handler = async (_args, ctx) => {
  await connectDb();
  const cart = await Cart.findOne({ userId: ctx.userId }).lean<LeanCart>();
  const items = cart?.items ?? [];
  if (!items.length) return { ok: true, data: { items: [], total_inr: 0, count: 0 } };

  const skus = items.map((i) => i.sku);
  const products = await Product.find({ sku: { $in: skus } }).lean();
  const bySku = new Map(products.map((p) => [p.sku, p]));

  const lines = items
    .map((i) => {
      const p = bySku.get(i.sku);
      if (!p) return null;
      return {
        sku: i.sku, title: p.title, qty: i.qty,
        unit_price_inr: p.priceInr, line_total_inr: p.priceInr * i.qty,
        in_stock: (p.stock ?? 0) >= i.qty,
        added_by_agent: i.addedByAgent, rationale: i.agentRationale,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return {
    ok: true,
    data: {
      items: lines,
      count: lines.reduce((s, l) => s + l.qty, 0),
      total_inr: lines.reduce((s, l) => s + l.line_total_inr, 0),
    },
  };
};

const getBuyerProfile: Handler = async (_args, ctx) => {
  await connectDb();
  const u = await User.findById(ctx.userId).lean<LeanUser>();
  if (!u) return { ok: false, error: "buyer not found", code: "not_found" };
  const orderCount = await Order.countDocuments({ userId: ctx.userId });
  const addr = (u.addresses ?? [])[0];
  return {
    ok: true,
    data: {
      name: u.name, lang: u.lang, priority: u.priority,
      store_credit_inr: u.storeCreditInr,
      default_address: addr
        ? { line: addr.line, landmark: addr.landmark, city: addr.city, pincode: addr.pincode, pin_tier: addr.pinTier }
        : null,
      order_count: orderCount,
      total_claims: u.totalClaims, rejected_claims: u.rejectedClaims, prior_rto: u.priorRto,
    },
  };
};

const listMyOrders: Handler = async (args, ctx) => {
  await connectDb();
  const limit = Math.min(Math.max(Math.trunc(num(args.limit, 5)), 1), 20);
  const rows = await Order.find({ userId: ctx.userId }).sort({ createdAt: -1 }).limit(limit).lean<LeanOrder[]>();
  return {
    ok: true,
    data: rows.map((o) => ({
      order_no: o.orderNo, status: o.status, amount_inr: o.amountInr,
      payment_mode: o.paymentMode,
      placed_at: o.placedAt?.toISOString(),
      promised_by: o.promisedBy?.toISOString(),
      delivered_at: o.deliveredAt ? o.deliveredAt.toISOString() : null,
      items: o.items.map((i) => ({ sku: i.sku, title: i.title, qty: i.qty })),
    })),
  };
};

const getOrder: Handler = async (args, ctx) => {
  await connectDb();
  const o = await Order.findOne({ orderNo: str(args.order_no) }).lean<LeanOrder>();
  if (!o) return { ok: false, error: `no order ${str(args.order_no)}`, code: "not_found" };
  // A buyer may only read their own order; the agent runs as the buyer.
  if (String(o.userId) !== String(ctx.userId) && ctx.agent !== "TrackerAgent") {
    return { ok: false, error: "that order belongs to a different buyer", code: "refused" };
  }
  return {
    ok: true,
    data: {
      order_no: o.orderNo, status: o.status, amount_inr: o.amountInr,
      payment_mode: o.paymentMode, payment_status: o.paymentStatus,
      placed_at: o.placedAt?.toISOString(), promised_by: o.promisedBy?.toISOString(),
      delivered_at: o.deliveredAt ? o.deliveredAt.toISOString() : null,
      address: o.address, buyer_priority: o.buyerPriority,
      stock_available: o.stockAvailable,
      items: o.items.map((i) => ({
        sku: i.sku, title: i.title, qty: i.qty, unit_price_inr: i.unitPriceInr,
        category: i.category, brand: i.brand, policy_id: i.policyId,
        box_contents: i.boxContents,
      })),
    },
  };
};

const getTracking: Handler = async (args) => {
  await connectDb();
  const order = await Order.findOne({ orderNo: str(args.order_no) }).lean<LeanOrder>();
  if (!order) return { ok: false, error: `no order ${str(args.order_no)}`, code: "not_found" };
  const s = await Shipment.findOne({ orderId: order._id }).lean<LeanShipment>();
  if (!s) return { ok: false, error: "no shipment raised for that order yet", code: "not_found" };
  return {
    ok: true,
    data: {
      shipment_id: s.shipmentId, courier: s.courier, awb: s.awb, status: s.status,
      attempts: s.attempts, phone_reachable: s.phoneReachable,
      dispatched_at: s.dispatchedAt ? s.dispatchedAt.toISOString() : null,
      promised_by: s.promisedBy?.toISOString(),
      scans: (s.scans ?? []).map((x) => ({
        at: x.at?.toISOString(), location: x.location, note: x.note, code: x.code,
      })),
      risk_score: s.riskScore, risk_band: s.riskBand,
    },
  };
};

const getPolicy: Handler = async (args) => {
  await connectDb();
  let id = str(args.policy_id);
  const category = str(args.category);
  const orderNo = str(args.order_no);

  // Asking for "the policy for this order" is the natural way to want this,
  // and it is what a planner reaches for, so resolve it rather than refusing.
  if (!id && !category && orderNo) {
    const order = await Order.findOne({ orderNo }).lean<LeanOrder>();
    if (!order) return { ok: false, error: `no order ${orderNo}`, code: "not_found" };
    id = order.items[0]?.policyId ?? "";
  }

  const p = id
    ? await Policy.findOne({ policyId: id }).lean<LeanPolicy>()
    : category
      ? await Policy.findOne({ category: new RegExp(`^${escapeRe(category)}$`, "i") }).lean<LeanPolicy>()
      : null;

  if (!p) {
    return {
      ok: false,
      code: "not_found",
      error:
        "no policy matched — pass policy_id, category, or order_no to look it up " +
        "from the order",
    };
  }
  return {
    ok: true,
    data: {
      policy_id: p.policyId, category: p.category,
      return_window_days: p.returnWindowDays,
      replacement_allowed: p.replacementAllowed,
      refund_sla_days: p.refundSlaDays,
      late_compensation: p.lateCompensation,
      clauses: p.clauses,
    },
  };
};

/* ──────────────────────────── Engine tools ──────────────────────────── */

const checkEntitlementTool: Handler = async (args) => {
  await connectDb();
  const order = await Order.findOne({ orderNo: str(args.order_no) }).lean<LeanOrder>();
  if (!order) return { ok: false, error: `no order ${str(args.order_no)}`, code: "not_found" };

  const item = order.items[0];
  const policy = await Policy.findOne({ policyId: item.policyId }).lean<LeanPolicy>();
  if (!policy) return { ok: false, error: `policy ${item.policyId} missing`, code: "not_found" };

  const verdict = checkEntitlement(
    {
      amountInr: order.amountInr,
      deliveredAt: order.deliveredAt,
      promisedBy: order.promisedBy,
      stockAvailable: order.stockAvailable,
      buyerPriority: order.buyerPriority as "speed" | "money",
    },
    {
      returnWindowDays: policy.returnWindowDays,
      replacementAllowed: policy.replacementAllowed,
      refundSlaDays: policy.refundSlaDays,
      lateCompensation: policy.lateCompensation,
      clauses: policy.clauses as { id: string; text: string; tags: string[] }[],
    },
    str(args.issue_type),
    (args.evidence_flags ?? {}) as EvidenceFlags,
    await now(),
  );

  return { ok: true, data: verdict };
};

/**
 * The constraint solver, as a tool.
 *
 * This exists so the conversational agent answers "a cooker for my induction
 * hob under 2000 that arrives before the 28th" the same way the /find page
 * does — by enforcing the constraints in code and reporting the rejections —
 * rather than by eyeballing a search result and hoping.
 *
 * The model's job here is to translate the buyer's sentence into the
 * `constraints` array. It does not decide what qualifies, and it cannot
 * compute a cost or a date: those come back from the pure engines.
 */
const solveConstraintsTool: Handler = async (args, ctx) => {
  await connectDb();

  const raw = Array.isArray(args.constraints) ? args.constraints : [];
  if (raw.length === 0) {
    return {
      ok: false,
      code: "failed",
      error:
        "pass at least one constraint — a category, a budget, a required " +
        "attribute, a rating, a date, or in_stock",
    };
  }

  const user = await User.findById(ctx.userId).lean<LeanUser>();
  const address = (user?.addresses ?? [])[0];

  const result = await findOffers({
    constraints: raw as Constraint[],
    buyer: {
      pinTier: address?.pinTier ?? 2,
      priorRto: user?.priorRto ?? 0,
      paymentMode: str(args.payment_mode) === "COD" ? "COD" : "PREPAID",
    },
    query: str(args.query),
    now: await now(),
  });

  // Returned compactly: the full solve carries every cost line and forecast
  // reason, which the model does not need and which is re-sent on every later
  // step of the loop.
  return {
    ok: true,
    data: {
      headline: result.headline,
      constraints: result.constraints.map((c) => c.text),
      satisfied: result.satisfied.slice(0, 4).map((o) => ({
        sku: o.candidate.sku,
        title: o.candidate.title,
        seller: o.candidate.seller.name,
        sticker_inr: o.candidate.priceInr,
        true_cost_inr: o.cost.expectedTotalInr,
        likely_arrival: o.forecast.likelyAt.slice(0, 10),
        confident_arrival: o.forecast.confidentAt.slice(0, 10),
        confidence_pct: o.forecast.confidencePct,
        meets_deadline: o.forecast.deadline?.verdict ?? null,
        why_ranked: o.rankReason,
        satisfies: o.satisfied.map((s) => `${s.constraint} (${s.evidence})`),
      })),
      rejected_count: result.rejected.length,
      // The tally, not every row: this is what the buyer is told.
      rejection_summary: result.rejectionSummary.map(
        (r) => `${r.count} failed ${r.constraint}`,
      ),
      relaxation: result.relaxation?.sentence ?? null,
    },
  };
};

const riskScoreTool: Handler = async (args) => {
  await connectDb();
  const order = await Order.findOne({ orderNo: str(args.order_no) }).lean<LeanOrder>();
  if (!order) return { ok: false, error: `no order ${str(args.order_no)}`, code: "not_found" };
  const shipment = await Shipment.findOne({ orderId: order._id }).lean<LeanShipment>();
  if (!shipment) return { ok: false, error: "no shipment for that order", code: "not_found" };

  const verdict = riskScore(
    {
      orderNo: order.orderNo, paymentMode: order.paymentMode,
      category: order.items[0]?.category, buyerPriorRto: order.buyerPriorRto,
      address: order.address,
    },
    {
      shipmentId: shipment.shipmentId, attempts: shipment.attempts,
      phoneReachable: shipment.phoneReachable,
    },
  );

  await Shipment.updateOne(
    { _id: shipment._id },
    { $set: { riskScore: verdict.score, riskBand: verdict.band } },
  );

  const intervention = chooseIntervention(
    {
      orderNo: order.orderNo, paymentMode: order.paymentMode,
      category: order.items[0]?.category, buyerPriorRto: order.buyerPriorRto,
      address: order.address,
    },
    { shipmentId: shipment.shipmentId, attempts: shipment.attempts, phoneReachable: shipment.phoneReachable },
    verdict,
  );

  await emit({
    type: "risk.scored",
    actor: "RiskAgent",
    summary: `Scored ${shipment.shipmentId}: ${verdict.score}/100 (${verdict.band})`,
    payload: { verdict, intervention },
    orderId: order._id,
    userId: order.userId,
  });

  if (intervention) {
    await emit({
      type: "risk.intervention_proposed",
      actor: "RiskAgent",
      summary: `Proposes ${intervention.action} — ${intervention.expectedEffect}`,
      payload: intervention,
      orderId: order._id,
      userId: order.userId,
    });
  } else {
    await emit({
      type: "risk.intervention_declined",
      actor: "RiskAgent",
      summary: `Band ${verdict.band}: no intervention is warranted, so none is proposed`,
      payload: { score: verdict.score, band: verdict.band },
      orderId: order._id,
      userId: order.userId,
    });
  }

  return { ok: true, data: { ...verdict, intervention } };
};

const assessAuthenticityTool: Handler = async (args) => {
  await connectDb();
  const claim = await Claim.findOne({ claimNo: str(args.claim_no) }).lean<LeanClaim>();
  if (!claim) return { ok: false, error: `no claim ${str(args.claim_no)}`, code: "not_found" };
  const order = await Order.findById(claim.orderId).lean<LeanOrder>();
  const buyer = await User.findById(claim.userId).lean<LeanUser>();
  if (!order || !buyer) return { ok: false, error: "claim is missing its order or buyer", code: "not_found" };

  const seller = await Seller.findOne({ sellerId: order.items[0]?.sellerId }).lean();
  const policy = await Policy.findOne({ policyId: order.items[0]?.policyId }).lean<LeanPolicy>();
  const nowAt = await now();

  const minutesSinceDelivery = order.deliveredAt
    ? (nowAt.getTime() - order.deliveredAt.getTime()) / 60_000
    : null;

  const windowFraction =
    order.deliveredAt && policy
      ? (nowAt.getTime() - order.deliveredAt.getTime()) /
        (policy.returnWindowDays * 86_400_000)
      : null;

  const orderCount = await Order.countDocuments({ userId: claim.userId });

  const assessment = assessAuthenticity({
    issueType: (claim.issueType ?? "DAMAGED") as IssueType,
    evidenceFlags: (claim.evidenceFlags ?? {}) as EvidenceFlags,
    hasImage: (claim.evidence ?? []).some((e) => e.kind === "image"),
    minutesSinceDelivery,
    windowFraction,
    orderAmountInr: order.amountInr,
    buyerTotalClaims: buyer.totalClaims ?? 0,
    buyerRejectedClaims: buyer.rejectedClaims ?? 0,
    buyerOrderCount: orderCount,
    sellerDefectRatePct: seller?.defectRatePct ?? 0,
  });

  await Claim.updateOne({ _id: claim._id }, { $set: { authenticity: assessment } });
  await emit({
    type: "claim.authenticity_assessed",
    actor: "FraudAnalyst",
    summary: `${assessment.verdict.replace(/_/g, " ")} — suspicion ${assessment.score}/100`,
    payload: assessment,
    claimId: claim._id,
    orderId: order._id,
    userId: claim.userId,
  });

  return { ok: true, data: assessment };
};

/* ──────────────────────────── Cart tools ──────────────────────────── */

const addToCart: Handler = async (args, ctx) => {
  await connectDb();
  const sku = str(args.sku);
  const qty = Math.min(Math.max(Math.trunc(num(args.qty, 1)), 1), 10);
  const rationale = str(args.rationale).slice(0, 400);

  const p = await Product.findOne({ sku, active: true }).lean();
  if (!p) return { ok: false, error: `no product with sku ${sku}`, code: "not_found" };
  if ((p.stock ?? 0) < qty) {
    return { ok: false, error: `only ${p.stock ?? 0} left of ${p.title}`, code: "failed" };
  }

  const cart = await Cart.findOneAndUpdate(
    { userId: ctx.userId },
    { $setOnInsert: { userId: ctx.userId, items: [] } },
    { upsert: true, returnDocument: "after" },
  );

  const existing = cart.items.find((i: { sku: string; qty: number }) => i.sku === sku);
  if (existing) existing.qty = Math.min(existing.qty + qty, 10);
  else cart.items.push({ sku, qty, addedByAgent: ctx.agent === "ShoppingAgent", agentRationale: rationale });
  await cart.save();

  await emit({
    type: "cart.item_added",
    actor: ctx.agent,
    summary: `Added ${p.title} × ${qty} — ${rationale || "no rationale given"}`,
    payload: { sku, qty, title: p.title, price_inr: p.priceInr, rationale },
    userId: ctx.userId,
    sessionId: ctx.sessionId,
  });

  return {
    ok: true,
    data: {
      added: { sku, title: p.title, qty, unit_price_inr: p.priceInr },
      cart_total_inr: await cartTotal(ctx.userId),
    },
  };
};

const removeFromCart: Handler = async (args, ctx) => {
  await connectDb();
  const sku = str(args.sku);
  const cart = await Cart.findOne({ userId: ctx.userId });
  if (!cart) return { ok: false, error: "the cart is already empty", code: "not_found" };
  const before = cart.items.length;
  cart.items = cart.items.filter((i: { sku: string }) => i.sku !== sku);
  if (cart.items.length === before) {
    return { ok: false, error: `${sku} is not in the cart`, code: "not_found" };
  }
  await cart.save();
  await emit({
    type: "cart.item_removed",
    actor: ctx.agent,
    summary: `Removed ${sku} from the cart`,
    payload: { sku },
    userId: ctx.userId,
    sessionId: ctx.sessionId,
  });
  return { ok: true, data: { removed: sku, cart_total_inr: await cartTotal(ctx.userId) } };
};

async function cartTotal(userId: string): Promise<number> {
  const cart = await Cart.findOne({ userId }).lean<LeanCart>();
  if (!cart?.items?.length) return 0;
  const products = await Product.find({ sku: { $in: cart.items.map((i) => i.sku) } }).lean();
  const bySku = new Map(products.map((p) => [p.sku, p.priceInr]));
  return cart.items.reduce((s, i) => s + (bySku.get(i.sku) ?? 0) * i.qty, 0);
}

/* ─────────────── Courier tools (reversible: no approval) ─────────────── */

const rescheduleDelivery: Handler = async (args) => {
  await connectDb();
  const s = await Shipment.findOne({ shipmentId: str(args.shipment_id) });
  if (!s) return { ok: false, error: "no such shipment", code: "not_found" };
  const nowAt = await now();
  const newDate = new Date(nowAt.getTime() + Math.max(1, num(args.days, 1)) * 86_400_000);
  s.promisedBy = newDate;
  s.scans.push({ at: nowAt, location: "Hub", note: "Delivery rescheduled by the platform agent", code: "RESCHEDULED" });
  await s.save();
  await emit({
    type: "shipment.scan",
    actor: "RiskAgent",
    summary: `Rescheduled ${s.shipmentId} to ${newDate.toDateString()}`,
    payload: { shipment_id: s.shipmentId, promised_by: newDate.toISOString() },
    orderId: s.orderId,
  });
  return { ok: true, data: { shipment_id: s.shipmentId, promised_by: newDate.toISOString() } };
};

/**
 * Where a redirected parcel actually goes, by pincode tier.
 *
 * Named and distance-tagged because "redirected to a pickup point" is not
 * actionable for a buyer — they need to know it is the post office counter two
 * kilometres away, not an abstraction.
 */
const PICKUP_POINTS: Record<number, string> = {
  1: "Vaanijya Hub, 100ft Road (0.8 km)",
  2: "Partner Store, Main Market (1.4 km)",
  3: "Post Office Counter, Town Centre (2.1 km)",
  4: "Panchayat Service Point (3.6 km)",
};

const redirectToPickup: Handler = async (args) => {
  await connectDb();
  const s = await Shipment.findOne({ shipmentId: str(args.shipment_id) });
  if (!s) return { ok: false, error: "no such shipment", code: "not_found" };
  const nowAt = await now();
  const order = await Order.findById(s.orderId).lean<LeanOrder>();
  const point = PICKUP_POINTS[order?.address?.pinTier ?? 2] ?? PICKUP_POINTS[2];

  s.status = "AT_PICKUP_POINT";
  s.scans.push({
    at: nowAt,
    location: point,
    note: `Diverted to pickup point: ${point}. Held 5 days; removes the remaining doorstep attempts.`,
    code: "REDIRECTED",
  });
  await s.save();
  await emit({
    type: "shipment.redirected",
    actor: "RiskAgent",
    summary: `Redirected ${s.shipmentId} to ${point}`,
    payload: { shipment_id: s.shipmentId, pickup_point: point, hold_days: 5 },
    orderId: s.orderId,
  });
  return {
    ok: true,
    data: { shipment_id: s.shipmentId, status: s.status, pickup_point: point, hold_days: 5 },
  };
};

const holdShipment: Handler = async (args) => {
  await connectDb();
  const s = await Shipment.findOne({ shipmentId: str(args.shipment_id) });
  if (!s) return { ok: false, error: "no such shipment", code: "not_found" };
  const nowAt = await now();
  s.status = "HELD";
  s.scans.push({ at: nowAt, location: "Hub", note: str(args.reason) || "Held pending buyer contact", code: "HELD" });
  await s.save();
  await emit({
    type: "shipment.held",
    actor: "RiskAgent",
    summary: `Held ${s.shipmentId}: ${str(args.reason) || "pending buyer contact"}`,
    payload: { shipment_id: s.shipmentId, reason: str(args.reason) },
    orderId: s.orderId,
  });
  return { ok: true, data: { shipment_id: s.shipmentId, status: s.status } };
};

const scheduleFollowup: Handler = async (args, ctx) => {
  await connectDb();
  const when = new Date((await now()).getTime() + Math.max(1, num(args.hours, 24)) * 3_600_000);
  await emit({
    type: "claim.opened",
    actor: ctx.agent,
    summary: `Follow-up scheduled for ${when.toISOString()}: ${str(args.reason)}`,
    payload: { at: when.toISOString(), reason: str(args.reason) },
    userId: ctx.userId,
  });
  return { ok: true, data: { scheduled_at: when.toISOString() } };
};

/* ──────────────────────────── The registry ──────────────────────────── */

const HANDLERS: Record<string, Handler> = {
  search_catalogue: searchCatalogue,
  get_product: getProduct,
  get_order: getOrder,
  get_tracking: getTracking,
  get_policy: getPolicy,
  get_buyer_profile: getBuyerProfile,
  list_my_orders: listMyOrders,
  view_cart: viewCart,
  check_entitlement: checkEntitlementTool,
  solve_constraints: solveConstraintsTool,
  risk_score: riskScoreTool,
  assess_authenticity: assessAuthenticityTool,
  add_to_cart: addToCart,
  remove_from_cart: removeFromCart,
  reschedule_delivery: rescheduleDelivery,
  redirect_to_pickup: redirectToPickup,
  hold_shipment: holdShipment,
  schedule_followup: scheduleFollowup,
};

/**
 * Call a tool. This is the chokepoint: mandate, gate and audit all happen here,
 * so no agent path can skip them.
 */
export async function callTool(
  tool: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // 1. Does the tool exist?
  if (!(tool in TOOL_CAPABILITY)) {
    return { ok: false, error: `there is no tool named ${tool}`, code: "not_found" };
  }

  // 2. Mandate. Checked before any work, and audited when refused.
  if (!may(ctx.agent, tool)) {
    const msg = `${ctx.agent} does not hold the ${TOOL_CAPABILITY[tool]} capability that ${tool} requires`;
    await emit({
      type: "agent.tool_call",
      actor: ctx.agent,
      summary: `REFUSED ${tool} — ${msg}`,
      payload: { tool, args, refused: true, reason: msg },
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    });
    return { ok: false, error: msg, code: "refused" };
  }

  // 3. The approval gate. These never execute from an agent turn.
  if (APPROVAL_REQUIRED.has(tool)) {
    await emit({
      type: "claim.approval_requested",
      actor: ctx.agent,
      summary: `${tool} requires operator approval and is waiting at the gate`,
      payload: { tool, args },
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    });
    return {
      ok: false,
      code: "pending_approval",
      error:
        `${tool} moves money or leaves the platform, so it stops at the approval ` +
        `gate. It has been queued for a human operator. Tell the buyer it is ` +
        `awaiting review — do not claim it has happened.`,
    };
  }

  // 4. The buyer, not an operator, confirms spending their own money.
  if (BUYER_CONFIRM_REQUIRED.has(tool)) {
    // Recorded, like the capability refusal above it. An agent that tried to
    // order on someone's behalf and was stopped is exactly the thing an audit
    // trail exists to show — and without this the gate worked silently, which
    // is indistinguishable from the agent never having tried.
    await emit({
      type: "agent.tool_call",
      actor: ctx.agent,
      summary: `REFUSED ${tool} — only the buyer can place an order`,
      payload: { tool, args, refused: true, reason: "buyer confirmation required" },
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    });
    return {
      ok: false,
      code: "pending_approval",
      error:
        "place_order requires the buyer to press Place order themselves. Summarise " +
        "the cart and the total, and ask them to confirm.",
    };
  }

  // 5a. Chaos: a slow tool. Not a failure, so it does not trigger a replan —
  // it exercises the latency and budget handling instead.
  if (ctx.slowTool === tool) {
    await emit({
      type: "system.tool_failed",
      actor: "system",
      summary: `Injected latency: ${tool} is responding slowly`,
      payload: { tool, mode: "slow", delayMs: SLOW_MS },
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    });
    await new Promise((r) => setTimeout(r, SLOW_MS));
  }

  // 5b. Chaos injection, so the replanning path is demonstrable.
  if (ctx.brokenTool && ctx.brokenTool === tool) {
    await emit({
      type: "system.tool_failed",
      actor: "system",
      summary: `Injected failure: ${tool} is unavailable`,
      payload: { tool },
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    });
    return { ok: false, error: `${tool} is unavailable (injected failure)`, code: "failed" };
  }

  // 6. Run it.
  const started = Date.now();
  let result: ToolResult;
  try {
    result = await HANDLERS[tool](args, ctx);
  } catch (err) {
    result = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: "failed",
    };
  }

  await emit({
    type: "agent.tool_call",
    actor: ctx.agent,
    summary: result.ok
      ? `${tool} ok (${Date.now() - started}ms)`
      : `${tool} failed: ${result.error}`,
    payload: { tool, args, ok: result.ok, ms: Date.now() - started, result: result.ok ? result.data : result.error },
    userId: ctx.userId,
    sessionId: ctx.sessionId,
  });

  return result;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ───────────────── Tool schemas handed to the model ───────────────── */

const S = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolSchema => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const SHOPPING_TOOLS: ToolSchema[] = [
  S(
    "search_catalogue",
    "Search the product catalogue. Use the buyer's own words as the query — the " +
      "catalogue is tagged with transliterated Hindi, Kannada and Tamil terms, so " +
      "'sasta joota' or 'chappal' will match. Always call this before recommending anything.",
    {
      query: { type: "string", description: "Keywords from what the buyer asked for" },
      category: { type: "string", description: "Exact category filter, e.g. footwear, electronics" },
      brand: { type: "string" },
      min_price_inr: { type: "number" },
      max_price_inr: { type: "number", description: "Hard budget ceiling in rupees" },
      min_rating: { type: "number", description: "0..5" },
      in_stock_only: { type: "boolean", description: "Defaults to true" },
      limit: { type: "number", description: "1..12, default 6" },
    },
    ["query"],
  ),
  S("get_product", "Full detail on one product, including box contents and seller.", {
    sku: { type: "string" },
  }, ["sku"]),
  S(
    "solve_constraints",
    "THE CONSTRAINT SOLVER. Use this instead of search_catalogue whenever the buyer " +
      "states conditions that must ALL hold — a budget, a required spec, a delivery " +
      "date, a rating, in-stock, cash on delivery. It returns only offers satisfying " +
      "every constraint, each with its true cost (sticker + COD fee + delivery + the " +
      "seller's priced-in failure rate) and a delivery interval, plus a tally of why " +
      "the rest were rejected. Report its rejection_summary to the buyer — that is the " +
      "most useful part. Never compute a cost or a date yourself; quote these.",
    {
      query: {
        type: "string",
        description: "The product words only, e.g. 'pressure cooker'. No budget or date.",
      },
      payment_mode: { type: "string", enum: ["COD", "PREPAID"] },
      constraints: {
        type: "array",
        description:
          "Every condition the buyer stated. Each item is one of: " +
          "{kind:'category',value:'kitchen'} | {kind:'max_price',value:2000} | " +
          "{kind:'min_price',value:500} | {kind:'brand',value:'Ganga'} | " +
          "{kind:'min_rating',value:4} | {kind:'in_stock',value:true} | " +
          "{kind:'attribute',key:'induction',value:true} | " +
          "{kind:'attribute',key:'capacity_l',value:5} (a number means at most) | " +
          "{kind:'arrive_by',value:'2026-10-28'} | " +
          "{kind:'payment_mode',value:'COD'} | {kind:'max_true_cost',value:2000} | " +
          "{kind:'max_seller_defect_rate',value:5}",
        items: { type: "object" },
      },
    },
    ["constraints"],
  ),
  S("get_buyer_profile", "The buyer's name, language, default address, order history and claim history.", {}),
  S(
    "add_to_cart",
    "Put a product in the buyer's cart. Always pass a rationale explaining which " +
      "of their stated requirements this satisfies — it is shown to them.",
    {
      sku: { type: "string" },
      qty: { type: "number", description: "1..10, default 1" },
      rationale: { type: "string", description: "Why this product meets what they asked for" },
    },
    ["sku", "rationale"],
  ),
  S("remove_from_cart", "Take a product out of the cart.", { sku: { type: "string" } }, ["sku"]),
  S("view_cart", "What is currently in the cart, with the total.", {}),
  S("list_my_orders", "The buyer's recent orders and their delivery status.", {
    limit: { type: "number" },
  }),
  S("get_order", "One order by its number.", { order_no: { type: "string" } }, ["order_no"]),
  S("get_tracking", "Courier scans and delivery status for an order.", {
    order_no: { type: "string" },
  }, ["order_no"]),
];

export const CLAIM_TOOLS: ToolSchema[] = [
  S("get_order", "The order a complaint is about.", { order_no: { type: "string" } }, ["order_no"]),
  S("get_tracking", "Courier scans — use this to check whether the record supports the complaint.", {
    order_no: { type: "string" },
  }, ["order_no"]),
  S(
    "get_policy",
    "The returns policy and its clauses. Pass order_no to look up the policy " +
      "that governs that order, or policy_id / category directly.",
    {
      order_no: { type: "string", description: "Resolve the policy from this order" },
      policy_id: { type: "string" },
      category: { type: "string" },
    },
  ),
  S("get_buyer_profile", "The buyer's claim history — relevant to how much corroboration is needed.", {}),
  S(
    "check_entitlement",
    "THE RULE ENGINE. Returns eligibility, remedy, amount and deadline. You must " +
      "call this and you must not compute any of those four values yourself.",
    {
      order_no: { type: "string" },
      issue_type: {
        type: "string",
        enum: ["NOT_DELIVERED", "DOA", "DAMAGED", "WRONG_ITEM", "MISSING_PART", "COUNTERFEIT", "NOT_AS_DESCRIBED", "LATE"],
      },
      evidence_flags: { type: "object", description: "Boolean flags you established during triage" },
    },
    ["order_no", "issue_type"],
  ),
];
