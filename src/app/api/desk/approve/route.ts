import { z } from "zod";
import { requireOperator } from "@/lib/auth/session";
import { decideClaim } from "@/lib/agent/approval";
import { handler } from "@/lib/api";
import { REMEDIES } from "@/lib/types";

const Body = z.object({
  claimNo: z.string().min(1),
  approve: z.boolean(),
  note: z.string().max(1000).optional(),
  overrideRemedy: z.enum(REMEDIES as unknown as [string, ...string[]]).optional(),
  overrideAmountInr: z.number().int().min(0).optional(),
  /**
   * Per-issue decisions on a multi-issue claim, keyed by the issue key.
   *
   * Optional, so every existing single-decision caller is unaffected. An
   * issue left out follows the claim-level `approve`. The amount is re-capped
   * against the order value in `decideClaim` rather than trusted from here.
   */
  issueDecisions: z
    .record(
      z.string().min(1).max(64),
      z.object({
        approve: z.boolean(),
        note: z.string().max(1000).optional(),
        amountInr: z.number().int().min(0).optional(),
      }),
    )
    .optional(),
});

/**
 * The approval gate. `requireOperator` is the enforcement: hiding the button
 * from a buyer is presentation, this is the control.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const op = await requireOperator();
    const b = Body.parse(await req.json());
    return decideClaim({
      claimNo: b.claimNo,
      approve: b.approve,
      operatorEmail: op.email,
      note: b.note,
      overrideRemedy: b.overrideRemedy,
      overrideAmountInr: b.overrideAmountInr,
      issueDecisions: b.issueDecisions,
    });
  });
}
