/**
 * Mongoose schemas.
 *
 * Models are registered through a `register()` helper that reuses an existing
 * compiled model, because Next.js re-evaluates modules on hot reload and
 * `mongoose.model()` throws on a duplicate name.
 */
import mongoose, { Schema, type Model, type InferSchemaType } from "mongoose";
import {
  ISSUE_TYPES,
  REMEDIES,
  ORDER_STATUSES,
  CLAIM_STATES,
  LANGUAGES,
} from "@/lib/types";

function register<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T>) ?? mongoose.model<T>(name, schema);
}

const opts = { timestamps: true, versionKey: false as const };

/* ──────────────────────────────── Users ──────────────────────────────── */

const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: ["buyer", "operator", "seller"], default: "buyer", index: true },
    phone: { type: String, default: "" },
    lang: { type: String, enum: Object.keys(LANGUAGES), default: "en" },
    // Buyers who want a replacement fast vs. the money back. Drives the
    // remedy tie-break in the entitlement engine.
    priority: { type: String, enum: ["speed", "money"], default: "money" },
    addresses: [
      {
        _id: false,
        label: { type: String, default: "Home" },
        line: { type: String, required: true },
        landmark: { type: String, default: "" },
        city: { type: String, default: "" },
        state: { type: String, default: "" },
        pincode: { type: String, required: true },
        pinTier: { type: Number, min: 1, max: 4, default: 2 },
        // Per address, not per account: the parcel going to your office needs
        // the number someone there will answer, and a courier who cannot call
        // is the commonest cause of a failed first attempt.
        phone: { type: String, default: "" },
      },
    ],
    // Prior return-to-origin count: a real risk input, not decoration.
    priorRto: { type: Number, default: 0 },
    // Claim history feeds the fraud analyst base rate.
    rejectedClaims: { type: Number, default: 0 },
    totalClaims: { type: Number, default: 0 },
    storeCreditInr: { type: Number, default: 0 },
  },
  opts,
);
UserSchema.index({ role: 1, email: 1 });
export type UserDoc = InferSchemaType<typeof UserSchema> & { _id: mongoose.Types.ObjectId };
export const User = register("User", UserSchema);

/* ────────────────────────────── Catalogue ────────────────────────────── */

const ProductSchema = new Schema(
  {
    sku: { type: String, required: true, unique: true },
    title: { type: String, required: true, trim: true },
    brand: { type: String, required: true, index: true },
    category: { type: String, required: true, index: true },
    subcategory: { type: String, default: "" },
    description: { type: String, default: "" },
    // Structured attributes the agent matches a spoken requirement against.
    attributes: { type: Schema.Types.Mixed, default: {} },
    // Keywords in several languages so retrieval works with no model at all.
    tags: { type: [String], default: [], index: true },
    /**
     * The needs this product answers, in the buyer's words rather than the
     * catalogue's.
     *
     * A buyer says "something for my mother's back pain", not "orthopaedic
     * memory foam pillow". Matching only on title and tags means the pillow we
     * stock is invisible to the person who most needs it — which is the single
     * biggest reason a buyer ends up scrolling. These are the phrases a real
     * need is expressed in, and the sweep searches them like any other text.
     */
    solves: { type: [String], default: [], index: true },
    priceInr: { type: Number, required: true, min: 0 },
    mrpInr: { type: Number, required: true, min: 0 },
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0 },
    stock: { type: Number, default: 0, min: 0 },
    sellerId: { type: String, required: true, index: true },
    policyId: { type: String, required: true },
    /**
     * The product photograph, served from `public/products/<sku>.jpg`.
     *
     * Downloaded into the repository rather than hotlinked, so the storefront
     * does not depend on a third party staying up — six of the original URLs
     * 404'd during the import, which is exactly the failure a hotlink would
     * have shipped to a buyer instead of to the build.
     *
     * `imageEmoji` is kept as the fallback: a card whose photo fails to load
     * shows the emoji on its accent tint rather than a broken-image icon.
     */
    imageUrl: { type: String, default: "" },
    imageEmoji: { type: String, default: "📦" },
    accentHex: { type: String, default: "#f97316" },
    // Box contents: what a MISSING_PART claim is adjudicated against.
    boxContents: { type: [String], default: [] },
    codEligible: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
  },
  opts,
);
ProductSchema.index({ title: "text", description: "text", tags: "text", brand: "text" });
ProductSchema.index({ category: 1, priceInr: 1 });
export type ProductDoc = InferSchemaType<typeof ProductSchema> & { _id: mongoose.Types.ObjectId };
export const Product = register("Product", ProductSchema);

