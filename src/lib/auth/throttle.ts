/**
 * Rate limiting for the two endpoints worth attacking.
 *
 * Sign-in is the obvious one: without a limit, an attacker tries a password
 * list against a known email as fast as the network allows. Registration is
 * the less obvious one — unlimited registration lets someone fill the user
 * table, and every account they make is one more thing the catalogue and the
 * event stream carry.
 *
 * Deliberately in-process rather than Redis-backed. The platform already runs
 * with no required infrastructure, and adding a dependency for this would be
 * the only reason the app needed one. The honest cost is stated rather than
 * hidden: a single process remembers these counters, so several instances
 * behind a load balancer each enforce their own share, and a restart forgets
 * them. For a real deployment this belongs in a shared store, and the README
 * says so rather than implying the limit is airtight.
 *
 * Two keys are counted separately for sign-in, because they fail differently:
 * an attacker working one email through a password list is throttled by the
 * email key, and one working many emails from one address is throttled by the
 * IP key. Limiting only one of them leaves the other wide open.
 */

type Bucket = { count: number; firstAt: number; blockedUntil: number };

const buckets = new Map<string, Bucket>();

/** Keeps the map from growing without bound on a long-lived process. */
const SWEEP_EVERY = 500;
let writes = 0;

export type Limit = {
  /** How many attempts are allowed inside the window. */
  max: number;
  /** The window, in milliseconds. */
  windowMs: number;
  /** How long a breach locks the key out for. */
  blockMs: number;
};

/**
 * Sign-in: six attempts a minute, then a fifteen-minute lockout.
 *
 * Six is enough for someone mistyping a password they know and far too few to
 * walk a list. The lockout is long enough to make an online attack useless and
 * short enough that a locked-out real person is not left stranded.
 */
export const LOGIN_LIMIT: Limit = { max: 6, windowMs: 60_000, blockMs: 15 * 60_000 };

/** Registration: five accounts an hour from one address. */
export const REGISTER_LIMIT: Limit = { max: 5, windowMs: 60 * 60_000, blockMs: 60 * 60_000 };

export type Decision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Count one attempt against `key` and say whether it may proceed.
 *
 * Call this *before* doing the work. A limiter consulted after the password
 * check has already paid the cost it exists to avoid.
 */
export function hit(key: string, limit: Limit, now = Date.now()): Decision {
  if (++writes % SWEEP_EVERY === 0) sweep(now);

  const b = buckets.get(key);

  if (b && b.blockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((b.blockedUntil - now) / 1000),
    };
  }

  // No bucket, or the window has rolled over: start counting again.
  if (!b || now - b.firstAt > limit.windowMs) {
    buckets.set(key, { count: 1, firstAt: now, blockedUntil: 0 });
    return { allowed: true, remaining: limit.max - 1 };
  }

  b.count += 1;

  if (b.count > limit.max) {
    b.blockedUntil = now + limit.blockMs;
    return { allowed: false, retryAfterSeconds: Math.ceil(limit.blockMs / 1000) };
  }

  return { allowed: true, remaining: limit.max - b.count };
}

/**
 * Forget the counter for a key.
 *
 * Called after a *successful* sign-in, so someone who mistyped twice and then
 * got it right is not carrying a near-lockout around for the next minute.
 * Never called on failure, which is the point.
 */
export function clear(key: string): void {
  buckets.delete(key);
}

/** Drop expired buckets. */
function sweep(now: number): void {
  for (const [k, b] of buckets) {
    if (b.blockedUntil <= now && now - b.firstAt > 60 * 60_000) buckets.delete(k);
  }
}

/** Test seam: forget everything. */
export function resetThrottle(): void {
  buckets.clear();
  writes = 0;
}

/**
 * The client address, as well as it can be known behind a proxy.
 *
 * `x-forwarded-for` is spoofable by whoever can reach the app directly, so
 * this is a rate-limiting signal and never an authorization one. The leftmost
 * entry is the original client when the proxy appends correctly.
 */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
