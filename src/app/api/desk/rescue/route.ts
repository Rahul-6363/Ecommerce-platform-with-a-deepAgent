/**
 * The Proactive Order Rescue Agent, on demand.
 *
 * GET  lists the orders the agent is currently holding open, with what it has
 *      already tried on each — so an operator can see the queue rather than
 *      only the events a sweep happened to emit.
 *
 * POST runs it. With `orderNo` it assesses that one order; without, it sweeps
 *      every order still in flight.
 *
 * `humanPresent` defaults to false for the same reason the watcher tick does:
 * the claim being demonstrated is that the rescue happens because a promise is
 * in danger, not because somebody pressed a button. In a deployment this is a
 * cron job calling the same two functions.
 *
 * Operator-only. A buyer must not be able to make the platform ring a courier
 * about someone else's parcel, and `requireOperator` is the control — hiding
 * the button is presentation.
 */
import { z } from "zod";
import { requireOperator } from "@/lib/auth/session";
import { rescueOrder, rescueSweep, rescueQueue } from "@/lib/agent/rescue";
import { brokenTool } from "@/lib/clock";
import { handler } from "@/lib/api";

const Body = z.object({
  /** One order, or omitted to sweep everything in flight. */
  orderNo: z.string().min(1).optional(),
  humanPresent: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).optional(),
});

export async function GET() {
  return handler(async () => {
    await requireOperator();
    return { queue: await rescueQueue() };
  });
}

export async function POST(req: Request) {
  return handler(async () => {
    await requireOperator();
    const b = Body.parse(await req.json().catch(() => ({})));

    // The same chaos switch the claim pipeline honours, so "break tool" on the
    // desk proves the rescue path degrades safely too rather than only the
    // claim path. A rescue whose courier tool dies must hand off, not retry.
    const broken = await brokenTool();

    if (b.orderNo) {
      const run = await rescueOrder(b.orderNo, {
        humanPresent: b.humanPresent,
        brokenTool: broken || undefined,
      });
      return { run };
    }

    const sweep = await rescueSweep({
      humanPresent: b.humanPresent,
      limit: b.limit,
      brokenTool: broken || undefined,
    });
    return { sweep };
  });
}