const SellerSchema = new Schema(
  {
    sellerId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    city: { type: String, default: "" },
    ratingAvg: { type: Number, default: 0 },
    // The rate on the seller's record before the platform observed anything.
    // Kept as the prior that `sellerStanding` blends toward while the sample of
    // real orders is still small.
    defectRatePct: { type: Number, default: 0 },
    fulfilmentSlaDays: { type: Number, default: 4 },

    /* ── Observed performance ──────────────────────────────────────────
     *
     * The other half of the accountability loop. Buyers were already paying
     * for a seller's failure rate in the true-cost comparison, but the rate
     * never moved however badly a seller behaved — so the one party able to
     * fix the problem had no reason to. These counters are incremented from
     * the claim decision path, which is the only place that can honestly know
     * whether a fault was real.
     */
    ordersFulfilled: { type: Number, default: 0 },
    /** Claims APPROVED against this seller. Only findings count, never filings. */
    upheldClaims: { type: Number, default: 0 },
    /** Claims filed and rejected on review. Reported to the seller, never counted. */
    rejectedClaims: { type: Number, default: 0 },
    /** Rupees refunded or credited to buyers because of this seller's faults. */
    refundedInr: { type: Number, default: 0 },
    /** Set when standing crosses into a band that restricts listings. */
    listingStatus: {
      type: String,
      enum: ["ACTIVE", "THROTTLED", "SUSPENDED"],
      default: "ACTIVE",
      index: true,
    },
  },
  opts,
);
export type SellerDoc = InferSchemaType<typeof SellerSchema>;
export const Seller = register("Seller", SellerSchema);

/* ─────────────────────────────── Policy ─────────────────────────────── */

const PolicySchema = new Schema(
  {
    policyId: { type: String, required: true, unique: true },
    category: { type: String, required: true },
    returnWindowDays: { type: Number, required: true },
    replacementAllowed: { type: Boolean, default: true },
    refundSlaDays: { type: Number, required: true },
    lateCompensation: { type: Boolean, default: false },
    clauses: [
      {
        _id: false,
        id: { type: String, required: true },
        text: { type: String, required: true },
        tags: { type: [String], default: [] },
      },
    ],
  },
  opts,
);
export type PolicyDoc = InferSchemaType<typeof PolicySchema>;
export const Policy = register("Policy", PolicySchema);

/* ─────────────────────────── Cart and Orders ─────────────────────────── */

const CartSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    items: [
      {
        _id: false,
        sku: { type: String, required: true },
        qty: { type: Number, default: 1, min: 1 },
        // Provenance: did a human click Add, or did the agent put it here?
        addedByAgent: { type: Boolean, default: false },
        agentRationale: { type: String, default: "" },
      },
    ],
  },
  opts,
);
export type CartDoc = InferSchemaType<typeof CartSchema>;
export const Cart = register("Cart", CartSchema);

