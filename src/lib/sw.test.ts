// @vitest-environment node
// public/sw.js, run as the browser runs it: a classic script handed `self`.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { offlineUrl, AUDIO_CACHE, AUDIO_PATH } from "./offline-audio";

const ORIGIN = "https://sleepcast.pro";
const file = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
const stores = new Map<string, Map<string, Response>>();
let onFetch: (e: { request: Request; respondWith: (r: Promise<Response>) => void }) => void;

beforeAll(() => {
  const listeners: Record<string, (e: never) => void> = {};
  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type: string, fn: (e: never) => void) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  const caches = {
    open: async (name: string) => {
      const m = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, m);
      return { match: async (k: string) => m.get(new URL(k, ORIGIN).href)?.clone() };
    },
    match: async () => undefined,
    keys: async () => [...stores.keys()],
  };
  new Function("self", "caches", readFileSync("public/sw.js", "utf8"))(self, caches);
  onFetch = listeners.fetch as typeof onFetch;
  stores.set(AUDIO_CACHE, new Map([[new URL(offlineUrl("https://cdn.example/a.mp3"), ORIGIN).href, new Response(file, { headers: { "content-type": "audio/mpeg" } })]]));
});

async function get(path: string, range?: string): Promise<Response | undefined> {
  let out: Promise<Response> | undefined;
  onFetch({ request: new Request(ORIGIN + path, { headers: range ? { range } : {} }), respondWith: (r) => { out = r; } });
  return out && (await out);
}
const saved = offlineUrl("https://cdn.example/a.mp3");

describe("service worker: saved audio", () => {
  it("shares the cache name and path with offline-audio.ts", () => {
    const src = readFileSync("public/sw.js", "utf8");
    expect(src).toContain(`AUDIO_CACHE = "${AUDIO_CACHE}"`);
    expect(src).toContain(`AUDIO_PATH = "${AUDIO_PATH}"`);
  });

  it("the whole file without a range", async () => {
    const r = (await get(saved))!;
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(file);
  });

  it("Safari's two-byte probe, an open range, a suffix", async () => {
    const probe = (await get(saved, "bytes=0-1"))!;
    expect(probe.status).toBe(206);
    expect(probe.headers.get("content-range")).toBe("bytes 0-1/100");
    expect([...new Uint8Array(await probe.arrayBuffer())]).toEqual([0, 1]);
    const open = (await get(saved, "bytes=90-"))!;
    expect(open.headers.get("content-range")).toBe("bytes 90-99/100");
    expect(open.headers.get("content-length")).toBe("10");
    const suffix = (await get(saved, "bytes=-5"))!;
    expect([...new Uint8Array(await suffix.arrayBuffer())]).toEqual([95, 96, 97, 98, 99]);
    const past = (await get(saved, "bytes=50-500"))!;
    expect(past.headers.get("content-range")).toBe("bytes 50-99/100");
  });

  it("416 for a range it can't give", async () => {
    expect((await get(saved, "bytes=100-"))!.status).toBe(416);
    expect((await get(saved, "bytes=5-2"))!.status).toBe(416);
    expect((await get(saved, "items=0-1"))!.status).toBe(416);
  });

  it("not saved (cleared since): sends the element to the stream", async () => {
    const r = (await get(offlineUrl("https://cdn.example/gone.mp3")))!;
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://cdn.example/gone.mp3");
    expect((await get(`${AUDIO_PATH}?u=${encodeURIComponent("http://evil.example/x")}`))!.status).toBe(404);
  });
});
