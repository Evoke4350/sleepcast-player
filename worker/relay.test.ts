// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { relay, FRESH_MS, MAX_BYTES, type RelayDeps } from "./relay";

const FEED = '<?xml version="1.0"?><rss><channel><title>t</title></channel></rss>';
const ask = (url: string) => new Request(`https://sleepcast.pro/api/relay?url=${encodeURIComponent(url)}`);

/** The Cache API, in memory. */
function memCache() {
  const m = new Map<string, Response>();
  return {
    m,
    match: async (k: RequestInfo | URL) => m.get(new Request(k).url)?.clone(),
    put: async (k: RequestInfo | URL, r: Response) => { m.set(new Request(k).url, new Response(await r.arrayBuffer(), r)); },
  };
}

function deps(over: Partial<RelayDeps> = {}) {
  const later: Promise<unknown>[] = [];
  const d: RelayDeps & { settle: () => Promise<unknown> } = {
    fetch: vi.fn(async () => new Response(FEED)) as unknown as typeof fetch,
    allow: async () => true,
    later: (p) => { later.push(p); },
    settle: () => Promise.all(later),
    ...over,
  };
  return d;
}

describe("relay", () => {
  it("carries a feed", async () => {
    const r = await relay(ask("https://feeds.example/x.xml"), deps());
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(FEED);
    expect(r.headers.get("X-Relay-Cache")).toBe("miss");
  });

  it("refuses what isn't a public https URL, before fetching", async () => {
    const d = deps();
    for (const u of ["https://sleepcast.pro/api/relay?url=x", "http://feeds.example/x", "https://localhost/x", "https://10.0.0.1/x", "https://[::1]/x", "nope"]) {
      expect((await relay(ask(u), d)).status).toBe(400);
    }
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("over the rate limit, does nothing", async () => {
    const d = deps({ allow: async () => false });
    expect((await relay(ask("https://feeds.example/x.xml"), d)).status).toBe(429);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("follows redirects, each checked", async () => {
    const fetch = vi.fn(async (u: string) =>
      u.endsWith("/old") ? new Response(null, { status: 301, headers: { location: "/new" } }) : new Response(FEED));
    const r = await relay(ask("https://feeds.example/old"), deps({ fetch: fetch as unknown as typeof globalThis.fetch }));
    expect(r.status).toBe(200);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["https://feeds.example/old", "https://feeds.example/new"]);

    const toLocal = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/admin" } }));
    expect((await relay(ask("https://feeds.example/x"), deps({ fetch: toLocal as unknown as typeof globalThis.fetch }))).status).toBe(502);
    expect(toLocal).toHaveBeenCalledTimes(1);
  });

  it("carries only feeds, and only up to the cap", async () => {
    const html = vi.fn(async () => new Response("<html>hi</html>"));
    expect((await relay(ask("https://x.example/a"), deps({ fetch: html as unknown as typeof fetch }))).status).toBe(415);
    const big = vi.fn(async () => new Response(FEED, { headers: { "content-length": String(MAX_BYTES + 1) } }));
    expect((await relay(ask("https://x.example/b"), deps({ fetch: big as unknown as typeof fetch }))).status).toBe(413);
    const lying = vi.fn(async () => new Response(new Uint8Array(MAX_BYTES + 1)));
    expect((await relay(ask("https://x.example/c"), deps({ fetch: lying as unknown as typeof fetch }))).status).toBe(413);
  });

  it("serves from the edge cache for 30 minutes, then the old copy if the host is down", async () => {
    const cache = memCache();
    let t = 1_000_000;
    const d = deps({ cache, now: () => t });
    await relay(ask("https://feeds.example/x.xml"), d);
    await d.settle();
    expect(cache.m.size).toBe(1);

    t += FRESH_MS - 1;
    const hit = await relay(ask("https://feeds.example/x.xml"), d);
    expect(hit.headers.get("X-Relay-Cache")).toBe("hit");
    expect(await hit.text()).toBe(FEED);
    expect(d.fetch).toHaveBeenCalledTimes(1);

    t += 2;
    const down = deps({ cache, now: () => t, fetch: vi.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch });
    const stale = await relay(ask("https://feeds.example/x.xml"), down);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("X-Relay-Cache")).toBe("stale");
    expect(await stale.text()).toBe(FEED);
  });

  it("never caches what it refused", async () => {
    const cache = memCache();
    const d = deps({ cache, fetch: vi.fn(async () => new Response("<html>")) as unknown as typeof fetch });
    await relay(ask("https://x.example/a"), d);
    await d.settle();
    expect(cache.m.size).toBe(0);
  });
});
