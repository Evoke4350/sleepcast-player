// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { art, isAppleArtUrl, normalizeQuery, search, trimResults, type SearchDeps } from "./search";

const APPLE = {
  resultCount: 3,
  results: [
    { collectionName: "Sleep With Me", artistName: "Drew", feedUrl: "https://feeds.example/swm", artworkUrl100: "https://is1-ssl.mzstatic.com/a/100x100bb.jpg", trackCount: 1200 },
    { collectionName: "No Feed Show", artistName: "x" },
    { collectionName: "Plain Http", artistName: "y", feedUrl: "http://feeds.example/plain" },
    { trackName: "Named by track", feedUrl: "https://feeds.example/t", artworkUrl100: "https://evil.example/a.jpg", trackCount: 0 },
  ],
};

function memCache() {
  const m = new Map<string, Response>();
  return {
    m,
    match: async (k: RequestInfo | URL) => m.get(new Request(k).url)?.clone(),
    put: async (k: RequestInfo | URL, r: Response) => { m.set(new Request(k).url, new Response(await r.arrayBuffer(), r)); },
  };
}
function deps(over: Partial<SearchDeps> = {}) {
  const later: Promise<unknown>[] = [];
  return {
    fetch: vi.fn(async () => new Response(JSON.stringify(APPLE), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    allow: async () => true,
    later: (p: Promise<unknown>) => { later.push(p); },
    settle: () => Promise.all(later),
    ...over,
  };
}
const ask = (q: string) => new Request(`https://sleepcast.pro/api/search?q=${encodeURIComponent(q)}`);

describe("search", () => {
  it("normalizes the words and refuses too few", async () => {
    expect(normalizeQuery("  sleep   with  me ")).toBe("sleep with me");
    expect(normalizeQuery("x".repeat(200))).toHaveLength(100);
    expect((await search(ask("a"), deps())).status).toBe(400);
    expect((await search(ask(" "), deps())).status).toBe(400);
  });

  it("asks Apple for podcasts with only the words, and trims what comes back", async () => {
    const d = deps();
    const res = await search(ask("sleep with me"), d);
    expect(res.status).toBe(200);
    const sent = new URL((d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(sent.origin + sent.pathname).toBe("https://itunes.apple.com/search");
    expect(sent.searchParams.get("term")).toBe("sleep with me");
    expect(sent.searchParams.get("media")).toBe("podcast");
    expect([...sent.searchParams.keys()].sort()).toEqual(["entity", "limit", "media", "term"]);
    const hits = await res.json();
    expect(hits).toEqual([
      { title: "Sleep With Me", author: "Drew", feedUrl: "https://feeds.example/swm", art: "/api/art?u=" + encodeURIComponent("https://is1-ssl.mzstatic.com/a/100x100bb.jpg"), episodes: 1200 },
      { title: "Named by track", author: "", feedUrl: "https://feeds.example/t" },
    ]);
  });

  it("caches a search by its words, whatever the case", async () => {
    const cache = memCache();
    const d = deps({ cache });
    await search(ask("Sleep With Me"), d);
    await d.settle();
    const again = await search(ask("sleep  with me"), d);
    expect(again.status).toBe(200);
    expect((d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("rate limit and a failing directory", async () => {
    expect((await search(ask("rain"), deps({ allow: async () => false }))).status).toBe(429);
    expect((await search(ask("rain"), deps({ fetch: vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch }))).status).toBe(502);
    expect((await search(ask("rain"), deps({ fetch: vi.fn(async () => { throw new Error("net"); }) as unknown as typeof fetch }))).status).toBe(502);
  });

  it("retries when Apple says 429, and says busy when it keeps saying so", async () => {
    const ok = () => new Response(JSON.stringify(APPLE), { headers: { "content-type": "application/json" } });
    const busy = () => new Response("", { status: 429 });
    const waits: number[] = [];
    const once = deps({ fetch: vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok()) as unknown as typeof fetch, wait: async (ms) => { waits.push(ms); } });
    expect((await search(ask("rain"), once)).status).toBe(200);
    expect(waits).toEqual([300]);
    const always = deps({ fetch: vi.fn(async () => busy()) as unknown as typeof fetch, wait: async () => {} });
    const res = await search(ask("rain"), always);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect((always.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it("trimResults survives junk", () => {
    expect(trimResults(null)).toEqual([]);
    expect(trimResults({ results: "no" })).toEqual([]);
  });
});

describe("art", () => {
  const askArt = (u: string) => new Request(`https://sleepcast.pro/api/art?u=${encodeURIComponent(u)}`);
  const png = () => new Response(new Uint8Array(100), { headers: { "content-type": "image/jpeg", "content-length": "100" } });

  it("fetches only Apple's image hosts", async () => {
    expect(isAppleArtUrl("https://is1-ssl.mzstatic.com/x.jpg")).toBe(true);
    expect(isAppleArtUrl("https://mzstatic.com/x.jpg")).toBe(true);
    expect(isAppleArtUrl("https://notmzstatic.com/x.jpg")).toBe(false);
    expect(isAppleArtUrl("http://is1-ssl.mzstatic.com/x.jpg")).toBe(false);
    expect((await art(askArt("https://evil.example/a.jpg"), deps())).status).toBe(400);
  });

  it("passes an image through, cached, and refuses anything else", async () => {
    const cache = memCache();
    const d = deps({ cache, fetch: vi.fn(async () => png()) as unknown as typeof fetch });
    const res = await art(askArt("https://is1-ssl.mzstatic.com/x.jpg"), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    await d.settle();
    await art(askArt("https://is1-ssl.mzstatic.com/x.jpg"), d);
    expect((d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const html = deps({ fetch: vi.fn(async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch });
    expect((await art(askArt("https://is1-ssl.mzstatic.com/x.jpg"), html)).status).toBe(502);
  });
});
