import { z } from "zod";
import { requireOperator } from "@/lib/auth/session";
import { runEvals } from "@/lib/eval-runner";
import { SCENARIOS } from "@/lib/evals";
import { handler } from "@/lib/api";

/** The scenario list, so the desk can show what will run before running it. */
export async function GET() {
  return handler(async () => {
    await requireOperator();
    return {
      scenarios: SCENARIOS.map((s) => ({
        id: s.id, name: s.name, kind: s.kind,
        orderNo: s.orderNo ?? null,
        knownLimitation: s.knownLimitation ?? null,
      })),
    };
  });
}

const Body = z.object({ only: z.array(z.number().int()).optional() });

/**
 * Run the suite.
 *
 * It reseeds first, so this resets the demo database. That is deliberate: an
 * eval whose result depends on what the last person clicked is not a
 * regression suite.
 */
export async function POST(req: Request) {
  return handler(async () => {
    await requireOperator();
    const b = Body.parse(await req.json().catch(() => ({})));
    return runEvals(b.only);
  });
}
