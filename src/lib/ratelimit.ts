/**
 * Tiny in-memory IP-based rate limiter. Per-process — fine for single-region
 * fly setup. For multi-region or scale, swap for Upstash/Redis.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Past this many buckets, expired ones are swept on the next call. One bucket
 *  per visitor address was never removed, so the map grew for the life of the
 *  process. */
export const PRUNE_AT = 5_000;

let lastPruneAt = 0;

// At most once a second, so a table full of live buckets isn't rescanned on
// every request.
function prune(now: number): void {
  if (now - lastPruneAt < 1_000) return;
  lastPruneAt = now;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

/** For tests. */
export function bucketCount(): number {
  return buckets.size;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetIn: number; // ms until reset
}

export function rateLimit(
  key: string,
  maxPerWindow: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  if (buckets.size >= PRUNE_AT) prune(now);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: maxPerWindow - 1, resetIn: windowMs };
  }
  if (b.count >= maxPerWindow) {
    return { ok: false, remaining: 0, resetIn: b.resetAt - now };
  }
  b.count += 1;
  return { ok: true, remaining: maxPerWindow - b.count, resetIn: b.resetAt - now };
}

/**
 * Best guess at who is calling, for rate-limiting purposes only.
 *
 * Order matters. When a CDN sits in front of the origin, fly-client-ip is the
 * CDN edge rather than the visitor — the same value for everyone arriving
 * through that edge — so trusting it first collapses every listener into one
 * bucket and turns a per-person allowance into a shared one. cf-connecting-ip
 * carries the real client, so it wins where present.
 *
 * None of these headers is trustworthy against a determined caller who can
 * reach the origin directly and forge them; this is abuse-bounding, not
 * authentication, and nothing security-sensitive should key off it.
 */
export function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("fly-client-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}
