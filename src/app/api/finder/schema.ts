/**
 * The wire shape of a constraint, shared by every finder route.
 *
 * Validated rather than trusted: these arrive from the browser, and
 * `solveConstraints` is written to trust its input by design. A malformed
 * constraint has to fail here, at the edge, rather than inside a pure function
 * that has no way to report it.
 *
 * Shared so the solve route and the accept route cannot drift apart: a
 * constraint the buyer could search with but not accept on would be a
 * confusing dead end.
 */
import { z } from "zod";

export const ConstraintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("category"), value: z.string().min(1).max(60) }),
  z.object({ kind: z.literal("max_price"), value: z.number().positive().max(10_000_000) }),
  z.object({ kind: z.literal("min_price"), value: z.number().positive().max(10_000_000) }),
  z.object({ kind: z.literal("brand"), value: z.string().min(1).max(60) }),
  z.object({ kind: z.literal("min_rating"), value: z.number().min(0).max(5) }),
  z.object({ kind: z.literal("in_stock"), value: z.literal(true) }),
  z.object({
    kind: z.literal("attribute"),
    key: z.string().min(1).max(40),
    value: z.union([z.string().max(60), z.number(), z.boolean()]),
  }),
  z.object({ kind: z.literal("arrive_by"), value: z.string().min(4).max(40) }),
  z.object({ kind: z.literal("payment_mode"), value: z.enum(["COD", "PREPAID"]) }),
  z.object({ kind: z.literal("max_true_cost"), value: z.number().positive().max(10_000_000) }),
  z.object({ kind: z.literal("max_seller_defect_rate"), value: z.number().min(0).max(100) }),
]);
