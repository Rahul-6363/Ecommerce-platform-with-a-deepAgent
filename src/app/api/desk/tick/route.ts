import { z } from "zod";
import { requireOperator } from "@/lib/auth/session";
import { tick } from "@/lib/agent/watcher";
import { settleDueRefunds } from "@/lib/refunds";
import { handler } from "@/lib/api";

const Body = z.object({
  humanPresent: z.boolean().default(false),
});

/**
 * Run the watcher once.
 *
 * `humanPresent: false` is the honest claim being demonstrated: the escalation
 * happens because a deadline lapsed, not because anybody asked for it. In a
 * deployment this is a cron job hitting the same function.
 */
export async function POST(req: Request) {
  return handler(async () => {
    await requireOperator();
    const b = Body.parse(await req.json().catch(() => ({})));
    const result = await tick(b.humanPresent);

    // A refund whose promised date has passed should have arrived. Settling
    // here means advancing the clock carries the money all the way to the
    // buyer, rather than leaving every refund stuck at "processing" forever.
    const settled = await settleDueRefunds();

    return { ...result, refundsSettled: settled };
  });
}
