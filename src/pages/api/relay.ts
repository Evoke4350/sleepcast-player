import type { APIRoute } from "astro";
import { isAllowedFeedUrl, looksLikeFeed, resolvePublicIps, isPrivateIp, type PinnedAddress } from "../../lib/relay-guard";
import { rateLimit, clientIp } from "../../lib/ratelimit";

// Raised from 10MB after Send Me To Sleep (1,702 episodes, 22.9MB of XML)
// was rejected with a 413 the moment it shipped as a builtin. Long-running
// daily shows produce genuinely enormous feeds, and 10MB turned out to be
// inside the normal range rather than above it.
//
// The cost is real but bounded: the relay caches for 30 minutes so a feed this
// size is fetched twice an hour rather than per listener, responses go out
// compressed (3.5MB of XML leaves as ~290KB), and CACHE_MAX_BYTES still evicts
// LRU. Worth watching if several feeds this large end up cached at once on a
// 512MB machine.
const MAX_BYTES = 32 * 1024 * 1024;
const UA = { "User-Agent": "sleepcast/2.0" };
const MAX_HOPS = 6;

// A listener opening the app refetches every subscribed feed at once, so the
// ceiling has to clear a full library in one burst — but nothing beyond that.
// Cache hits count too: they still cost egress, which is the abuse being
// bounded here.
const RATE_MAX = 60;
const RATE_WINDOW_MS = 5 * 60 * 1000;

// In-memory feed cache: fresh entries skip the upstream entirely, stale ones
// serve as a fallback when the upstream flakes (stale-if-error, any age).
// Memory only — feeds are shared, public, and re-fetchable; a machine restart
// just means the first visitor warms it again. No URLs are logged.
const FRESH_MS = 30 * 60 * 1000;
const CACHE_MAX_BYTES = 96 * 1024 * 1024; // well inside the 512MB machine
type CacheEntry = { body: ArrayBuffer; at: number };
const feedCache = new Map<string, CacheEntry>(); // Map preserves insert order → LRU
const inFlight = new Map<string, Promise<Response>>(); // dedup concurrent fetches

function cacheGet(key: string): CacheEntry | undefined {
  const hit = feedCache.get(key);
  if (hit) {
    feedCache.delete(key); // re-insert to mark most-recently-used
    feedCache.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, body: ArrayBuffer) {
  feedCache.delete(key);
  feedCache.set(key, { body, at: Date.now() });
  let total = 0;
  for (const e of feedCache.values()) total += e.body.byteLength;
  for (const k of feedCache.keys()) {
    if (total <= CACHE_MAX_BYTES) break;
    const evicted = feedCache.get(k)!;
    feedCache.delete(k);
    total -= evicted.body.byteLength;
  }
}

function respond(body: ArrayBuffer, cache: "hit" | "stale" | "miss"): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      // Let the browser reuse its copy briefly too; localStorage is the
      // client's real offline cache.
      "Cache-Control": "public, max-age=300",
      "X-Relay-Cache": cache,
    },
  });
}

export const GET: APIRoute = async ({ url, request }) => {
  const target = url.searchParams.get("url") ?? "";

  // Per-IP ceiling before any work: the relay fetches on behalf of anyone who
  // asks, so an unbounded caller is unbounded egress. Keyed by IP only — no
  // URL, no identity, nothing retained past the window.
  const limit = rateLimit(clientIp(request), RATE_MAX, RATE_WINDOW_MS);
  if (!limit.ok) {
    return new Response("slow down", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(limit.resetIn / 1000)) },
    });
  }

  // Validate initial URL synchronously (no URL logged per privacy policy)
  if (!isAllowedFeedUrl(target)) return new Response("bad url", { status: 400 });

  const cached = cacheGet(target);
  if (cached && Date.now() - cached.at < FRESH_MS) {
    return respond(cached.body, "hit");
  }

  // One upstream fetch per feed at a time, no matter how many tabs ask.
  const running = inFlight.get(target);
  if (running) return (await running).clone();
  const work = fetchUpstream(target, cached);
  inFlight.set(target, work);
  try {
    return (await work).clone();
  } finally {
    inFlight.delete(target);
  }
};

