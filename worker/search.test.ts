// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { art, isAppleArtUrl, normalizeQuery, podcastIndexHeaders, search, signArt, trimIndexResults, trimResults, verifyArt, type SearchDeps } from "./search";

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

  describe("Podcast Index fallback", () => {
    const INDEX = { feeds: [
      { title: "Sleep With Me", author: "Drew", url: "https://feeds.example/swm", image: "https://cdn.example/a.jpg", episodeCount: 1200 },
      { title: "Plain Http", url: "http://feeds.example/plain" },
      { url: "https://feeds.example/untitled" },
      { title: "No count", author: "", url: "https://feeds.example/nc", episodeCount: 0 },
    ] };
    const busy = () => new Response("", { status: 429 });
    const indexOk = () => new Response(JSON.stringify(INDEX), { headers: { "content-type": "application/json" } });
    const creds = { key: "k", secret: "s" };

    it("signs the request the way Podcast Index wants", async () => {
      const h = await podcastIndexHeaders(creds, 1_700_000_000_500);
      expect(h["X-Auth-Key"]).toBe("k");
      expect(h["X-Auth-Date"]).toBe("1700000000");
      const want = [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode("ks1700000000")))].map((b) => b.toString(16).padStart(2, "0")).join("");
      expect(h.Authorization).toBe(want);
      expect(h["User-Agent"]).toBe("sleepcast/2.0");
    });

    it("asks Podcast Index first, sending only the words", async () => {
      const fetch = vi.fn().mockResolvedValueOnce(indexOk());
      const d = deps({ fetch: fetch as unknown as typeof fetch, podcastIndex: creds, now: () => 1_700_000_000_000 });
      const res = await search(ask("sleep with me"), d);
      expect(res.status).toBe(200);
      expect(fetch.mock.calls).toHaveLength(1);
      const sent = new URL(fetch.mock.calls[0][0] as string);
      expect(sent.origin + sent.pathname).toBe("https://api.podcastindex.org/api/1.0/search/byterm");
      expect(sent.searchParams.get("q")).toBe("sleep with me");
      expect([...sent.searchParams.keys()].sort()).toEqual(["max", "q"]);
      const headers = (fetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers["X-Auth-Key"]).toBe("k");
      expect(headers.Authorization).toMatch(/^[0-9a-f]{40}$/);
      expect(await res.json()).toEqual([
        { title: "Sleep With Me", author: "Drew", feedUrl: "https://feeds.example/swm", episodes: 1200 },
        { title: "No count", author: "", feedUrl: "https://feeds.example/nc" },
      ]);
    });

    it("falls back to Apple when Podcast Index is down, or finds nothing", async () => {
      const appleOk = () => new Response(JSON.stringify(APPLE), { headers: { "content-type": "application/json" } });
      const down = vi.fn().mockResolvedValueOnce(new Response("", { status: 500 })).mockResolvedValueOnce(appleOk());
      const res = await search(ask("rain"), deps({ fetch: down as unknown as typeof fetch, podcastIndex: creds }));
      expect(res.status).toBe(200);
      expect(down.mock.calls).toHaveLength(2);
      expect(new URL(down.mock.calls[1][0] as string).hostname).toBe("itunes.apple.com");
      expect(((await res.json()) as { title: string }[])[0].title).toBe("Sleep With Me");
      const empty = () => new Response(JSON.stringify({ feeds: [] }), { headers: { "content-type": "application/json" } });
      const nothing = vi.fn().mockResolvedValueOnce(empty()).mockResolvedValueOnce(appleOk());
      expect(((await (await search(ask("rain"), deps({ fetch: nothing as unknown as typeof fetch, podcastIndex: creds }))).json()) as unknown[])).toHaveLength(2);
      // Index found nothing and Apple is busy: an empty list, not an error.
      const emptyBusy = vi.fn().mockResolvedValueOnce(empty()).mockResolvedValue(busy());
      const res3 = await search(ask("rain"), deps({ fetch: emptyBusy as unknown as typeof fetch, wait: async () => {}, podcastIndex: creds }));
      expect(res3.status).toBe(200);
      expect(await res3.json()).toEqual([]);
    });

    it("without a key Apple alone answers; both down is an error", async () => {
      const noKey = deps({ fetch: vi.fn(async () => busy()) as unknown as typeof fetch, wait: async () => {} });
      expect((await search(ask("rain"), noKey)).status).toBe(503);
      expect((noKey.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
      const bothDown = deps({ fetch: vi.fn().mockResolvedValueOnce(new Response("", { status: 500 })).mockResolvedValue(busy()) as unknown as typeof fetch, wait: async () => {}, podcastIndex: creds });
      expect((await search(ask("rain"), bothDown)).status).toBe(503);
      expect((bothDown.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
      const netDown = deps({ fetch: vi.fn(async () => { throw new Error("net"); }) as unknown as typeof fetch, podcastIndex: creds });
      expect((await search(ask("rain"), netDown)).status).toBe(502);
    });

    it("caches an Index answer like Apple's", async () => {
      const cache = memCache();
      const fetch = vi.fn().mockResolvedValueOnce(indexOk());
      const d = deps({ cache, fetch: fetch as unknown as typeof fetch, podcastIndex: creds });
      await search(ask("rain"), d);
      await d.settle();
      expect((await search(ask("Rain"), d)).status).toBe(200);
      expect(fetch.mock.calls).toHaveLength(1);
    });

    it("with an art key, Index artwork comes as a signed /api/art link", async () => {
      const hits = await trimIndexResults({ feeds: [
        ...INDEX.feeds,
        { title: "Plain image", url: "https://feeds.example/pi", image: "http://cdn.example/plain.jpg" },
        { title: "Artwork field", url: "https://feeds.example/af", artwork: "https://cdn.example/b.png" },
      ] }, "art-secret");
      const a = new URL(hits[0].art!, "https://sleepcast.pro");
      expect(a.pathname).toBe("/api/art");
      expect(a.searchParams.get("u")).toBe("https://cdn.example/a.jpg");
      expect(a.searchParams.get("s")).toMatch(/^[0-9a-f]{32}$/);
      expect(await verifyArt("https://cdn.example/a.jpg", a.searchParams.get("s")!, "art-secret")).toBe(true);
      expect(hits.find((h) => h.title === "Plain image")!.art).toBeUndefined();
      expect(hits.find((h) => h.title === "Artwork field")!.art).toContain(encodeURIComponent("https://cdn.example/b.png"));
      const fetch = vi.fn().mockResolvedValueOnce(indexOk());
      const res = await search(ask("rain"), deps({ fetch: fetch as unknown as typeof fetch, podcastIndex: creds, artKey: "art-secret" }));
      expect(((await res.json()) as { art?: string }[])[0].art).toBe(await signArt("https://cdn.example/a.jpg", "art-secret"));
    });

    it("signatures are per url and per key", async () => {
      const s = new URL(await signArt("https://cdn.example/a.jpg", "k1"), "https://x").searchParams.get("s")!;
      expect(await verifyArt("https://cdn.example/a.jpg", s, "k1")).toBe(true);
      expect(await verifyArt("https://cdn.example/b.jpg", s, "k1")).toBe(false);
      expect(await verifyArt("https://cdn.example/a.jpg", s, "k2")).toBe(false);
      expect(await verifyArt("https://cdn.example/a.jpg", s.slice(0, 31), "k1")).toBe(false);
      expect(await verifyArt("https://cdn.example/a.jpg", "", "k1")).toBe(false);
    });

    it("also steps in when Apple fails outright", async () => {
      const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 500 })).mockResolvedValueOnce(indexOk());
      const res = await search(ask("rain"), deps({ fetch: fetch as unknown as typeof fetch, podcastIndex: creds }));
      expect(res.status).toBe(200);
      expect(fetch.mock.calls).toHaveLength(2);
    });

    it("without a key, or when it fails too, Apple's answer stands", async () => {
      const noKey = deps({ fetch: vi.fn(async () => busy()) as unknown as typeof fetch, wait: async () => {} });
      expect((await search(ask("rain"), noKey)).status).toBe(503);
      expect((noKey.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
      const bothDown = deps({ fetch: vi.fn(async () => busy()) as unknown as typeof fetch, wait: async () => {}, podcastIndex: creds });
      expect((await search(ask("rain"), bothDown)).status).toBe(503);
      expect((bothDown.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
      const appleDown = deps({ fetch: vi.fn(async () => { throw new Error("net"); }) as unknown as typeof fetch, podcastIndex: creds });
      expect((await search(ask("rain"), appleDown)).status).toBe(502);
    });

    it("caches an Index answer like Apple's", async () => {
      const cache = memCache();
      const fetch = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy()).mockResolvedValueOnce(indexOk());
      const d = deps({ cache, fetch: fetch as unknown as typeof fetch, wait: async () => {}, podcastIndex: creds });
      await search(ask("rain"), d);
      await d.settle();
      expect((await search(ask("Rain"), d)).status).toBe(200);
      expect(fetch.mock.calls).toHaveLength(4);
    });

    it("trimIndexResults survives junk", async () => {
      expect(await trimIndexResults(null)).toEqual([]);
      expect(await trimIndexResults({ feeds: "no" })).toEqual([]);
    });
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

  it("fetches another host only with this worker's signature", async () => {
    const d = deps({ fetch: vi.fn(async () => png()) as unknown as typeof fetch, artKey: "art-secret" });
    const signed = await signArt("https://cdn.example/a.jpg", "art-secret");
    expect((await art(new Request("https://sleepcast.pro" + signed), d)).status).toBe(200);
    expect((await art(askArt("https://cdn.example/a.jpg"), d)).status).toBe(400);
    expect((await art(new Request("https://sleepcast.pro" + signed.replace(/s=./, "s=0")), d)).status).toBe(400);
    expect((await art(new Request("https://sleepcast.pro" + signed.replace("u=https", "u=http")), d)).status).toBe(400);
    const noKey = deps({ fetch: vi.fn(async () => png()) as unknown as typeof fetch });
    expect((await art(new Request("https://sleepcast.pro" + signed), noKey)).status).toBe(400);
    const other = await signArt("https://cdn.example/a.jpg", "other-key");
    expect((await art(new Request("https://sleepcast.pro" + other), d)).status).toBe(400);
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
