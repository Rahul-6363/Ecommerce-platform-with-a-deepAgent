import { z } from "zod";
import { requireOperator } from "@/lib/auth/session";
import {
  advanceDays, advanceTo, resetClock, setBrokenTool, now,
  setChaos, clearChaos, chaosState, UNGROUNDED_DRAFT,
} from "@/lib/clock";
import { advanceFulfilment, recordFailedAttempt } from "@/lib/orders";
import { connectDb } from "@/lib/db/connect";
import { Claim } from "@/models";
import type { LeanClaim } from "@/models";
import { emit } from "@/lib/events";
import { handler, fail } from "@/lib/api";
import { TOOL_CAPABILITY } from "@/lib/agent/mandate";

const Body = z.object({
  action: z.enum([
    "advance_days", "skip_to_deadline", "reset_clock",
    "advance_order", "fail_attempt", "break_tool", "set_chaos", "clear_chaos",
  ]),
  orderNo: z.string().optional(),
  claimNo: z.string().optional(),
  days: z.number().min(0).max(365).optional(),
  tool: z.string().optional(),
  mode: z.enum(["fail", "slow", "off"]).optional(),
  phoneReachable: z.boolean().optional(),
});

/** Demo controls. Operator-only, because they move the clock for everyone. */
export async function POST(req: Request) {
  return handler(async () => {
    await requireOperator();
    const b = Body.parse(await req.json());

    switch (b.action) {
      case "advance_days": {
        const at = await advanceDays(b.days ?? 1);
        await emit({
          type: "system.clock_advanced",
          actor: "operator",
          summary: `Clock advanced ${b.days ?? 1} day(s) to ${at.toISOString().slice(0, 16)}`,
          payload: { days: b.days ?? 1, simulatedNow: at.toISOString() },
        });
        return { simulatedNow: at.toISOString() };
      }

      case "skip_to_deadline": {
        if (!b.claimNo) return fail("Which claim?", 422);
        await connectDb();
        const claim = await Claim.findOne({ claimNo: b.claimNo }).lean<LeanClaim>();
        if (!claim?.deadlineAt) return fail("That claim has no deadline to skip to.", 404);
        const at = await advanceTo(new Date(claim.deadlineAt));
        await emit({
          type: "system.clock_advanced",
          actor: "operator",
          summary: `Clock moved past the ${b.claimNo} deadline, to ${at.toISOString().slice(0, 16)}`,
          payload: { claimNo: b.claimNo, simulatedNow: at.toISOString() },
          claimId: claim._id,
        });
        return { simulatedNow: at.toISOString(), deadlineAt: claim.deadlineAt };
      }

      case "reset_clock": {
        await resetClock();
        return { simulatedNow: (await now()).toISOString() };
      }

      case "advance_order": {
        if (!b.orderNo) return fail("Which order?", 422);
        return advanceFulfilment(b.orderNo);
      }

      case "fail_attempt": {
        if (!b.orderNo) return fail("Which order?", 422);
        await recordFailedAttempt(b.orderNo, b.phoneReachable ?? true);
        return { orderNo: b.orderNo, recorded: true };
      }

      case "set_chaos": {
        // The richer switch: fail (forces a replan), slow (exercises latency
        // and budgets), or __draft__ (strips the grounding from the first
        // draft so the verifier rejects the agent's own work on screen).
        const tool = b.tool ?? "";
        const mode = b.mode ?? "off";
        if (tool && tool !== UNGROUNDED_DRAFT && !(tool in TOOL_CAPABILITY)) {
          return fail(`There is no tool named ${tool}.`, 422);
        }
        const state = await setChaos(tool, mode);
        return {
          chaos: state,
          note:
            mode === "off"
              ? `${tool} restored.`
              : tool === UNGROUNDED_DRAFT
                ? "The next draft will omit its citations, so the verifier will reject it and the agent will rewrite it."
                : mode === "slow"
                  ? `${tool} will take 2.5s, so you can watch the step budget.`
                  : `${tool} will fail, so the agent has to replan around it.`,
        };
      }

      case "clear_chaos": {
        await clearChaos();
        return { chaos: {}, note: "All tools restored." };
      }

      case "break_tool": {
        const tool = b.tool ?? "";
        if (tool && !(tool in TOOL_CAPABILITY)) {
          return fail(`There is no tool named ${tool}.`, 422);
        }
        await setBrokenTool(tool);
        return {
          brokenTool: tool,
          note: tool
            ? `${tool} will now fail, so the agent has to replan around it.`
            : "All tools restored.",
        };
      }
    }
  });
}
