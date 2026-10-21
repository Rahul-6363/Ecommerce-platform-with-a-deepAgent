/** Small text helpers shared by the routes and the retrieval path. */

/**
 * Escape a user-supplied string for safe use inside a RegExp.
 *
 * Catalogue search builds regexes from whatever the buyer typed. Without this,
 * a query containing `(` is a syntax error, and one containing `.*` scans the
 * whole collection.
 */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Rupees, grouped the Indian way: 1,23,456 rather than 123,456. */
export function inr(n: number): string {
  return `₹${Math.trunc(n).toLocaleString("en-IN")}`;
}

/** TITLE_CASE_ENUM -> "title case enum", for display. */
export function humanise(s: string): string {
  return s.replace(/_/g, " ").toLowerCase();
}