const OrderSchema = new Schema(
  {
    orderNo: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    items: [
      {
        _id: false,
        sku: { type: String, required: true },
        title: { type: String, required: true },
        qty: { type: Number, default: 1 },
        unitPriceInr: { type: Number, required: true },
        sellerId: { type: String, required: true },
        policyId: { type: String, required: true },
        category: { type: String, required: true },
        brand: { type: String, default: "" },
        boxContents: { type: [String], default: [] },
      },
    ],
    amountInr: { type: Number, required: true },
    paymentMode: { type: String, enum: ["COD", "PREPAID"], default: "PREPAID", index: true },
    paymentStatus: {
      type: String,
      enum: ["PENDING", "PAID", "REFUNDED", "PARTIAL_REFUND"],
      default: "PENDING",
    },
    status: { type: String, enum: ORDER_STATUSES, default: "PLACED", index: true },
    address: {
      line: { type: String, required: true },
      landmark: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      pincode: { type: String, required: true },
      pinTier: { type: Number, default: 2 },
      // Copied from the account address at order time, not referenced: editing
      // your address later must not change where a dispatched parcel was going.
      phone: { type: String, default: "" },
    },
    /**
     * What the buyer told the courier about this delivery.
     *
     * On the order rather than the saved address, because it is about one
     * parcel and one day — "leave with the guard", "call before 7pm", "gate
     * code 4417" — and carrying it over to every future order would be wrong.
     * It is free text on purpose: the whole point is that it covers the case
     * no dropdown anticipated.
     */
    deliveryInstructions: { type: String, default: "", maxlength: 400 },
    placedAt: { type: Date, default: () => new Date() },
    promisedBy: { type: Date, required: true },
    deliveredAt: { type: Date, default: null },
    // Snapshot of buyer traits at order time: risk must be reproducible even
    // after the buyer profile changes.
    buyerPriority: { type: String, enum: ["speed", "money"], default: "money" },
    buyerPriorRto: { type: Number, default: 0 },
    stockAvailable: { type: Boolean, default: true },
    // Set when the conversational agent placed this order on the buyer behalf.
    placedByAgent: { type: Boolean, default: false },
    agentSessionId: { type: String, default: "" },

    /* ── Proactive rescue ──────────────────────────────────────────────
     *
     * State for the rescue agent, kept on the order rather than in memory for
     * the same reason the claim plan is: a tick that runs twenty minutes later
     * has to know what the last one already did.
     *
     * `rescueActions` is the idempotency record. Without it a second tick
     * re-proposes the question the buyer is already looking at, and
     * "prevention" becomes pestering. `rescueAttempts` is the retry limit:
     * past it the order goes to a person instead of a fourth attempt.
     */
    rescueAttempts: { type: Number, default: 0 },
    /** Action names already executed or queued on this order. */
    rescueActions: { type: [String], default: [] },
    rescueLastAt: { type: Date, default: null },
    /** Risk score when the rescue agent first acted, to measure the outcome. */
    rescueBaselineScore: { type: Number, default: null },
    rescueState: {
      type: String,
      enum: ["NONE", "WATCHING", "INTERVENED", "AWAITING_APPROVAL", "RESOLVED", "HANDOFF"],
      default: "NONE",
      index: true,
    },
  },
  opts,
);
OrderSchema.index({ userId: 1, createdAt: -1 });
export type OrderDoc = InferSchemaType<typeof OrderSchema> & { _id: mongoose.Types.ObjectId };
export const Order = register("Order", OrderSchema);