/**
 * Fetch a URL over a connection pinned to pre-validated public addresses.
 *
 * undici's `connect.lookup` replaces the DNS step of the actual connection, so
 * the socket goes to an address we already proved public — closing the
 * check-then-fetch (DNS rebinding) window. TLS is unaffected: undici still
 * sends the hostname as SNI and validates the certificate against it, which is
 * why we pin the address here instead of rewriting the URL to an IP.
 */
async function pinnedFetch(url: string, pinned: PinnedAddress[]): Promise<Response> {
  const { Agent, fetch: undiciFetch } = await import("undici");
  const dispatcher = new Agent({
    connect: {
      lookup(_hostname, _options, callback) {
        // Defence in depth: re-check before handing the address to the socket.
        const safe = pinned.filter((p) => !isPrivateIp(p.address));
        if (safe.length === 0) {
          callback(new Error("no public address"), []);
          return;
        }
        callback(null, safe.map((p) => ({ address: p.address, family: p.family })));
      },
    },
  });
  try {
    return (await undiciFetch(url, {
      redirect: "manual",
      headers: UA,
      signal: AbortSignal.timeout(30000),
      dispatcher,
    })) as unknown as Response;
  } finally {
    // Don't leak sockets: each hop gets its own agent.
    void dispatcher.close().catch(() => {});
  }
}

async function fetchUpstream(target: string, stale: CacheEntry | undefined): Promise<Response> {
  // Any upstream failure falls back to the stale copy when one exists —
  // a flaky feed host shouldn't take the night down.
  const fail = (msg: string, status: number) =>
    stale ? respond(stale.body, "stale") : new Response(msg, { status });

  let current = target;
  let upstream: Response | null = null;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const isFirstHop = hop === 0;

    // Every hop must pass the allowlist check (security checks never fall
    // back to stale on the first hop's bad input — that's a caller error)
    if (!isAllowedFeedUrl(current)) {
      if (isFirstHop) return new Response("bad url", { status: 400 });
      return fail("redirect blocked", 502);
    }

    // Every hop's hostname must resolve only to public IPs
    let hostname: string;
    try {
      hostname = new URL(current).hostname;
    } catch {
      if (isFirstHop) return new Response("bad url", { status: 400 });
      return fail("redirect blocked", 502);
    }

    // Resolve once and keep the addresses: the connection below is pinned to
    // exactly these, so a 0-TTL rebind can't swap in a private address between
    // this check and the fetch.
    const pinned = await resolvePublicIps(hostname);
    if (pinned.length === 0) {
      if (isFirstHop) return new Response("bad url", { status: 400 });
      return fail("redirect blocked", 502);
    }

    let resp: Response;
    try {
      resp = await pinnedFetch(current, pinned);
    } catch {
      return fail("upstream failed", 502);
    }

    // Follow redirect
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return fail("redirect with no location", 502);
      try {
        current = new URL(loc, current).toString();
      } catch {
        return fail("bad redirect location", 502);
      }
      continue;
    }

    upstream = resp;
    break;
  }

  if (!upstream) return fail("too many redirects", 502);
  if (!upstream.ok) return fail("upstream " + upstream.status, 502);

  const len = Number(upstream.headers.get("content-length") || 0);
  if (len > MAX_BYTES) return fail("too large", 413);

  let body: ArrayBuffer;
  try {
    body = await upstream.arrayBuffer();
  } catch {
    return fail("upstream body failed", 502);
  }
  if (body.byteLength > MAX_BYTES) return fail("too large", 413);
  // Not a feed → not our job to carry it, and it never enters the cache.
  if (!looksLikeFeed(body)) return fail("not a feed", 415);

  cachePut(target, body);
  return respond(body, "miss");
}
