import { describe, expect, test, vi } from "vitest";
import { clientIp, rateLimit, bucketCount, PRUNE_AT } from "./ratelimit";

const req = (headers: Record<string, string>) =>
  new Request("https://sleepcast.pro/api/relay", { headers });

describe("clientIp", () => {
  test("uses fly-client-ip when we are the only proxy", () => {
    expect(clientIp(req({ "fly-client-ip": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  test("prefers cf-connecting-ip over fly-client-ip", () => {
    // Behind Cloudflare, fly-client-ip is Cloudflare's edge address, the same
    // for every visitor through that edge. Trusting it collapses every
    // listener into one rate-limit bucket, so /api/relay's 60-per-5-minutes
    // becomes a shared allowance instead of a per-person one.
    const ip = clientIp(
      req({
        "cf-connecting-ip": "198.51.100.23",
        "fly-client-ip": "172.71.0.1",
        "x-forwarded-for": "198.51.100.23, 172.71.0.1",
      }),
    );
    expect(ip).toBe("198.51.100.23");
  });

  test("falls back to the first x-forwarded-for hop", () => {
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" }))).toBe("198.51.100.9");
  });

  test("falls back to x-real-ip", () => {
    expect(clientIp(req({ "x-real-ip": "198.51.100.44" }))).toBe("198.51.100.44");
  });

  test("reports unknown when no header identifies the caller", () => {
    expect(clientIp(req({}))).toBe("unknown");
  });

  test("separates two visitors sharing one Cloudflare edge", () => {
    // The regression this fix exists for, stated as behaviour rather than
    // header precedence: two people behind the same edge must not consume
    // each other's allowance.
    const edge = "172.71.0.1";
    const a = clientIp(req({ "cf-connecting-ip": "198.51.100.1", "fly-client-ip": edge }));
    const b = clientIp(req({ "cf-connecting-ip": "198.51.100.2", "fly-client-ip": edge }));
    expect(a).not.toBe(b);
  });
});

describe("rateLimit", () => {
  test("allows up to the limit then refuses", () => {
    const key = `test:${Math.random()}`;
    expect(rateLimit(key, 2, 60_000).ok).toBe(true);
    expect(rateLimit(key, 2, 60_000).ok).toBe(true);
    const third = rateLimit(key, 2, 60_000);
    expect(third.ok).toBe(false);
    expect(third.remaining).toBe(0);
  });

  test("counts each key separately", () => {
    const a = `test:${Math.random()}`;
    const b = `test:${Math.random()}`;
    rateLimit(a, 1, 60_000);
    expect(rateLimit(a, 1, 60_000).ok).toBe(false);
    expect(rateLimit(b, 1, 60_000).ok).toBe(true);
  });
});

describe("rateLimit memory", () => {
  // One bucket per visitor address, never removed: the map only ever grew for
  // the life of the process.
  test("drops expired buckets once the table is large", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < PRUNE_AT + 10; i++) rateLimit(`old-${i}`, 5, 1000);
      vi.advanceTimersByTime(2000);
      rateLimit("new", 5, 1000);
      expect(bucketCount()).toBeLessThan(10);
    } finally { vi.useRealTimers(); }
  });

  test("keeps live buckets when pruning", () => {
    vi.useFakeTimers();
    try {
      rateLimit("busy", 1, 60_000);
      for (let i = 0; i < PRUNE_AT + 10; i++) rateLimit(`old-${i}`, 5, 1000);
      vi.advanceTimersByTime(2000);
      rateLimit("new", 5, 1000);
      expect(rateLimit("busy", 1, 60_000).ok).toBe(false); // still limited
    } finally { vi.useRealTimers(); }
  });
});
