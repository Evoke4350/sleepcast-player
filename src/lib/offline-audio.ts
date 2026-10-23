// Tonight's episodes, saved on the device while the night plays.
//
// Streaming means a Wi-Fi drop at 2am is silence until it comes back
// (network-hold.ts waits it out; it can't make sound). So while an episode
// plays, it and the one picked to follow it are downloaded whole into the
// Cache API, and an episode saved in full plays from there through the
// service worker (public/sw.js, which answers the element's range requests).
//
// Downloaded straight from the podcast's host: every built-in feed's audio
// host sends CORS headers. One that doesn't simply fails to download and
// streams as before. The cache keeps only what the night still needs.

import type { Episode } from "./engine";

/** Shared with public/sw.js: the cache, and the path it serves saved audio at. */
export const AUDIO_CACHE = "sleepcast-offline-audio";
export const AUDIO_PATH = "/offline-audio";

/** Where a saved episode is served from (same origin, so through the SW). */
export function offlineUrl(remote: string): string {
  return `${AUDIO_PATH}?u=${encodeURIComponent(remote)}`;
}

/** The remote URL a cache key stands for. */
function remoteOf(key: string): string | null {
  try {
    const u = new URL(key, "https://x.invalid");
    return u.pathname === AUDIO_PATH ? u.searchParams.get("u") : null;
  } catch {
    return null;
  }
}

/** YouTube episodes play in an embed, never from a file. */
export function canSave(ep: Pick<Episode, "url" | "youtubeId">): boolean {
  return !ep.youtubeId && /^https:\/\//i.test(ep.url);
}

function offline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function supported(): boolean {
  return typeof caches !== "undefined" && typeof navigator !== "undefined" && !!navigator.serviceWorker;
}

/**
 * Keeps the night's episodes saved: `keep()` names what the night needs now,
 * the rest of the cache goes, and what's missing downloads one at a time.
 */
export class OfflineAudio {
  /** Remote URLs saved in full, as far as this page knows. */
  private saved = new Set<string>();
  private wanted: string[] = [];
  /** Whether keep() has run: its first call always prunes, even to keep
   *  nothing (the setting turned off). */
  private kept = false;
  private downloading: { url: string; abort: AbortController } | null = null;
  /** URLs that failed to download tonight (no CORS, a 404, no room). */
  private failed = new Set<string>();
  private ready: Promise<void>;
  private readonly onOnline = () => void this.pump();

  constructor(private readonly onSaved: (url: string) => void = () => {}) {
    this.ready = supported()
      ? caches.open(AUDIO_CACHE)
          .then((c) => c.keys())
          .then((keys) => {
            for (const k of keys) {
              const u = remoteOf(k.url);
              if (u) this.saved.add(u);
            }
          })
          .catch(() => {})
      : Promise.resolve();
    // Offline, downloads wait (a failure then says nothing about the file).
    if (typeof window !== "undefined") window.addEventListener("online", this.onOnline);
  }

  /** Whether this episode can play from the device right now: saved in
   *  full, and a service worker in charge of the page to serve it. */
  has(ep: Pick<Episode, "url">): boolean {
    return this.saved.has(ep.url) && !!navigator.serviceWorker?.controller;
  }

  /** What to set as the element's src: the saved copy when there is one. */
  sourceFor(ep: Pick<Episode, "url">): string {
    return this.has(ep) ? offlineUrl(ep.url) : ep.url;
  }

  /** The episodes the night needs saved, in order of need. Anything else
   *  saved goes; a download for something no longer needed stops. */
  keep(eps: readonly Pick<Episode, "url" | "youtubeId">[]): void {
    if (!supported()) return;
    const next = eps.filter(canSave).map((e) => e.url);
    if (this.kept && next.length === this.wanted.length && next.every((u, i) => u === this.wanted[i])) return;
    this.kept = true;
    this.wanted = next;
    // Again after a stop() (adding the same listener twice is a no-op).
    window.addEventListener("online", this.onOnline);
    if (this.downloading && !next.includes(this.downloading.url)) {
      this.downloading.abort.abort();
      this.downloading = null;
    }
    void this.ready.then(() => this.prune()).then(() => this.pump());
  }

  /** Stop downloading and forget what tonight wanted (the cache stays, for
   *  a revived night; the next night's keep() clears it). */
  stop(): void {
    if (typeof window !== "undefined") window.removeEventListener("online", this.onOnline);
    this.wanted = [];
    this.downloading?.abort.abort();
    this.downloading = null;
  }

  private async prune(): Promise<void> {
    try {
      const cache = await caches.open(AUDIO_CACHE);
      for (const k of await cache.keys()) {
        const u = remoteOf(k.url);
        if (u && this.wanted.includes(u)) continue;
        if (u) this.saved.delete(u);
        await cache.delete(k);
      }
    } catch { /* nothing saved is better than a broken night */ }
  }

  private async pump(): Promise<void> {
    if (this.downloading || offline()) return;
    const url = this.wanted.find((u) => !this.saved.has(u) && !this.failed.has(u));
    if (!url) return;
    const abort = new AbortController();
    this.downloading = { url, abort };
    try {
      await download(url, abort.signal);
      if (this.wanted.includes(url)) {
        this.saved.add(url);
        this.onSaved(url);
      } else {
        // No longer needed by the time it finished.
        await (await caches.open(AUDIO_CACHE)).delete(offlineUrl(url));
      }
    } catch {
      // A download cut off by the network going is tried again when it's
      // back; anything else (no CORS, a 404, no room) isn't, tonight.
      if (!abort.signal.aborted && !offline()) this.failed.add(url);
    } finally {
      if (this.downloading?.abort === abort) this.downloading = null;
    }
    void this.pump();
  }
}

/** Download one episode whole into the cache. Throws on anything short of a
 *  complete audio file; cache.put stores nothing from a body cut off. */
async function download(url: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { mode: "cors", credentials: "omit", signal });
  if (res.status !== 200 || !res.body) throw new Error(`status ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (/text\/html|xml|json/i.test(type)) throw new Error(`not audio: ${type}`);
  const headers = new Headers({ "Content-Type": type || "audio/mpeg" });
  const len = res.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  const cache = await caches.open(AUDIO_CACHE);
  await cache.put(offlineUrl(url), new Response(res.body, { headers }));
  // A body shorter than it said it was: a connection cut off cleanly.
  if (len) {
    const stored = await cache.match(offlineUrl(url));
    const size = (await stored?.blob())?.size ?? 0;
    if (size !== Number(len)) {
      await cache.delete(offlineUrl(url));
      throw new Error("incomplete");
    }
  }
}
