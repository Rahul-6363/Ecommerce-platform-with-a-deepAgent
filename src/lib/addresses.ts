/**
 * Where a buyer's parcels go.
 *
 * The schema for this has existed since the first commit and there was no way
 * to add one: a buyer got whatever address registration captured and was stuck
 * with it for ever. That is a real gap rather than a cosmetic one, because
 * `pinTier` feeds `deliveryForecast` and `scoreRisk` — so an out-of-date
 * address silently produces a confident, wrong delivery date.
 *
 * Normalisation lives here rather than in the route, because two routes and
 * the agent all write addresses and they have to agree about what a saved
 * address looks like. In particular the city, state and tier are **derived**
 * from the pincode and never taken on trust from the client: a form that lets
 * the browser post `pinTier: 1` lets it post a three-day delivery promise for
 * a village.
 */
import { pinFacts, adviseAddress, type AddressAdvice } from "@/lib/engines/pincode";
import type { LeanAddress } from "@/models";

/** What a caller may set. Everything else about an address is computed. */
export type AddressInput = {
  label?: string;
  line: string;
  landmark?: string;
  city?: string;
  state?: string;
  pincode: string;
  phone?: string;
};

/** `LeanAddress` already carries the phone; the alias documents intent. */
export type SavedAddress = LeanAddress;

/** Labels a buyer can pick, so the list stays readable. */
export const ADDRESS_LABELS = ["Home", "Work", "Other"] as const;

/** Mongoose rejects an address without these, and so should we, sooner. */
export class AddressError extends Error {
  readonly advice: AddressAdvice[];
  constructor(advice: AddressAdvice[]) {
    super(advice[0]?.message ?? "That address cannot be delivered to.");
    this.name = "AddressError";
    this.advice = advice;
  }
}

/**
 * Turn what the buyer gave us into what we store.
 *
 * Throws `AddressError` for the two things that make an address undeliverable
 * — no usable street line, no real pincode — and silently accepts the rest. A
 * missing landmark is a risk score, not a reason to refuse the order.
 */
export function newAddress(input: AddressInput): SavedAddress {
  const advice = adviseAddress(input);
  const blocking = advice.filter((a) => a.severity === "blocking");
  if (blocking.length > 0) throw new AddressError(blocking);

  const facts = pinFacts(input.pincode);

  return {
    label: pickLabel(input.label),
    line: clean(input.line, 160),
    landmark: clean(input.landmark ?? "", 80),
    // What the buyer typed wins; the pincode fills the gap. Deriving over a
    // stated value would overwrite the suburb they know with the metro we
    // guessed.
    city: clean(input.city ?? "", 60) || facts.city,
    state: clean(input.state ?? "", 60) || facts.state,
    pincode: facts.pincode,
    // Never from the client. This number decides delivery dates and dispatch
    // risk, and a browser that can set it can promise a date we cannot keep.
    pinTier: facts.tier,
    phone: digits(input.phone ?? "").slice(-10),
  };
}

/**
 * Advice worth showing about an address that is otherwise fine.
 *
 * Separate from `newAddress` so a form can warn while the buyer is still
 * typing, without a rejected save.
 */
export function addressAdvice(input: Partial<AddressInput>): AddressAdvice[] {
  return adviseAddress(input);
}

/**
 * One line, as a courier would read it.
 *
 * Used on the checkout review and spoken back after dictation, so both agree.
 */
export function formatAddress(a: Partial<SavedAddress>): string {
  return [a.line, withPreposition(a.landmark), a.city, a.state, a.pincode]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * The address the agent should read out, which is shorter than the label.
 *
 * A spoken address does not need the state — the buyer knows which state they
 * live in, and hearing it back is three wasted seconds. The pincode is read as
 * grouped digits because six digits run together are unintelligible aloud.
 */
export function spokenAddress(a: Partial<SavedAddress>): string {
  const parts = [a.line, withPreposition(a.landmark), a.city]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  const pin = (a.pincode ?? "").trim();
  if (pin.length === 6) parts.push(`pincode ${pin.slice(0, 3)} ${pin.slice(3)}`);
  return parts.join(", ");
}

/**
 * A landmark with "near" in front, unless it already says where it is.
 *
 * Seeded and hand-typed landmarks often carry their own preposition
 * ("Opposite Forum Mall"), and prefixing another produced "near Opposite
 * Forum Mall" on the checkout screen.
 */
function withPreposition(landmark?: string): string {
  const l = (landmark ?? "").trim();
  if (!l) return "";
  return /^(near|opposite|opp\.?|behind|beside|next to|above|below|in front of)\b/i.test(l)
    ? l
    : `near ${l}`;
}

function pickLabel(raw?: string): string {
  const want = clean(raw ?? "", 20);
  const match = ADDRESS_LABELS.find((l) => l.toLowerCase() === want.toLowerCase());
  return match ?? (want || "Home");
}

function clean(s: string, max: number): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function digits(s: string): string {
  return (s ?? "").replace(/\D/g, "");
}
