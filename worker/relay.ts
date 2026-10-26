// /api/relay on Cloudflare Workers: fetches a podcast feed for the browser,
// which can't read most feeds itself (no CORS headers on feed hosts).
//
// What stops this being an open proxy:
//
//  - every hop, redirects included, must be an https URL to a named public
//    host (isAllowedFeedUrl: no IP literals, no localhost or .internal);
//  - Workers can't reach private networks at all, so a public name that
//    resolves to a private address goes nowhere (the Node relay this replaces
//    had to pin DNS answers to close that hole itself);
//  - the body must open like a feed, and is capped at 32 MB;
//  - a per-address rate limit (the RELAY_LIMIT binding in wrangler.jsonc).
//
// Feeds are cached at the edge for 30 minutes, and kept a week past that as
// a fallback for when the feed's host is down. No URLs are logged.

import { isAllowedFeedUrl, looksLikeFeed, readCapped } from "../src/lib/relay-guard";

// Raised from 10MB after Send Me To Sleep (1,702 episodes, 22.9MB of XML)
// was rejected with a 413 the moment it shipped as a builtin.
export const MAX_BYTES = 32 * 1024 * 1024;
const UA = { "User-Agent": "sleepcast/2.0" };
const MAX_HOPS = 6;
export const FRESH_MS = 30 * 60 * 1000;
/** How long a copy stays in the edge cache, as the fallback. */
const KEEP_S = 7 * 24 * 60 * 60;
const FETCHED_AT = "X-Relay-Fetched-At";

export interface RelayDeps {
  fetch: typeof fetch;
  /** The edge cache; absent where there is none (tests, workers.dev). */
  cache?: Pick<Cache, "match" | "put">;
  /** True when this caller is within the rate limit. */
  allow: () => Promise<boolean>;
  /** Work to finish after the response is sent (ctx.waitUntil). */
  later: (p: Promise<unknown>) => void;
  now?: () => number;
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

export async function relay(request: Request, deps: RelayDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  if (!(await deps.allow())) {
    return new Response("slow down", { status: 429, headers: { "Retry-After": "60" } });
  }

  const self = new URL(request.url);
  const target = self.searchParams.get("url") ?? "";
  // Never itself: a relay URL relaying a relay URL is a loop.
  const toSelf = (u: string) => new URL(u).hostname === self.hostname;
  if (!isAllowedFeedUrl(target) || toSelf(target)) return new Response("bad url", { status: 400 });

  // The cache key is on this site's own origin, as the Cache API wants.
  const key = new Request(new URL(`/api/relay-cache?u=${encodeURIComponent(target)}`, request.url));
  const cached = await deps.cache?.match(key).catch(() => undefined);
  const cachedAt = Number(cached?.headers.get(FETCHED_AT) ?? 0);
  if (cached && now() - cachedAt < FRESH_MS) return respond(await cached.arrayBuffer(), "hit");

  // Any upstream failure falls back to the older copy when there is one: a
  // flaky feed host shouldn't take the night down.
  const fail = async (msg: string, status: number) =>
    cached ? respond(await cached.arrayBuffer(), "stale") : new Response(msg, { status });

  let current = target;
  let upstream: Response | null = null;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (hop > 0 && (!isAllowedFeedUrl(current) || toSelf(current))) return fail("redirect blocked", 502);
    let resp: Response;
    try {
      resp = await deps.fetch(current, { redirect: "manual", headers: UA, signal: AbortSignal.timeout(30000) });
    } catch {
      return fail("upstream failed", 502);
    }
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
  if (Number(upstream.headers.get("content-length") || 0) > MAX_BYTES) return fail("too large", 413);

  // Capped while reading: content-length is optional, and can lie.
  let body: ArrayBuffer | null;
  try {
    body = await readCapped(upstream, MAX_BYTES);
  } catch {
    return fail("upstream body failed", 502);
  }
  if (body === null) return fail("too large", 413);
  // Not a feed: not ours to carry, and it never enters the cache.
  if (!looksLikeFeed(body)) return fail("not a feed", 415);

  if (deps.cache) {
    const copy = new Response(body.slice(0), {
      headers: { "Cache-Control": `public, max-age=${KEEP_S}`, [FETCHED_AT]: String(now()) },
    });
    deps.later(deps.cache.put(key, copy).catch(() => {}));
  }
  return respond(body, "miss");
}
