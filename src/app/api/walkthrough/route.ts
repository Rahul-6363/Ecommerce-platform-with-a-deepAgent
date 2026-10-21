/**
 * POST /api/walkthrough — run a scripted journey and return what it emitted.
 *
 * The event stream already holds everything this returns. What this adds is
 * attribution: it records the stream's high-water mark before each step and
 * reads the gap afterwards, so every event is tied to the step that caused it
 * and to the claim that step is meant to prove.
 *
 * It calls the platform's own HTTP routes rather than reaching into the
 * libraries. That is deliberate and it is the point: a demonstration that
 * bypasses the routes also bypasses the gates, and the gates are most of what
 * is being demonstrated. A step that tries to place an order gets refused by
 * the same registry a real agent turn hits.
 *
 * Nothing is mocked, pre-recorded or special-cased. A step that fails is
 * reported as failed — several are supposed to.
 */
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { handler, fail } from "@/lib/api";
import { readEvents, latestSeq } from "@/lib/events";
import { callTool } from "@/lib/agent/tools";
import { WALKTHROUGHS, walkthroughById, type WalkthroughStep } from "@/lib/walkthrough";
import { actorFacts, allActors, stageOf, isPivotal } from "@/lib/actors";

const Body = z.object({
  id: z.string().min(1),
  /** Run one step rather than the whole script, so a judge can go slowly. */
  stepId: z.string().optional(),
});

type StepResult = {
  id: string;
  title: string;
  proves: string;
  method: string;
  path: string;
  /** True when this step re-reads the trail instead of causing anything. */
  reviewsPrevious: boolean;
  status: number;
  ok: boolean;
  /** True when a refusal was the expected outcome and it happened. */
  refusedAsExpected: boolean;
  /**
   * This step could not run as whoever is signed in, and did not fail.
   *
   * A judge reading "4/5" takes it as something broken, so a step that needs
   * an operator or an address is counted apart from one that ran and went
   * wrong. The distinction is the difference between a demonstration that
   * looks honest and one that looks broken.
   */
  skipped: boolean;
  ms: number;
  /** A short, readable digest of the response — never the whole thing. */
  response: Record<string, unknown>;
  events: {
    seq: number;
    type: string;
    actor: string;
    actorName: string;
    actorKind: string;
    actorDoes: string;
    actorCannot?: string;
    stage: string;
    summary: string;
    pivotal: string | null;
    payload?: Record<string, unknown>;
    at: string;
  }[];
  error?: string;
};

/** The menu. Steps are omitted: they are the content of a run, not a listing. */
export async function GET() {
  return handler(async () => {
    await requireUser();
    return {
      walkthroughs: WALKTHROUGHS.map((w) => ({
        id: w.id,
        title: w.title,
        question: w.question,
        seconds: w.seconds,
        steps: w.steps.length,
      })),
      actors: allActors(),
    };
  });
}

