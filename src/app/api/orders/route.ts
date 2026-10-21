import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { connectDb } from "@/lib/db/connect";
import { Claim, Order, Shipment } from "@/models";
import type { LeanClaim, LeanOrder, LeanShipment } from "@/models";
import { placeOrder } from "@/lib/orders";
import { refundsForOrders } from "@/lib/refunds";
import { handler } from "@/lib/api";

export async function GET() {
  return handler(async () => {
    const user = await requireUser();
    await connectDb();

    const orders = await Order.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean<LeanOrder[]>();

    const ids = orders.map((o) => o._id);
    const shipments = await Shipment.find({ orderId: { $in: ids } }).lean<LeanShipment[]>();
    const claims = await Claim.find({ orderId: { $in: ids } })
      .select("claimNo orderId state issueType verdict authenticity createdAt")
      .lean<LeanClaim[]>();

    // Refunds are read alongside, because "where is my money" is the question
    // the order status cannot answer and the buyer always asks next.
    const refundsByOrder = await refundsForOrders(ids.map(String));

    const shipByOrder = new Map(shipments.map((s) => [String(s.orderId), s]));
    const claimsByOrder = new Map<string, LeanClaim[]>();
    for (const c of claims) {
      const k = String(c.orderId);
      claimsByOrder.set(k, [...(claimsByOrder.get(k) ?? []), c]);
    }

    return {
      orders: orders.map((o) => {
        const s = shipByOrder.get(String(o._id));
        return {
          orderNo: o.orderNo,
          status: o.status,
          amountInr: o.amountInr,
          paymentMode: o.paymentMode,
          paymentStatus: o.paymentStatus,
          placedAt: o.placedAt,
          promisedBy: o.promisedBy,
          deliveredAt: o.deliveredAt,
          placedByAgent: o.placedByAgent,
          address: o.address,
          deliveryInstructions: o.deliveryInstructions ?? "",
          items: o.items.map((i) => ({
            sku: i.sku, title: i.title, qty: i.qty, unitPriceInr: i.unitPriceInr,
            category: i.category, brand: i.brand, boxContents: i.boxContents,
          })),
          shipment: s
            ? {
                shipmentId: s.shipmentId, courier: s.courier, awb: s.awb,
                status: s.status, attempts: s.attempts,
                riskScore: s.riskScore, riskBand: s.riskBand,
                scans: (s.scans ?? []).map((x) => ({
                  at: x.at, location: x.location, note: x.note, code: x.code,
                })),
              }
            : null,
          claims: (claimsByOrder.get(String(o._id)) ?? []).map((c) => ({
            claimNo: c.claimNo, state: c.state, issueType: c.issueType,
            remedy: c.verdict?.remedy, amountInr: c.verdict?.amountInr,
            authenticity: c.authenticity?.verdict, createdAt: c.createdAt,
          })),
          refunds: (refundsByOrder.get(String(o._id)) ?? []).map((r) => ({
            refundNo: r.refundNo,
            amountInr: r.amountInr,
            remedy: r.remedy,
            method: r.method,
            destination: r.destination,
            status: r.status,
            initiatedAt: r.initiatedAt,
            expectedBy: r.expectedBy,
            settledAt: r.settledAt,
            clauseIds: r.clauseIds,
          })),
        };
      }),
    };
  });
}

const Body = z.object({
  paymentMode: z.enum(["COD", "PREPAID"]).default("PREPAID"),
  addressIndex: z.number().int().min(0).default(0),
  // Capped at the schema boundary as well as in placeOrder: this text ends up
  // on a courier label and in an email.
  deliveryInstructions: z.string().max(400).optional(),
  agentSessionId: z.string().optional(),
});

export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const b = Body.parse(await req.json().catch(() => ({})));
    // This is the write the agent is not allowed to make on its own: the gate
    // lives in callTool, and the buyer reaches this route by pressing a button.
    return placeOrder({
      userId: String(user._id),
      paymentMode: b.paymentMode,
      addressIndex: b.addressIndex,
      deliveryInstructions: b.deliveryInstructions,
      agentSessionId: b.agentSessionId,
    });
  });
}