const ShipmentSchema = new Schema(
  {
    shipmentId: { type: String, required: true, unique: true, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    courier: { type: String, required: true },
    awb: { type: String, default: "" },
    dispatchedAt: { type: Date, default: null },
    promisedBy: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    phoneReachable: { type: Boolean, default: true },
    status: {
      type: String,
      enum: [
        "PENDING", "IN_TRANSIT", "OUT_FOR_DELIVERY",
        "DELIVERED", "HELD", "AT_PICKUP_POINT", "RTO",
      ],
      default: "PENDING",
    },
    scans: [
      {
        _id: false,
        at: { type: Date, required: true },
        location: { type: String, default: "" },
        note: { type: String, default: "" },
        code: { type: String, default: "" },
      },
    ],
    // Last risk verdict, cached so the operator list does not rescore on read.
    riskScore: { type: Number, default: null },
    riskBand: { type: String, enum: ["LOW", "MEDIUM", "HIGH", null], default: null },
  },
  opts,
);
export type ShipmentDoc = InferSchemaType<typeof ShipmentSchema> & { _id: mongoose.Types.ObjectId };
export const Shipment = register("Shipment", ShipmentSchema);

/* ─────────────────────────────── Claims ─────────────────────────────── */

const ClaimSchema = new Schema(
  {
    claimNo: { type: String, required: true, unique: true, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sku: { type: String, default: "" },

    // What the buyer actually said, in their own language, plus the English
    // translation the agent works from. Both are kept: the operator must be
    // able to see the original.
    rawComplaint: { type: String, required: true },
    lang: { type: String, default: "en" },
    translatedComplaint: { type: String, default: "" },
    inputMode: { type: String, enum: ["text", "voice"], default: "text" },
    voiceTranscript: { type: String, default: "" },

    issueType: { type: String, enum: ISSUE_TYPES, default: null },
    triageConfidence: { type: Number, default: 0 },
    evidenceFlags: { type: Schema.Types.Mixed, default: {} },

    // The entitlement engine verdict. Written once, never edited by a model.
    verdict: {
      eligible: { type: Boolean, default: false },
      remedy: { type: String, enum: REMEDIES, default: "ESCALATE_AMBIGUOUS" },
      alternatives: { type: [String], default: [] },
      amountInr: { type: Number, default: 0 },
      deadlineAt: { type: Date, default: null },
      clauseIds: { type: [String], default: [] },
      reasons: { type: [String], default: [] },
      confidence: { type: Number, default: 0 },
    },

    // The fraud analyst assessment. Advisory: it can demand review, it can
    // never decide the remedy or the amount.
    authenticity: {
      verdict: {
        type: String,
        enum: ["LIKELY_GENUINE", "INCONCLUSIVE", "LIKELY_FABRICATED", null],
        default: null,
      },
      score: { type: Number, default: 0 },
      signals: { type: [{ _id: false, factor: String, points: Number, detail: String }], default: [] },
      narrative: { type: String, default: "" },
      reviewRequired: { type: Boolean, default: true },
    },

    /* ── Per-issue adjudication ────────────────────────────────────────
     *
     * One complaint can carry two real problems, and the claim used to hold
     * exactly one `issueType` and one `verdict` — so the second was recorded
     * in triage and then had nowhere to go.
     *
     * This array is additive and optional: a single-issue claim written
     * before this existed, or seeded by the demo data, has an empty `issues`
     * and reads exactly as it always did through `issueType` and `verdict`.
     * Those two fields are still written for every claim and remain the
     * headline answer, so nothing downstream had to learn about this array to
     * keep working.
     *
     * `payableInr` is the per-issue amount AFTER the cross-issue rules, and
     * the sum across the array is capped at the order value by
     * `adjudicateIssues`. `verdict.amountInr` on each row is what the
     * entitlement engine returned for that issue alone, kept so an operator
     * can see what was trimmed and why.
     */
    issues: {
      type: [
        {
          _id: false,
          /** Stable within the claim, so one issue can be decided by name. */
          key: { type: String, required: true },
          issueType: { type: String, enum: ISSUE_TYPES, required: true },
          excerpt: { type: String, default: "" },
          confidence: { type: Number, default: 0 },
          evidenceFlags: { type: Schema.Types.Mixed, default: {} },
          /** Evidence filenames that bear on this issue specifically. */
          evidenceFilenames: { type: [String], default: [] },
          status: {
            type: String,
            enum: ["ELIGIBLE", "NOT_ELIGIBLE", "SUBSUMED", "CAPPED", "NEEDS_REVIEW"],
            default: "NEEDS_REVIEW",
          },
          /** What this issue actually pays after the aggregate cap. */
          payableInr: { type: Number, default: 0 },
          /** Why payableInr differs from verdict.amountInr, when it does. */
          adjustments: { type: [String], default: [] },
          subsumedBy: { type: String, default: "" },
          /** The engine's verdict for this issue alone. Never edited. */
          verdict: {
            eligible: { type: Boolean, default: false },
            remedy: { type: String, enum: REMEDIES, default: "ESCALATE_AMBIGUOUS" },
            alternatives: { type: [String], default: [] },
            amountInr: { type: Number, default: 0 },
            deadlineAt: { type: Date, default: null },
            clauseIds: { type: [String], default: [] },
            reasons: { type: [String], default: [] },
            confidence: { type: Number, default: 0 },
          },
          /**
           * Per-issue resolution, so one issue can be rejected while another
           * is approved without the claim lying about either.
           */
          resolution: {
            decision: { type: String, enum: ["APPROVED", "REJECTED", null], default: null },
            decidedBy: { type: String, default: "" },
            decidedAt: { type: Date, default: null },
            note: { type: String, default: "" },
            /** The amount actually approved for this issue. */
            approvedInr: { type: Number, default: 0 },
          },
        },
      ],
      default: [],
    },

    /** Set when more than one distinct issue was read from the complaint. */
    multiIssue: { type: Boolean, default: false },
    /** Aggregate across `issues`, capped at the order value. */
    totalPayableInr: { type: Number, default: 0 },
    /** What the per-issue remedies summed to before the cap was applied. */
    uncappedTotalInr: { type: Number, default: 0 },

    state: { type: String, enum: CLAIM_STATES, default: "INTAKE", index: true },

    // The letter the agent drafted for the buyer, after the verifier passed it.
    draftMessage: { type: String, default: "" },
    draftVerified: { type: Boolean, default: false },
    verifierNotes: { type: [String], default: [] },

    evidence: [
      {
        _id: false,
        kind: { type: String, enum: ["image", "audio", "text"], required: true },
        filename: { type: String, default: "" },
        mimeType: { type: String, default: "" },
        bytes: { type: Number, default: 0 },
        // Stored as a data URL for images so the whole platform runs with no
        // object store. Swap for S3/GridFS by changing this one field.
        dataUrl: { type: String, default: "" },
        sha256: { type: String, default: "" },
        caption: { type: String, default: "" },
        visionFindings: { type: Schema.Types.Mixed, default: null },
        uploadedAt: { type: Date, default: () => new Date() },
      },
    ],

    // Approval gate.
    approval: {
      required: { type: Boolean, default: true },
      decidedBy: { type: String, default: "" },
      decidedAt: { type: Date, default: null },
      decision: { type: String, enum: ["APPROVED", "REJECTED", null], default: null },
      note: { type: String, default: "" },
      // What the operator was asked to approve, verbatim.
      requestedAction: { type: String, default: "" },
    },

    deadlineAt: { type: Date, default: null, index: true },
    escalationTier: { type: Number, default: 0 },
    resolvedAt: { type: Date, default: null },
    // Agent run budgets, so a stuck case routes to a human instead of looping.
    stepsUsed: { type: Number, default: 0 },
    replansUsed: { type: Number, default: 0 },

    // The orchestrator's plan, stored rather than held in memory, so an
    // approval posted minutes later resumes at exactly the step that stopped
    // and the operator can see the plan that produced the decision.
    plan: {
      goal: { type: String, default: "" },
      source: { type: String, default: "" },
      steps: {
        type: [
          {
            _id: false,
            id: { type: Number, required: true },
            title: { type: String, default: "" },
            tool: { type: String, required: true },
            args: { type: Schema.Types.Mixed, default: {} },
            why: { type: String, default: "" },
            needsApproval: { type: Boolean, default: false },
            status: { type: String, default: "pending" },
            summary: { type: String, default: "" },
            ms: { type: Number, default: 0 },
          },
        ],
        default: [],
      },
    },
  },
  opts,
);
ClaimSchema.index({ state: 1, createdAt: -1 });
ClaimSchema.index({ userId: 1, createdAt: -1 });
export type ClaimDoc = InferSchemaType<typeof ClaimSchema> & { _id: mongoose.Types.ObjectId };
export const Claim = register("Claim", ClaimSchema);

/* ──────────────────────── Event stream (append-only) ──────────────────────── */

const EventSchema = new Schema(
  {
    seq: { type: Number, required: true, index: true },
    type: { type: String, required: true, index: true },
    // Who did it: an agent name, "operator", "buyer", or "system".
    actor: { type: String, required: true },
    // Correlation keys so the UI can project a single case or a single buyer.
    claimId: { type: Schema.Types.ObjectId, ref: "Claim", default: null, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    sessionId: { type: String, default: "", index: true },
    summary: { type: String, default: "" },
    payload: { type: Schema.Types.Mixed, default: {} },
    at: { type: Date, default: () => new Date(), index: true },
  },
  { versionKey: false as const },
);
EventSchema.index({ at: -1 });
export type EventDoc = InferSchemaType<typeof EventSchema> & { _id: mongoose.Types.ObjectId };
export const Event = register("Event", EventSchema);

/* ─────────────────────── Agent conversation sessions ─────────────────────── */

const AgentSessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: ["shopping", "complaint"], default: "shopping" },
    lang: { type: String, default: "en" },
    messages: [
      {
        _id: false,
        role: { type: String, enum: ["user", "assistant", "tool", "system"], required: true },
        content: { type: String, default: "" },
        // Tool calls are kept so the trace panel can replay the whole run.
        toolName: { type: String, default: "" },
        toolArgs: { type: Schema.Types.Mixed, default: null },
        toolResult: { type: Schema.Types.Mixed, default: null },
        at: { type: Date, default: () => new Date() },
      },
    ],
    // Requirements the agent has extracted so far, refined across turns.
    requirements: { type: Schema.Types.Mixed, default: {} },
    closed: { type: Boolean, default: false },
  },
  opts,
);
export type AgentSessionDoc = InferSchemaType<typeof AgentSessionSchema>;
export const AgentSession = register("AgentSession", AgentSessionSchema);

