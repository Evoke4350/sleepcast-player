// The Cloudflare Worker: static assets (the Astro build, in dist/) are served
// by Workers Static Assets before this runs; only /api/* reaches it
// (run_worker_first in wrangler.jsonc): the feed relay, and the podcast
// search with its artwork (search.ts). One rate limit covers all three.

import { relay } from "./relay";
import { art, search } from "./search";

// The few Workers types used here, declared rather than pulling in
// @cloudflare/workers-types, whose globals clash with the DOM's in the
// project's one tsconfig.
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}
declare const caches: CacheStorage & { default: Cache };

interface Env {
  ASSETS: { fetch: (r: Request) => Promise<Response> };
  /** Workers rate limiting: per address, for the relay. */
  RELAY_LIMIT?: { limit: (o: { key: string }) => Promise<{ success: boolean }> };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    // Keyed by address only: no URL, no identity, nothing kept past the window.
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const deps = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
      cache: caches.default,
      allow: async () => (env.RELAY_LIMIT ? (await env.RELAY_LIMIT.limit({ key: ip })).success : true),
      later: (p: Promise<unknown>) => ctx.waitUntil(p),
    };
    if (request.method === "GET") {
      if (pathname === "/api/relay") return relay(request, deps);
      if (pathname === "/api/search") return search(request, deps);
      if (pathname === "/api/art") return art(request, deps);
    }
    return new Response("not found", { status: 404 });
  },
};
