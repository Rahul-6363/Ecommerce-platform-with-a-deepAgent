/**
 * POST /api/finder — state what you need; get back what satisfies it and why
 * everything else does not.
 *
 * The route does three things in order and keeps them visibly separate,
 * because they carry different authority:
 *
 *   1. A model (or the deterministic parser) reads the sentence into
 *      constraints. It decides nothing.
 *   2. A pure function enforces them. It decides everything.
 *   3. Both steps emit an event, so the audit stream shows what was understood
 *      and what was enforced, separately.
 *
 * A caller may also post `constraints` directly, which is what the chips on
 * screen do when the buyer edits one. That path skips step 1 entirely — the
 * buyer's correction is not re-interpreted.
 */
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { handler } from "@/lib/api";
import { now } from "@/lib/clock";
import { emit } from "@/lib/events";
import { findOffers } from "@/lib/finder";
import { catalogueCategories, extractConstraints } from "@/lib/agent/constraint-extractor";
import type { Constraint } from "@/lib/engines/constraints";
import { truncate } from "@/lib/text";
import { ConstraintSchema } from "@/app/api/finder/schema";
import { narrateResult } from "@/lib/speech/narrate";

const Body = z.object({
  /** What the buyer typed. Required unless `constraints` is supplied. */
  sentence: z.string().max(600).optional(),
  /** Pre-built constraints, from editing a chip. Skips extraction. */
  constraints: z.array(ConstraintSchema).max(12).optional(),
  /** Free text to widen the sweep when constraints are posted directly. */
  query: z.string().max(200).optional(),
  paymentMode: z.enum(["COD", "PREPAID"]).optional(),
  addressIndex: z.number().int().min(0).max(10).optional(),
});

export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const body = Body.parse(await req.json().catch(() => ({})));

    if (!body.sentence?.trim() && !body.constraints?.length) {
      throw new Error("Tell me what you need, or set at least one constraint.");
    }

    const at = await now();

    // The buyer's own address drives both the delivery fee and the forecast.
    // Without it there is no honest date to quote, so the default address is
    // used and the tier is reported back on screen.
    const address = (user.addresses ?? [])[body.addressIndex ?? 0];
    const buyer = {
      pinTier: address?.pinTier ?? 2,
      priorRto: user.priorRto ?? 0,
      paymentMode: body.paymentMode ?? "PREPAID",
    };

    let constraints: Constraint[];
    let source: "model" | "rules" | "buyer";
    let query: string;

    if (body.constraints?.length) {
      // The buyer edited the chips. Their correction is authoritative and is
      // not passed back through the model.
      constraints = body.constraints as Constraint[];
      source = "buyer";
      query = body.query ?? "";
    } else {
      const categories = await catalogueCategories();
      const extracted = await extractConstraints(body.sentence ?? "", at, categories);
      constraints = extracted.constraints;
      source = extracted.source;
      query = extracted.query;

      await emit({
        type: "finder.constraints_extracted",
        actor: source === "model" ? "ConstraintAgent" : "ConstraintParser",
        summary:
          constraints.length === 0
            ? `No constraint could be read from "${truncate(body.sentence ?? "", 80)}"`
            : `Read ${constraints.length} constraint(s) from "${truncate(body.sentence ?? "", 80)}" ` +
              `(${source === "model" ? "language model" : "deterministic parser"})`,
        payload: { sentence: body.sentence, constraints, source, query },
        userId: user._id,
      });
    }

    // A sentence with no hard constraint in it is still a real request.
    // "Something for my mother's back pain" names no budget, date or spec, but
    // it describes a need precisely, and refusing to answer it is exactly the
    // dead end that sends a buyer back to scrolling. With nothing to enforce,
    // every candidate trivially satisfies the empty constraint list and the
    // ranking — true cost, then arrival date — does the useful work.
    //
    // The only genuinely unanswerable case is no constraints AND nothing to
    // search on, which is a sentence with no product meaning at all.
    if (constraints.length === 0 && !query.trim()) {
      return {
        source,
        query,
        constraints: [],
        considered: 0,
        satisfied: [],
        rejected: [],
        rejectionSummary: [],
        relaxation: null,
        scope: { products: 0, offers: 0, sellers: 0 },
        buyer: { pinTier: buyer.pinTier, priorRto: buyer.priorRto, paymentMode: buyer.paymentMode, city: address?.city ?? "" },
        headline:
          "I could not tell what you need from that. Name the thing you want, or " +
          "what you want it for — \"something for my mother's back pain\" works.",
        spoken:
          "I could not tell what you need from that. Try naming the thing you want, " +
          "or what you want it for.",
        asOf: at.toISOString(),
      };
    }

    const result = await findOffers({
      constraints,
      buyer,
      query,
      // The unstripped sentence, so need matching sees the buyer's own words.
      sentence: body.sentence ?? "",
      now: at,
    });

    await emit({
      type: "finder.solved",
      actor: "ConstraintSolver",
      summary: result.headline,
      payload: {
        constraints: result.constraints,
        considered: result.considered,
        satisfiedCount: result.satisfied.length,
        rejectedCount: result.rejected.length,
        rejectionSummary: result.rejectionSummary,
        recommendation: result.satisfied[0]
          ? {
              sku: result.satisfied[0].candidate.sku,
              seller: result.satisfied[0].candidate.seller.name,
              expectedTotalInr: result.satisfied[0].cost.expectedTotalInr,
            }
          : null,
      },
      userId: user._id,
    });

    return {
      ...result,
      source,
      query,
      // Written for a voice, not the screen: one or two sentences carrying the
      // decision, built from the same engine output the page renders so the
      // two can never disagree.
      spoken: narrateResult(result),
      buyer: {
        pinTier: buyer.pinTier,
        priorRto: buyer.priorRto,
        paymentMode: buyer.paymentMode,
        city: address?.city ?? "",
      },
      asOf: at.toISOString(),
    };
  });
}