export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const body = Body.parse(await req.json().catch(() => ({})));

    const walkthrough = walkthroughById(body.id);
    if (!walkthrough) return fail(`No walkthrough called "${body.id}".`, 404);

    const steps = body.stepId
      ? walkthrough.steps.filter((s) => s.id === body.stepId)
      : walkthrough.steps;
    if (steps.length === 0) return fail(`No step called "${body.stepId}".`, 404);

    // Operator-only steps are skipped rather than failed for a buyer: the
    // walkthrough should be runnable from either account, and silently
    // granting an operator step to a buyer would be the opposite of the point.
    const isOperator = user.role === "operator";
    // Read once: a step that prices a delivery needs somewhere to deliver to,
    // and the operator account has no address.
    const hasAddress = ((user.addresses ?? []) as unknown[]).length > 0;

    // The cookie is forwarded so each call runs as whoever is watching. The
    // alternative — a service token — would mean the demonstration ran with
    // privileges the real UI never has.
    const cookie = req.headers.get("cookie") ?? "";
    const origin = new URL(req.url).origin;

    // The mark at which this run began. Review steps read from here.
    const runStartedAt = await latestSeq();
    const results: StepResult[] = [];

    for (const step of steps) {
      if (step.needsAddress && !hasAddress) {
        results.push({
          ...describe(step),
          reviewsPrevious: Boolean(step.reviewsPrevious),
          status: 0,
          ok: false,
          refusedAsExpected: false,
          skipped: true,
          ms: 0,
          response: {},
          events: [],
          error:
            "This step needs a saved delivery address. Sign in as a buyer " +
            "(arjun@example.in) to see it, or add one under My orders → Addresses.",
        });
        continue;
      }

      if (step.asBuyer && isOperator) {
        results.push({
          ...describe(step),
          reviewsPrevious: Boolean(step.reviewsPrevious),
          status: 0,
          ok: false,
          refusedAsExpected: false,
          skipped: true,
          ms: 0,
          response: {},
          events: [],
          error:
            "This step files a claim on a demo buyer's own order, and the route " +
            "correctly refuses an operator doing that. Sign in as arjun@example.in " +
            "to see it run.",
        });
        continue;
      }

      if (step.asOperator && !isOperator) {
        results.push({
          ...describe(step),
          reviewsPrevious: Boolean(step.reviewsPrevious),
          status: 0,
          ok: false,
          refusedAsExpected: false,
          skipped: true,
          ms: 0,
          response: {},
          events: [],
          error: "This step needs an operator. Sign in as ops@vaanijya.in to see it.",
        });
        continue;
      }

      // A review step reads back what the script has already produced, so its
      // window starts where the walkthrough started rather than at this call.
      const before = step.reviewsPrevious ? runStartedAt : await latestSeq();
      const started = Date.now();

      let status = 0;
      let payload: unknown = {};
      let error: string | undefined;

      try {
        if (step.callsTool) {
          // In-process, through the same entry point an agent turn uses. There
          // is deliberately no HTTP route that invokes an arbitrary tool —
          // that would be the hole this gate closes — so the step that proves
          // the gate has to call the registry the way an agent does.
          const res = await callTool(step.callsTool.tool, step.callsTool.args, {
            userId: String(user._id),
            agent: step.callsTool.agent,
          });
          // A refused tool is a 403 in HTTP terms, which is what the step
          // declared it expects.
          status = res.ok ? 200 : 403;
          payload = res.ok
            ? { ok: true, data: res.data }
            : { ok: false, code: res.code, error: res.error };
        } else {
          // The claims route takes multipart so photographs ride along in the
          // same request; `content-type` is left unset for it so fetch adds
          // the boundary.
          let payloadBody: BodyInit | undefined;
          const headers: Record<string, string> = { cookie };
          if (step.asForm && step.body) {
            const form = new FormData();
            for (const [k, v] of Object.entries(step.body)) form.append(k, String(v));
            payloadBody = form;
          } else if (step.body) {
            headers["content-type"] = "application/json";
            payloadBody = JSON.stringify(step.body);
          }

          const res = await fetch(`${origin}${step.path}`, {
            method: step.method,
            headers,
            body: payloadBody,
            cache: "no-store",
          });
          status = res.status;
          payload = await res.json().catch(() => ({}));
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }

      const ms = Date.now() - started;

      // Events this step caused: everything appended since the mark. Read
      // unfiltered for an operator and scoped to the buyer otherwise, matching
      // what /api/events would show them.
      const rows = await readEvents({
        since: before,
        userId: isOperator ? undefined : String(user._id),
        limit: 60,
      });

      const refused = status >= 400 && status < 500;

      results.push({
        ...describe(step),
        reviewsPrevious: Boolean(step.reviewsPrevious),
        status,
        // A step that was supposed to be refused is "ok" when it was.
        ok: step.expectRefusal ? refused : status >= 200 && status < 300,
        refusedAsExpected: Boolean(step.expectRefusal) && refused,
        skipped: false,
        ms,
        response: digest(payload),
        events: rows.map((e) => {
          const facts = actorFacts(e.actor);
          const pay = (e.payload ?? {}) as Record<string, unknown>;
          return {
            seq: e.seq,
            type: e.type,
            actor: e.actor,
            actorName: facts.name,
            actorKind: facts.kind,
            actorDoes: facts.does,
            actorCannot: facts.cannot,
            stage: stageOf(e.type),
            summary: e.summary,
            pivotal: isPivotal(e.type, pay),
            payload: digest(pay),
            at: new Date(e.at).toISOString(),
          };
        }),
        error,
      });
    }

    return {
      walkthrough: {
        id: walkthrough.id,
        title: walkthrough.title,
        question: walkthrough.question,
      },
      results,
      /** Counted here so the UI does not have to agree about what matters. */
      summary: {
        // Skipped steps are excluded from the denominator too, so the ratio a
        // judge reads is "of what could run here, how much behaved".
        steps: results.filter((r) => !r.skipped).length,
        passed: results.filter((r) => r.ok).length,
        skipped: results.filter((r) => r.skipped).length,
        // Review steps repeat events an earlier step already reported, so only
        // the steps that caused something are counted.
        events: results.filter((r) => !r.reviewsPrevious).reduce((n, r) => n + r.events.length, 0),
        models: countKind(results, "model"),
        engines: countKind(results, "engine"),
        people: countKind(results, "person"),
        pivotal: results
          .filter((r) => !r.reviewsPrevious)
          .flatMap((r) => r.events)
          .filter((e) => e.pivotal).length,
      },
    };
  });
}

function describe(step: WalkthroughStep) {
  return {
    id: step.id,
    title: step.title,
    proves: step.proves,
    method: step.method,
    path: step.path,
  };
}

function countKind(results: StepResult[], kind: string): number {
  return results
    .filter((r) => !r.reviewsPrevious)
    .flatMap((r) => r.events)
    .filter((e) => e.actorKind === kind).length;
}

/**
 * A response or payload cut down to what fits on a screen.
 *
 * Long arrays are the problem: a solve result carries every offer and every
 * rejection, and a judge wants the shape, not three hundred lines of JSON.
 * So arrays are truncated with a count of what was dropped, deep nesting is
 * cut, and long strings are clipped — the full record is in the stream for
 * anyone who wants it.
 */
function digest(value: unknown, depth = 0): Record<string, unknown> {
  const out = shrink(value, depth);
  return out && typeof out === "object" && !Array.isArray(out)
    ? (out as Record<string, unknown>)
    : { value: out };
}

function shrink(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  }
  if (typeof value !== "object") return value;
  if (depth >= 3) return Array.isArray(value) ? `[${value.length} items]` : "{…}";

  if (Array.isArray(value)) {
    const head = value.slice(0, 4).map((v) => shrink(v, depth + 1));
    return value.length > 4 ? [...head, `…and ${value.length - 4} more`] : head;
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(0, 18);
  return Object.fromEntries(entries.map(([k, v]) => [k, shrink(v, depth + 1)]));
}
