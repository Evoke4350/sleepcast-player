// The Cloudflare Worker: static assets (the Astro build, in dist/) are served
// by Workers Static Assets before this runs; only /api/* reaches it
// (run_worker_first in wrangler.jsonc).

import { relay } from "./relay";

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
    if (pathname === "/api/relay" && request.method === "GET") {
      // Keyed by address only: no URL, no identity, nothing kept past the window.
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      return relay(request, {
        fetch: (input, init) => fetch(input, init),
        cache: caches.default,
        allow: async () => (env.RELAY_LIMIT ? (await env.RELAY_LIMIT.limit({ key: ip })).success : true),
        later: (p) => ctx.waitUntil(p),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