/* ──────────────────────────────── Outbox ──────────────────────────────── */

const MailSchema = new Schema(
  {
    to: { type: String, required: true },
    from: { type: String, default: "" },
    subject: { type: String, required: true },
    html: { type: String, default: "" },
    text: { type: String, default: "" },
    template: { type: String, default: "" },
    // "sent" when Nodemailer handed it to an SMTP server; "captured" when no
    // SMTP is configured and it was written here instead; "failed" on error.
    status: { type: String, enum: ["sent", "captured", "failed"], default: "captured", index: true },
    messageId: { type: String, default: "" },
    error: { type: String, default: "" },
    claimId: { type: Schema.Types.ObjectId, ref: "Claim", default: null },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    sentAt: { type: Date, default: () => new Date(), index: true },
  },
  { versionKey: false as const },
);
export type MailDoc = InferSchemaType<typeof MailSchema> & { _id: mongoose.Types.ObjectId };
export const MailLog = register("MailLog", MailSchema);

/* ─────────────────── Simulated clock and demo controls ─────────────────── */

const SettingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, default: null },
  },
  opts,
);
export type SettingDoc = InferSchemaType<typeof SettingSchema>;
export const Setting = register("Setting", SettingSchema);

/* ───────────────────────────── Refunds ─────────────────────────────
 *
 * A refund the buyer cannot see is a refund they will ask about.
 *
 * `paymentStatus: "REFUNDED"` on the order was true but useless: it does not
 * say how much, to where, by when, or what it was for. So every money movement
 * gets a row here with a settlement date computed from the policy SLA, and the
 * buyer sees the same row the operator does.
 *
 * Append-only in practice: a refund is amended by writing its next state, not
 * by editing the amount, so the trail of what was promised stays intact.
 */

