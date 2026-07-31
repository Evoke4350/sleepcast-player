/**
 * Tiny in-memory IP-based rate limiter. Per-process — fine for single-region
 * fly setup. For multi-region or scale, swap for Upstash/Redis.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

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

export function clientIp(req: Request): string {
  return (
    req.headers.get("fly-client-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}
