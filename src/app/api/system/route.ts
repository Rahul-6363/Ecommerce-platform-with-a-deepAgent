import { requireUser } from "@/lib/auth/session";
import { mandatePanel, BUDGETS, APPROVAL_REQUIRED, BUYER_CONFIRM_REQUIRED, TOOL_CAPABILITY } from "@/lib/agent/mandate";
import { claimMachine } from "@/lib/engines/states";
import { capabilities, env } from "@/lib/env";
import { SCENARIOS } from "@/lib/evals";
import { fallbackPlan } from "@/lib/agent/orchestrator";
import { handler } from "@/lib/api";
import {
  GRACE_DAYS, PARTIAL_PCT, LATE_CREDIT_PCT, LATE_CREDIT_CAP,
  AMBIGUOUS_CONFIDENCE, MAX_CONFIDENCE, PRIORITY, REQUIRED_EVIDENCE,
} from "@/lib/engines/entitlement";
import { COD_POINTS, ADDRESS_POINTS, HIGH, MEDIUM } from "@/lib/engines/risk";
import { SUSPICIOUS, INCONCLUSIVE_FLOOR } from "@/lib/engines/authenticity";
import {
  COD_FEE_INR, DELIVERY_FEE_BY_TIER, FREE_DELIVERY_ABOVE_INR,
  RETURN_FRICTION_INR, TRANSIT_DAYS_BY_TIER, CONFIDENCE_PCT,
  RTO_SLACK_CAP, COD_SLACK_DAYS,
} from "@/lib/engines/offers";
import { CONSTRAINT_KINDS } from "@/lib/engines/constraints";
import {
  STANDING_BANDS, MIN_ORDERS_FOR_CONFIDENCE,
} from "@/lib/engines/seller-standing";

/**
 * What the system is, declared rather than described.
 *
 * Every constant here is imported from the module that uses it, so this page
 * cannot drift from the behaviour. A documented threshold that disagrees with
 * the code is worse than none.
 */
export async function GET() {
  return handler(async () => {
    await requireUser();

    return {
      capabilities: capabilities(),
      models: {
        text: env.groq.textModel,
        vision: env.groq.visionModel,
        audio: env.groq.audioModel,
        fallbacks: env.groq.fallbackModels,
        // The one model not from Groq: ElevenLabs speaks the agent's replies.
        speech: env.eleven.enabled ? env.eleven.model : "",
      },

      agents: mandatePanel(),
      budgets: BUDGETS,
      gates: {
        operatorApproval: [...APPROVAL_REQUIRED],
        buyerConfirm: [...BUYER_CONFIRM_REQUIRED],
      },
      tools: Object.entries(TOOL_CAPABILITY).map(([tool, capability]) => ({
        tool, capability,
        gate: APPROVAL_REQUIRED.has(tool)
          ? "operator"
          : BUYER_CONFIRM_REQUIRED.has(tool)
            ? "buyer"
            : "none",
      })),

      stateMachine: claimMachine(),

      engines: {
        entitlement: {
          description:
            "Decides eligibility, remedy, amount and deadline. A pure function with no model call inside it.",
          constants: {
            graceDays: GRACE_DAYS,
            partialRefundPct: Math.round(PARTIAL_PCT * 100),
            lateCreditPct: Math.round(LATE_CREDIT_PCT * 100),
            lateCreditCapInr: LATE_CREDIT_CAP,
            ambiguousBelowConfidence: AMBIGUOUS_CONFIDENCE,
            maxConfidence: MAX_CONFIDENCE,
          },
          remedyLadder: PRIORITY,
          requiredEvidence: REQUIRED_EVIDENCE,
        },
        risk: {
          description:
            "Scores delivery failure before dispatch. Additive, clamped to 0-100, every point traceable to a named factor.",
          constants: { codPoints: COD_POINTS, addressPoints: ADDRESS_POINTS, highBand: HIGH, mediumBand: MEDIUM },
        },
        authenticity: {
          description:
            "Scores how well the evidence supports the allegation. Advisory: it can demand review, it can never reject a buyer.",
          constants: { suspiciousAt: SUSPICIOUS, inconclusiveAt: INCONCLUSIVE_FLOOR },
        },
        constraints: {
          description:
            "Admits only offers that satisfy every stated constraint, and returns the named constraint each rejection failed. A language model reads the sentence; this decides what qualifies.",
          constants: { constraintKinds: CONSTRAINT_KINDS.length },
          supportedConstraints: CONSTRAINT_KINDS,
        },
        trueCost: {
          description:
            "Adds the COD fee, the tier delivery fee and the expected cost of a return to the sticker price, so the cheapest sticker is not mistaken for the cheapest purchase.",
          constants: {
            codFeeInr: COD_FEE_INR,
            deliveryFeeTier1Inr: DELIVERY_FEE_BY_TIER[1],
            deliveryFeeTier3Inr: DELIVERY_FEE_BY_TIER[3],
            freeDeliveryAboveInr: FREE_DELIVERY_ABOVE_INR,
            returnFrictionInr: RETURN_FRICTION_INR,
          },
        },
        sellerStanding: {
          description:
            "Turns upheld claims into a seller's observed defect rate, which is the number the buyer's true-cost comparison prices in. Only upheld claims count, and a small sample never restricts listings.",
          constants: {
            goodBandPct: STANDING_BANDS.good,
            acceptableBandPct: STANDING_BANDS.acceptable,
            poorBandPct: STANDING_BANDS.poor,
            minOrdersForConfidence: MIN_ORDERS_FOR_CONFIDENCE,
          },
        },
        deliveryForecast: {
          description:
            "Returns a likely date AND a date it is confident about, with every day of padding traced to a named route risk. A deadline is judged against the confident date, never the optimistic one.",
          constants: {
            confidencePct: CONFIDENCE_PCT,
            transitDaysTier1: TRANSIT_DAYS_BY_TIER[1],
            transitDaysTier4: TRANSIT_DAYS_BY_TIER[4],
            rtoSlackCapDays: RTO_SLACK_CAP,
            codSlackDays: COD_SLACK_DAYS,
          },
        },
      },

      // The deterministic plan, so the fallback route is inspectable too.
      fallbackPlan: fallbackPlan("ORD-EXAMPLE", "DAMAGED").map((s) => ({
        id: s.id, title: s.title, tool: s.tool, why: s.why, gated: s.needsApproval,
      })),

      evals: SCENARIOS.map((s) => ({
        id: s.id, name: s.name, kind: s.kind,
        knownLimitation: s.knownLimitation ?? null,
      })),
    };
  });
}