const RefundSchema = new Schema(
  {
    refundNo: { type: String, required: true, unique: true, index: true },
    claimId: { type: Schema.Types.ObjectId, ref: "Claim", default: null, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** The seller whose fault this was, so the cost is attributable. */
    sellerId: { type: String, default: "" },

    /** What was approved. Mirrors the claim verdict, never recomputed. */
    remedy: { type: String, default: "" },
    amountInr: { type: Number, required: true, min: 0 },

    /** Where the money goes, which differs by how the buyer paid. */
    method: {
      type: String,
      enum: ["ORIGINAL_PAYMENT", "BANK_TRANSFER", "STORE_CREDIT"],
      default: "ORIGINAL_PAYMENT",
    },
    /** Masked destination, e.g. "UPI ···4821". Never a full instrument. */
    destination: { type: String, default: "" },

    status: {
      type: String,
      enum: ["INITIATED", "PROCESSING", "SETTLED", "FAILED"],
      default: "INITIATED",
      index: true,
    },
    initiatedAt: { type: Date, default: () => new Date() },
    /** The date promised to the buyer, from the policy refund SLA. */
    expectedBy: { type: Date, required: true },
    settledAt: { type: Date, default: null },
    /** Policy clauses that justify the amount. Carried so the buyer can check. */
    clauseIds: { type: [String], default: [] },
    note: { type: String, default: "" },
  },
  opts,
);
RefundSchema.index({ userId: 1, createdAt: -1 });
export type RefundDoc = InferSchemaType<typeof RefundSchema> & { _id: mongoose.Types.ObjectId };
export const Refund = register("Refund", RefundSchema);

/* ──────────────────────── Competing seller offers ────────────────────────
 *
 * The same SKU, listed by several sellers at different prices, dispatch
 * speeds and defect rates. This is what makes a comparison real rather than
 * rhetorical: without it, "the agent compares offers" is one row against
 * itself. A product's own `priceInr`/`sellerId` remains the default offer, and
 * these are the alternatives beside it.
 *
 * Every seller here is fictional and the platform says so on screen. If a
 * legitimate affiliate feed is ever approved, it populates this collection and
 * nothing in the solver changes.
 */

const OfferSchema = new Schema(
  {
    sku: { type: String, required: true, index: true },
    sellerId: { type: String, required: true, index: true },
    priceInr: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    codEligible: { type: Boolean, default: true },
    // Overrides the seller's own SLA for this listing when the seller stocks
    // this particular item closer to the buyer.
    fulfilmentSlaDays: { type: Number, default: null },
    active: { type: Boolean, default: true },
  },
  opts,
);
OfferSchema.index({ sku: 1, sellerId: 1 }, { unique: true });
export type OfferDoc = InferSchemaType<typeof OfferSchema> & { _id: mongoose.Types.ObjectId };
export const Offer = register("Offer", OfferSchema);

/* ───────────────── Plain-object shapes for .lean() reads ─────────────────
 *
 * `InferSchemaType` types an array field as a Mongoose DocumentArray, whose
 * element type does not survive `.lean()` — callers then get `any` for each
 * element and `noImplicitAny` rejects the callback. These interfaces describe
 * what a lean read actually returns, and queries that iterate a subdocument
 * array pass one as the `.lean<T>()` type argument.
 */

export type LeanAddress = {
  label: string; line: string; landmark: string;
  city: string; state: string; pincode: string; pinTier: number;
  phone: string;
};

export type LeanCart = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  items: { sku: string; qty: number; addedByAgent: boolean; agentRationale: string }[];
};

