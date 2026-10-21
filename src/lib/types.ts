/** Shared domain vocabulary. Kept free of Mongoose so engines stay pure. */

export const ISSUE_TYPES = [
  "NOT_DELIVERED", "DOA", "DAMAGED", "WRONG_ITEM",
  "MISSING_PART", "COUNTERFEIT", "NOT_AS_DESCRIBED", "LATE",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const REMEDIES = [
  "REPLACEMENT", "RESHIP", "PART_SHIPMENT", "FULL_REFUND",
  "PARTIAL_REFUND", "STORE_CREDIT", "NONE", "ESCALATE_AMBIGUOUS",
] as const;
export type Remedy = (typeof REMEDIES)[number];

export const ORDER_STATUSES = [
  "PLACED", "CONFIRMED", "PACKED", "DISPATCHED", "IN_TRANSIT",
  "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "RTO",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const CLAIM_STATES = [
  "INTAKE", "TRIAGED", "ADJUDICATED", "AWAITING_APPROVAL",
  "APPROVED", "REJECTED", "EXECUTING", "RESOLVED",
  "ESCALATED_T1", "ESCALATED_T2", "HUMAN_HANDOFF",
] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

export type RiskBand = "LOW" | "MEDIUM" | "HIGH";

/** Languages the agent accepts a complaint or an order request in. */
export const LANGUAGES = {
  en: "English", hi: "हिन्दी", kn: "ಕನ್ನಡ", ta: "தமிழ்",
  te: "తెలుగు", mr: "मराठी", bn: "বাংলা", gu: "ગુજરાતી",
} as const;
export type LangCode = keyof typeof LANGUAGES;

export type Verdict = {
  eligible: boolean;
  remedy: Remedy;
  alternatives: string[];
  amountInr: number;
  deadlineAt: string | null;
  clauseIds: string[];
  reasons: string[];
  confidence: number;
};

export type RiskReason = { factor: string; points: number; detail: string };

export type RiskVerdict = {
  shipmentId?: string;
  orderId?: string;
  score: number;
  band: RiskBand;
  reasons: RiskReason[];
};

export type EvidenceFlags = Partial<Record<
  | "photo" | "stated_fault" | "stated_missing" | "sku_mismatch"
  | "brand_mismatch" | "listing_comparison" | "no_delivery_scan"
  | "late_scan" | "tracking_corroborates" | "conflicting_evidence"
  | "image_supports_claim" | "image_contradicts_claim" | "metadata_suspect",
  boolean
>>;

/** What the fraud analyst returns. Advisory only — it never decides money. */
export type AuthenticityAssessment = {
  verdict: "LIKELY_GENUINE" | "INCONCLUSIVE" | "LIKELY_FABRICATED";
  score: number;          // 0..100, higher = more suspicious
  signals: RiskReason[];  // every point traceable to a named signal
  narrative: string;
  reviewRequired: boolean;
};
