/**
 * Delivery-risk engine — pure, additive, clamped to [0,100].
 *
 * Explainability is the point: every point of the score traces to a named
 * factor with a sentence a human can argue with. No model, no clock, no I/O.
 */
import type { RiskBand, RiskReason, RiskVerdict } from "@/lib/types";

const PIN_TIER_POINTS: Record<number, number> = { 4: 25, 3: 20, 2: 10, 1: 0 };
const CATEGORY_POINTS: Record<string, number> = {
  footwear: 12, fashion: 10, apparel: 10, electronics: 4,
  home: 4, kitchen: 4, beauty: 6, books: 0, grocery: 2,
};
const ATTEMPT_POINTS = 15;
const ATTEMPT_CAP = 30;
const HISTORY_POINTS = 15;
const HISTORY_CAP = 25;
const COD_POINTS = 30;
const ADDRESS_POINTS = 20;
const PHONE_POINTS = 15;
const ADDRESS_MIN_LEN = 25;

const HIGH = 60;
const MEDIUM = 30;

export type RiskOrder = {
  orderNo?: string;
  paymentMode?: string;
  category?: string;
  buyerPriorRto?: number;
  address?: { line?: string; landmark?: string; pinTier?: number };
};

export type RiskShipment = {
  shipmentId?: string;
  attempts?: number;
  phoneReachable?: boolean;
};

export function riskScore(order: RiskOrder, shipment: RiskShipment): RiskVerdict {
  const reasons: RiskReason[] = [];
  const add = (factor: string, points: number, detail = "") => {
    if (points) reasons.push({ factor, points, detail });
  };

  if ((order.paymentMode ?? "").toUpperCase() === "COD") {
    add("payment_mode", COD_POINTS, "cash on delivery can be refused at the door");
  }

  const tier = order.address?.pinTier ?? 2;
  add("pin_tier", PIN_TIER_POINTS[tier] ?? 0, `pincode tier ${tier}`);

  const line = (order.address?.line ?? "").trim();
  const landmark = (order.address?.landmark ?? "").trim();
  if (!landmark || line.length < ADDRESS_MIN_LEN) {
    add(
      "address_quality",
      ADDRESS_POINTS,
      !landmark ? "no landmark recorded" : `address only ${line.length} characters`,
    );
  }

  const attempts = Math.trunc(shipment.attempts ?? 0);
  add(
    "failed_attempts",
    Math.min(attempts * ATTEMPT_POINTS, ATTEMPT_CAP),
    `${attempts} failed delivery attempt(s)`,
  );

  if (shipment.phoneReachable === false) {
    add("phone_reachable", PHONE_POINTS, "courier could not reach the buyer by phone");
  }

  const cat = (order.category ?? "").toLowerCase();
  add("category_base_rate", CATEGORY_POINTS[cat] ?? 0, `${cat || "unknown"} category base failure rate`);

  const prior = Math.trunc(order.buyerPriorRto ?? 0);
  add(
    "buyer_history",
    Math.min(prior * HISTORY_POINTS, HISTORY_CAP),
    `${prior} prior return-to-origin by this buyer`,
  );

  const score = Math.max(0, Math.min(reasons.reduce((s, r) => s + r.points, 0), 100));
  const band: RiskBand = score >= HIGH ? "HIGH" : score >= MEDIUM ? "MEDIUM" : "LOW";
  reasons.sort((a, b) => b.points - a.points);

  return { shipmentId: shipment.shipmentId, orderId: order.orderNo, score, band, reasons };
}

export type Intervention = {
  action: string;
  needsApproval: boolean;
  args: Record<string, unknown>;
  expectedEffect: string;
};

/**
 * Intervention policy — deterministic, highest priority first.
 *
 * Returning null for a LOW band is deliberate: an agent that declines to act
 * when action is unwarranted is the behaviour we want, and the UI says so.
 */
export function chooseIntervention(
  order: RiskOrder,
  shipment: RiskShipment,
  verdict: RiskVerdict,
): Intervention | null {
  const factors = new Set(verdict.reasons.map((r) => r.factor));
  const attempts = Math.trunc(shipment.attempts ?? 0);
  const cod = (order.paymentMode ?? "").toUpperCase() === "COD";

  if (factors.has("address_quality")) {
    return {
      action: "ask_buyer",
      needsApproval: true,
      args: {
        orderNo: order.orderNo,
        question:
          "Which landmark is nearest to your address? The courier could not " +
          "locate the delivery point.",
      },
      expectedEffect:
        `resolves the address gap worth ${ADDRESS_POINTS} risk points before the first attempt`,
    };
  }

  if (attempts >= 1 && (verdict.band === "MEDIUM" || verdict.band === "HIGH")) {
    return {
      action: "redirect_to_pickup",
      needsApproval: false,
      args: { shipmentId: shipment.shipmentId },
      expectedEffect:
        "removes the remaining doorstep attempts from the failure path after a failed attempt",
    };
  }

  if (verdict.band === "HIGH" && cod) {
    return {
      action: "convert_cod_to_prepaid",
      needsApproval: true,
      args: { orderNo: order.orderNo },
      expectedEffect: `removes the ${COD_POINTS}-point COD refusal risk`,
    };
  }

  if (shipment.phoneReachable === false) {
    return {
      action: "ask_buyer",
      needsApproval: true,
      args: {
        orderNo: order.orderNo,
        question:
          "We could not reach you by phone. Is there an alternate number, or a " +
          "time you will be available?",
      },
      expectedEffect: "restores the contact channel the courier needs",
    };
  }

  return null; // LOW band: no intervention is warranted, and we say so.
}

export { COD_POINTS, ADDRESS_POINTS, HIGH, MEDIUM };