export type LeanOrderItem = {
  sku: string; title: string; qty: number; unitPriceInr: number;
  sellerId: string; policyId: string; category: string; brand: string;
  boxContents: string[];
};

export type LeanOrder = {
  _id: mongoose.Types.ObjectId;
  orderNo: string;
  userId: mongoose.Types.ObjectId;
  items: LeanOrderItem[];
  amountInr: number;
  paymentMode: "COD" | "PREPAID";
  paymentStatus: "PENDING" | "PAID" | "REFUNDED" | "PARTIAL_REFUND";
  status: string;
  address: Omit<LeanAddress, "label">;
  /** What the buyer told the courier about this one delivery. */
  deliveryInstructions: string;
  placedAt: Date;
  promisedBy: Date;
  deliveredAt: Date | null;
  buyerPriority: "speed" | "money";
  buyerPriorRto: number;
  stockAvailable: boolean;
  placedByAgent: boolean;
  rescueAttempts: number;
  rescueActions: string[];
  rescueLastAt: Date | null;
  rescueBaselineScore: number | null;
  rescueState: "NONE" | "WATCHING" | "INTERVENED" | "AWAITING_APPROVAL" | "RESOLVED" | "HANDOFF";
  agentSessionId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type LeanScan = { at: Date; location: string; note: string; code: string };

export type LeanShipment = {
  _id: mongoose.Types.ObjectId;
  shipmentId: string;
  orderId: mongoose.Types.ObjectId;
  courier: string; awb: string;
  dispatchedAt: Date | null;
  promisedBy: Date;
  attempts: number;
  phoneReachable: boolean;
  status: string;
  scans: LeanScan[];
  riskScore: number | null;
  riskBand: "LOW" | "MEDIUM" | "HIGH" | null;
};

export type LeanClause = { id: string; text: string; tags: string[] };

export type LeanPolicy = {
  _id: mongoose.Types.ObjectId;
  policyId: string; category: string;
  returnWindowDays: number; replacementAllowed: boolean;
  refundSlaDays: number; lateCompensation: boolean;
  clauses: LeanClause[];
};

export type LeanEvidence = {
  kind: "image" | "audio" | "text";
  filename: string; mimeType: string; bytes: number;
  dataUrl: string; sha256: string; caption: string;
  visionFindings: Record<string, unknown> | null;
  uploadedAt: Date;
};

export type LeanClaimIssue = {
  key: string;
  issueType: string;
  excerpt: string;
  confidence: number;
  evidenceFlags: Record<string, boolean>;
  evidenceFilenames: string[];
  status: "ELIGIBLE" | "NOT_ELIGIBLE" | "SUBSUMED" | "CAPPED" | "NEEDS_REVIEW";
  payableInr: number;
  adjustments: string[];
  subsumedBy: string;
  verdict: {
    eligible: boolean; remedy: string; alternatives: string[];
    amountInr: number; deadlineAt: Date | null; clauseIds: string[];
    reasons: string[]; confidence: number;
  };
  resolution: {
    decision: "APPROVED" | "REJECTED" | null;
    decidedBy: string;
    decidedAt: Date | null;
    note: string;
    approvedInr: number;
  };
};

export type LeanClaim = {
  _id: mongoose.Types.ObjectId;
  claimNo: string;
  orderId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  sku: string;
  rawComplaint: string; lang: string; translatedComplaint: string;
  inputMode: "text" | "voice"; voiceTranscript: string;
  issueType: string | null;
  triageConfidence: number;
  evidenceFlags: Record<string, boolean>;
  verdict: {
    eligible: boolean; remedy: string; alternatives: string[];
    amountInr: number; deadlineAt: Date | null; clauseIds: string[];
    reasons: string[]; confidence: number;
  };
  authenticity: {
    verdict: string | null; score: number;
    signals: { factor: string; points: number; detail: string }[];
    narrative: string; reviewRequired: boolean;
  };
  /**
   * Per-issue rows. Empty on a single-issue claim, including every claim
   * written before this field existed — `issueType` and `verdict` remain the
   * headline answer either way.
   */
  issues: LeanClaimIssue[];
  multiIssue: boolean;
  totalPayableInr: number;
  uncappedTotalInr: number;
  state: string;
  draftMessage: string; draftVerified: boolean; verifierNotes: string[];
  evidence: LeanEvidence[];
  approval: {
    required: boolean; decidedBy: string; decidedAt: Date | null;
    decision: "APPROVED" | "REJECTED" | null; note: string; requestedAction: string;
  };
  deadlineAt: Date | null;
  escalationTier: number;
  resolvedAt: Date | null;
  stepsUsed: number; replansUsed: number;
  plan: {
    goal: string;
    source: string;
    steps: {
      id: number; title: string; tool: string;
      args: Record<string, unknown>; why: string;
      needsApproval: boolean; status: string; summary: string; ms: number;
    }[];
  };
  createdAt: Date; updatedAt: Date;
};

export type LeanUser = {
  _id: mongoose.Types.ObjectId;
  email: string; passwordHash: string; name: string;
  role: "buyer" | "operator" | "seller";
  phone: string; lang: string; priority: "speed" | "money";
  addresses: LeanAddress[];
  priorRto: number; rejectedClaims: number; totalClaims: number;
  storeCreditInr: number;
  createdAt: Date; updatedAt: Date;
};

export type LeanAgentSession = {
  _id: mongoose.Types.ObjectId;
  sessionId: string;
  userId: mongoose.Types.ObjectId;
  kind: "shopping" | "complaint";
  lang: string;
  messages: {
    role: "user" | "assistant" | "tool" | "system";
    content: string; toolName: string;
    toolArgs: Record<string, unknown> | null;
    toolResult: unknown; at: Date;
  }[];
  requirements: Record<string, unknown>;
  closed: boolean;
};

export type LeanOffer = {
  _id: mongoose.Types.ObjectId;
  sku: string;
  sellerId: string;
  priceInr: number;
  stock: number;
  codEligible: boolean;
  fulfilmentSlaDays: number | null;
  active: boolean;
};

export type LeanSeller = {
  _id: mongoose.Types.ObjectId;
  sellerId: string;
  name: string;
  city: string;
  ratingAvg: number;
  defectRatePct: number;
  fulfilmentSlaDays: number;
  ordersFulfilled: number;
  upheldClaims: number;
  rejectedClaims: number;
  refundedInr: number;
  listingStatus: "ACTIVE" | "THROTTLED" | "SUSPENDED";
};

export type LeanRefund = {
  _id: mongoose.Types.ObjectId;
  refundNo: string;
  claimId: mongoose.Types.ObjectId | null;
  orderId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  sellerId: string;
  remedy: string;
  amountInr: number;
  method: "ORIGINAL_PAYMENT" | "BANK_TRANSFER" | "STORE_CREDIT";
  destination: string;
  status: "INITIATED" | "PROCESSING" | "SETTLED" | "FAILED";
  initiatedAt: Date;
  expectedBy: Date;
  settledAt: Date | null;
  clauseIds: string[];
  note: string;
  createdAt: Date;
  updatedAt: Date;
};
