// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import { OfflineAudio, offlineUrl, AUDIO_CACHE, canSave, MAX_SAVE_BYTES } from "./offline-audio";

/** The Cache API, in memory: enough of it for the manager. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    let m = stores.get(name);
    if (!m) stores.set(name, (m = new Map()));
    const store = m;
    const key = (k: string | Request) => new URL(typeof k === "string" ? k : k.url, "https://sleepcast.pro").href;
    return {
      keys: async () => [...store.keys()].map((u) => new Request(u)),
      match: async (k: string | Request) => store.get(key(k))?.clone(),
      delete: async (k: string | Request) => store.delete(key(k)),
      put: async (k: string | Request, res: Response) => {
        // Like the real one: the whole body is read before anything is stored.
        const body = await res.arrayBuffer();
        store.set(key(k), new Response(body, { headers: res.headers }));
      },
    };
  };
  return { open, stores };
}

const ep = (n: number) => ({ url: `https://cdn.example/ep${n}.mp3` });
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 20; i++) await flush();
}

let c: ReturnType<typeof fakeCaches>;
let fetchMock: ReturnType<typeof vi.fn>;
const saved = () => [...(c.stores.get(AUDIO_CACHE)?.keys() ?? [])].map((k) => decodeURIComponent(k.split("u=")[1]));

beforeEach(() => {
  c = fakeCaches();
  vi.stubGlobal("caches", c);
  vi.stubGlobal("navigator", { serviceWorker: { controller: {} }, onLine: true });
  vi.stubGlobal("window", new EventTarget());
  fetchMock = vi.fn(async (url: string) =>
    new Response(new Uint8Array(1000), { headers: { "content-type": "audio/mpeg", "content-length": "1000" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

describe("OfflineAudio", () => {
  it("saves what the night needs, one at a time in order, then plays it from the device", async () => {
    const onSaved = vi.fn();
    const o = new OfflineAudio(onSaved);
    expect(o.sourceFor(ep(1))).toBe(ep(1).url);
    o.keep([ep(1), ep(2)]);
    await settle();
    expect(fetchMock.mock.calls.map((a) => a[0])).toEqual([ep(1).url, ep(2).url]);
    expect(onSaved.mock.calls.map((a) => a[0])).toEqual([ep(1).url, ep(2).url]);
    expect(o.sourceFor(ep(1))).toBe(offlineUrl(ep(1).url));
    expect(saved()).toEqual([ep(1).url, ep(2).url]);
  });

  it("keeps only what's still needed", async () => {
    const o = new OfflineAudio();
    o.keep([ep(1), ep(2)]);
    await settle();
    o.keep([ep(2), ep(3)]);
    await settle();
    expect(saved().sort()).toEqual([ep(2).url, ep(3).url]);
    expect(o.has(ep(1))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3); // ep2 not downloaded twice
  });

  it("finds what an earlier page saved (a revived night)", async () => {
    new OfflineAudio().keep([ep(1)]);
    await settle();
    const o = new OfflineAudio();
    o.keep([ep(1)]);
    await settle();
    expect(o.has(ep(1))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turned off: the first keep([]) clears everything", async () => {
    new OfflineAudio().keep([ep(1)]);
    await settle();
    new OfflineAudio().keep([]);
    await settle();
    expect(saved()).toEqual([]);
  });

  it("streams as before when a download fails, and doesn't retry it tonight", async () => {
    fetchMock.mockImplementationOnce(async () => { throw new TypeError("CORS"); });
    const o = new OfflineAudio();
    o.keep([ep(1), ep(2)]);
    await settle();
    expect(o.sourceFor(ep(1))).toBe(ep(1).url);
    expect(o.has(ep(2))).toBe(true);
    o.keep([ep(1)]);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("offline, waits for the network instead of giving up on the file", async () => {
    vi.stubGlobal("navigator", { serviceWorker: { controller: {} }, onLine: false });
    const o = new OfflineAudio();
    o.keep([ep(1)]);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    (navigator as { onLine: boolean }).onLine = true;
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(o.has(ep(1))).toBe(true);
  });

  it("a download cut off by the network going is tried again when it's back", async () => {
    fetchMock.mockImplementationOnce(async () => {
      (navigator as { onLine: boolean }).onLine = false;
      throw new TypeError("network");
    });
    const o = new OfflineAudio();
    o.keep([ep(1)]);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    (navigator as { onLine: boolean }).onLine = true;
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(o.has(ep(1))).toBe(true);
  });

  it("refuses what isn't a whole audio file", async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response("<html>", { headers: { "content-type": "text/html" } }))
      .mockImplementationOnce(async () => new Response(new Uint8Array(10), { status: 206, headers: { "content-type": "audio/mpeg" } }))
      .mockImplementationOnce(async () => new Response(new Uint8Array(500), { headers: { "content-type": "audio/mpeg", "content-length": "1000" } }));
    const o = new OfflineAudio();
    o.keep([ep(1), ep(2), ep(3)]);
    await settle();
    expect([1, 2, 3].map((n) => o.has(ep(n)))).toEqual([false, false, false]);
    expect(saved()).toEqual([]);
  });

  it("streams an episode too large to save, without downloading it", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({ pull: () => { pulls++; }, cancel: () => { cancelled = true; } }, { highWaterMark: 0 });
    fetchMock.mockImplementationOnce(async () =>
      new Response(body, { headers: { "content-type": "audio/mpeg", "content-length": String(MAX_SAVE_BYTES + 1) } }),
    );
    const o = new OfflineAudio();
    o.keep([ep(1), ep(2)]);
    await settle();
    expect(o.has(ep(1))).toBe(false);
    expect(o.has(ep(2))).toBe(true);
    expect(saved()).toEqual([ep(2).url]);
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
  });

  it("stops a download no longer needed", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_u: string, init: RequestInit) => {
      signal = init.signal!;
      return new Promise(() => {});
    });
    const o = new OfflineAudio();
    o.keep([ep(1)]);
    await settle();
    o.keep([ep(2)]);
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(o.has(ep(2))).toBe(true);
  });

  it("plays from the device only with a service worker to serve it", async () => {
    const o = new OfflineAudio();
    o.keep([ep(1)]);
    await settle();
    vi.stubGlobal("navigator", { serviceWorker: { controller: null } });
    expect(o.sourceFor(ep(1))).toBe(ep(1).url);
  });

  it("never YouTube, never plain http", () => {
    expect(canSave({ url: "https://www.youtube.com/watch?v=x", youtubeId: "x" })).toBe(false);
    expect(canSave({ url: "http://cdn.example/a.mp3" })).toBe(false);
    expect(canSave(ep(1))).toBe(true);
  });
});
