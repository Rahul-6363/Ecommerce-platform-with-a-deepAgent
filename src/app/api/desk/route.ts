import { requireOperator } from "@/lib/auth/session";
import { connectDb } from "@/lib/db/connect";
import { Claim, MailLog, Order, Shipment, User } from "@/models";
import type { LeanClaim, LeanOrder, LeanShipment, LeanUser } from "@/models";
import { projectDashboard } from "@/lib/events";
import { mandatePanel, BUDGETS } from "@/lib/agent/mandate";
import { capabilities } from "@/lib/env";
import { now, offsetMs, brokenTool, chaosState } from "@/lib/clock";
import { handler } from "@/lib/api";
import { allStandings } from "@/lib/sellers";
import { Refund } from "@/models";
import type { LeanRefund } from "@/models";

/** Everything the operator desk renders, in one call. */
export async function GET() {
  return handler(async () => {
    await requireOperator();
    await connectDb();

    const [
      claims, orders, shipments, users, mail, dashboard,
      simulatedNow, offset, broken, chaos, standings, refunds,
    ] = await Promise.all([
        Claim.find().sort({ createdAt: -1 }).limit(100).lean<LeanClaim[]>(),
        Order.find().sort({ createdAt: -1 }).limit(100).lean<LeanOrder[]>(),
        Shipment.find().sort({ createdAt: -1 }).limit(100).lean<LeanShipment[]>(),
        User.find({ role: "buyer" }).select("name email lang totalClaims rejectedClaims priorRto storeCreditInr").lean<LeanUser[]>(),
        MailLog.find().sort({ sentAt: -1 }).limit(60).lean(),
        projectDashboard(),
        now(),
        offsetMs(),
        brokenTool(),
        chaosState(),
        // Seller accountability, worst first. Without this the consequence of
        // an upheld claim is real but invisible, which is how it quietly stops
        // working.
        allStandings(),
        Refund.find().sort({ createdAt: -1 }).limit(60).lean<LeanRefund[]>(),
      ]);

    const orderById = new Map(orders.map((o) => [String(o._id), o]));
    const userById = new Map(users.map((u) => [String(u._id), u]));
    const shipByOrder = new Map(shipments.map((s) => [String(s.orderId), s]));

    return {
      sellers: standings.map((x) => ({
        sellerId: x.sellerId,
        orders: x.orders,
        upheldClaims: x.upheldClaims,
        rejectedClaims: x.rejectedClaims,
        observedDefectRatePct: x.observedDefectRatePct,
        effectiveDefectRatePct: x.effectiveDefectRatePct,
        confident: x.confident,
        band: x.band,
        action: x.action,
        refundedInr: x.refundedInr,
        notice: x.notice,
        reasons: x.reasons,
      })),

      refunds: refunds.map((r) => ({
        refundNo: r.refundNo,
        amountInr: r.amountInr,
        remedy: r.remedy,
        method: r.method,
        status: r.status,
        sellerId: r.sellerId,
        initiatedAt: r.initiatedAt,
        expectedBy: r.expectedBy,
        settledAt: r.settledAt,
        // An overdue refund is the single thing on this desk a buyer is most
        // likely to be chasing, so it is computed here rather than left to the UI.
        overdue: !r.settledAt && new Date(r.expectedBy) < simulatedNow,
      })),

      clock: {
        simulatedNow: simulatedNow.toISOString(),
        realNow: new Date().toISOString(),
        offsetDays: Math.round((offset / 86_400_000) * 10) / 10,
      },
      capabilities: capabilities(),
      mandate: mandatePanel(),
      budgets: BUDGETS,
      brokenTool: broken,
      chaos,
      dashboard,

      claims: claims.map((c) => {
        const o = orderById.get(String(c.orderId));
        const u = userById.get(String(c.userId));
        return {
          claimNo: c.claimNo,
          orderNo: o?.orderNo ?? "",
          productTitle: o?.items?.[0]?.title ?? "",
          orderAmountInr: o?.amountInr ?? 0,
          buyerName: u?.name ?? "",
          buyerEmail: u?.email ?? "",
          buyerClaimHistory: u
            ? { total: u.totalClaims, rejected: u.rejectedClaims, priorRto: u.priorRto }
            : null,
          state: c.state,
          issueType: c.issueType,
          lang: c.lang,
          inputMode: c.inputMode,
          rawComplaint: c.rawComplaint,
          translatedComplaint: c.translatedComplaint,
          evidenceFlags: c.evidenceFlags,
          verdict: c.verdict,
          authenticity: c.authenticity,
          draftMessage: c.draftMessage,
          draftVerified: c.draftVerified,
          verifierNotes: c.verifierNotes,
          plan: c.plan ?? { goal: "", source: "", steps: [] },
          budget: {
            stepsUsed: c.stepsUsed ?? 0,
            replansUsed: c.replansUsed ?? 0,
            exhausted: false,
          },
          approval: c.approval,
          deadlineAt: c.deadlineAt,
          escalationTier: c.escalationTier,
          evidence: (c.evidence ?? []).map((e) => ({
            kind: e.kind, filename: e.filename, bytes: e.bytes,
            dataUrl: e.dataUrl, visionFindings: e.visionFindings,
          })),
          createdAt: c.createdAt,
          resolvedAt: c.resolvedAt,
        };
      }),

      orders: orders.map((o) => {
        const s = shipByOrder.get(String(o._id));
        const u = userById.get(String(o.userId));
        return {
          orderNo: o.orderNo,
          buyerName: u?.name ?? "",
          status: o.status,
          amountInr: o.amountInr,
          paymentMode: o.paymentMode,
          paymentStatus: o.paymentStatus,
          placedByAgent: o.placedByAgent,
          placedAt: o.placedAt,
          promisedBy: o.promisedBy,
          deliveredAt: o.deliveredAt,
          address: o.address,
          items: o.items.map((i) => ({ sku: i.sku, title: i.title, qty: i.qty })),
          shipment: s
            ? {
                shipmentId: s.shipmentId, courier: s.courier, status: s.status,
                attempts: s.attempts, phoneReachable: s.phoneReachable,
                riskScore: s.riskScore, riskBand: s.riskBand,
              }
            : null,
        };
      }),

      outbox: mail.map((m) => ({
        to: m.to, subject: m.subject, status: m.status,
        template: m.template, error: m.error, sentAt: m.sentAt, html: m.html,
      })),
    };
  });
}
