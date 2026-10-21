import { readEvents, projectDashboard } from "@/lib/events";
import { requireUser } from "@/lib/auth/session";
import { handler } from "@/lib/api";

/**
 * The event stream, which every screen is a projection of.
 *
 * A buyer sees only their own events; an operator sees all of them. `since`
 * takes the last seq a client holds, so polling costs one small query.
 */
export async function GET(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const u = new URL(req.url);
    const since = Number.parseInt(u.searchParams.get("since") ?? "0", 10) || 0;
    const claimId = u.searchParams.get("claimId") ?? undefined;
    const orderId = u.searchParams.get("orderId") ?? undefined;

    const isOperator = user.role === "operator";
    const events = await readEvents({
      since,
      claimId,
      orderId,
      userId: isOperator ? undefined : String(user._id),
      limit: 200,
    });

    return {
      events: events.map((e) => ({
        seq: e.seq, type: e.type, actor: e.actor, summary: e.summary,
        payload: e.payload, at: e.at,
        claimId: e.claimId ? String(e.claimId) : null,
        orderId: e.orderId ? String(e.orderId) : null,
      })),
      latestSeq: events.length ? events[events.length - 1].seq : since,
      ...(isOperator ? { dashboard: await projectDashboard() } : {}),
    };
  });
}
