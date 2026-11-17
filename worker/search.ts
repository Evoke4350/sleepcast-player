// /api/search and /api/art on Cloudflare Workers: a podcast directory for
// the browser, through this site, so the directory sees Cloudflare and not
// the listener.
//
// The directory is Apple's free search (itunes.apple.com/search). What goes
// to it is the typed words, nothing else: no identity, no cookies, and the
// query isn't logged here. Results come back trimmed to what the app shows,
// and their artwork is rewritten to /api/art, which fetches it from Apple's
// image hosts the same way, so showing the results reaches Apple no more
// than the search did.
//
// Apple limits searches per address, and a Worker's outbound address is
// shared with everyone on Cloudflare, so Apple often says 429 to a first
// try. When it keeps saying so, the same words go to Podcast Index
// (podcastindex.org), an open directory, when the worker has a key for it:
// again only the words, signed with the key. Its results carry no artwork
// here (/api/art fetches from Apple's image hosts only).
//
// Both are cached at the edge: a search for an hour, artwork for a week.

export const SEARCH_MAX_CHARS = 100;
export const SEARCH_LIMIT = 25;
const SEARCH_FRESH_S = 60 * 60;
const ART_FRESH_S = 7 * 24 * 60 * 60;
/** Artwork is a thumbnail; anything bigger isn't one. */
const ART_MAX_BYTES = 1024 * 1024;
const UA = { "User-Agent": "sleepcast/2.0" };

export interface SearchDeps {
  fetch: typeof fetch;
  cache?: Pick<Cache, "match" | "put">;
  allow: () => Promise<boolean>;
  later: (p: Promise<unknown>) => void;
  /** A pause before a retry (tests pass none). */
  wait?: (ms: number) => Promise<void>;
  /** Podcast Index credentials (worker secrets); without them, a busy Apple
   *  is the end of it. */
  podcastIndex?: { key: string; secret: string };
  /** The clock, in ms (Podcast Index signs each request with the time). */
  now?: () => number;
}

/** Apple limits searches per address, and a Worker's outbound address is
 *  shared with everyone else on Cloudflare, so a 429 says little about this
 *  site's own traffic. A retry usually leaves from another address. */
const RETRY_AFTER_MS = [300, 900];
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What the app gets per show. */
export interface SearchHit {
  title: string;
  author: string;
  feedUrl: string;
  /** A path on this site (/api/art?u=…); absent when Apple sent none. */
  art?: string;
  episodes?: number;
}

/** The words as searched: trimmed, one space between, lower-cased for the
 *  cache so "Sleep With Me" and "sleep with me" are one entry. */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, SEARCH_MAX_CHARS);
}

/** Apple's image hosts, the only ones /api/art fetches. */
export function isAppleArtUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /(^|\.)mzstatic\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Apple's result rows, trimmed; anything without an https feed is dropped
 *  (the app can't play a show it can't fetch). */
export function trimResults(json: unknown): SearchHit[] {
  const rows = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(rows)) return [];
  const out: SearchHit[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const feedUrl = typeof r.feedUrl === "string" ? r.feedUrl : "";
    if (!/^https:\/\//i.test(feedUrl)) continue;
    const title = typeof r.collectionName === "string" ? r.collectionName : typeof r.trackName === "string" ? r.trackName : "";
    if (!title) continue;
    const hit: SearchHit = { title, author: typeof r.artistName === "string" ? r.artistName : "", feedUrl };
    const art = typeof r.artworkUrl100 === "string" ? r.artworkUrl100 : typeof r.artworkUrl600 === "string" ? r.artworkUrl600 : "";
    if (isAppleArtUrl(art)) hit.art = `/api/art?u=${encodeURIComponent(art)}`; // relative: the page's own origin
    if (typeof r.trackCount === "number" && r.trackCount > 0) hit.episodes = r.trackCount;
    out.push(hit);
  }
  return out;
}

/** Podcast Index's rows (search/byterm → feeds[]), trimmed the same way.
 *  No artwork: its images come from the shows' own hosts, which /api/art
 *  doesn't fetch from. */
export function trimIndexResults(json: unknown): SearchHit[] {
  const rows = (json as { feeds?: unknown[] })?.feeds;
  if (!Array.isArray(rows)) return [];
  const out: SearchHit[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const feedUrl = typeof r.url === "string" ? r.url : "";
    if (!/^https:\/\//i.test(feedUrl)) continue;
    const title = typeof r.title === "string" ? r.title : "";
    if (!title) continue;
    const hit: SearchHit = { title, author: typeof r.author === "string" ? r.author : "", feedUrl };
    if (typeof r.episodeCount === "number" && r.episodeCount > 0) hit.episodes = r.episodeCount;
    out.push(hit);
  }
  return out;
}

/** Podcast Index's request signature: the key, the secret and the time in
 *  seconds, run through SHA-1, sent with the key and the time. */
export async function podcastIndexHeaders(creds: { key: string; secret: string }, nowMs: number): Promise<Record<string, string>> {
  const date = String(Math.floor(nowMs / 1000));
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(creds.key + creds.secret + date));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { ...UA, "X-Auth-Key": creds.key, "X-Auth-Date": date, Authorization: hex };
}

type Directory = { hits: SearchHit[] } | { busy: true } | { failed: true };

/** Apple's directory, with the retries. */
async function fromApple(q: string, deps: SearchDeps): Promise<Directory> {
  const upstream = new URL("https://itunes.apple.com/search");
  upstream.searchParams.set("media", "podcast");
  upstream.searchParams.set("entity", "podcast");
  upstream.searchParams.set("limit", String(SEARCH_LIMIT));
  upstream.searchParams.set("term", q);
  try {
    let resp: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      resp = await deps.fetch(upstream.toString(), { headers: UA, signal: AbortSignal.timeout(10000) });
      if (resp.status !== 429 || attempt >= RETRY_AFTER_MS.length) break;
      await (deps.wait ?? pause)(RETRY_AFTER_MS[attempt]);
    }
    if (resp.status === 429) return { busy: true };
    if (!resp.ok) return { failed: true };
    return { hits: trimResults(await resp.json()) };
  } catch {
    return { failed: true };
  }
}

/** Podcast Index, when the worker has a key; null when it has none or the
 *  directory doesn't answer. */
async function fromIndex(q: string, deps: SearchDeps): Promise<SearchHit[] | null> {
  if (!deps.podcastIndex) return null;
  const upstream = new URL("https://api.podcastindex.org/api/1.0/search/byterm");
  upstream.searchParams.set("q", q);
  upstream.searchParams.set("max", String(SEARCH_LIMIT));
  try {
    const headers = await podcastIndexHeaders(deps.podcastIndex, (deps.now ?? Date.now)());
    const resp = await deps.fetch(upstream.toString(), { headers, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    return trimIndexResults(await resp.json());
  } catch {
    return null;
  }
}

export async function search(request: Request, deps: SearchDeps): Promise<Response> {
  if (!(await deps.allow())) return new Response("slow down", { status: 429, headers: { "Retry-After": "60" } });
  const self = new URL(request.url);
  const q = normalizeQuery(self.searchParams.get("q") ?? "");
  if (q.length < 2) return new Response("say more", { status: 400 });

  const key = new Request(new URL(`/api/search-cache?q=${encodeURIComponent(q.toLowerCase())}`, request.url));
  const cached = await deps.cache?.match(key).catch(() => undefined);
  if (cached) return cached;

  const apple = await fromApple(q, deps);
  let hits: SearchHit[];
  if ("hits" in apple) hits = apple.hits;
  else {
    // Apple busy or down: the other directory, if there is one; else say so.
    const index = await fromIndex(q, deps);
    if (index) hits = index;
    else if ("busy" in apple) return new Response("directory busy", { status: 503, headers: { "Retry-After": "30" } });
    else return new Response("directory failed", { status: 502 });
  }
  const body = JSON.stringify(hits);
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${SEARCH_FRESH_S}` };
  if (deps.cache) deps.later(deps.cache.put(key, new Response(body, { headers })).catch(() => {}));
  return new Response(body, { headers });
}

export async function art(request: Request, deps: SearchDeps): Promise<Response> {
  if (!(await deps.allow())) return new Response("slow down", { status: 429, headers: { "Retry-After": "60" } });
  const target = new URL(request.url).searchParams.get("u") ?? "";
  if (!isAppleArtUrl(target)) return new Response("bad url", { status: 400 });

  const key = new Request(new URL(`/api/art-cache?u=${encodeURIComponent(target)}`, request.url));
  const cached = await deps.cache?.match(key).catch(() => undefined);
  if (cached) return cached;

  let upstream: Response;
  try {
    upstream = await deps.fetch(target, { headers: UA, signal: AbortSignal.timeout(10000) });
  } catch {
    return new Response("art failed", { status: 502 });
  }
  const type = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !type.startsWith("image/")) return new Response("not art", { status: 502 });
  if (Number(upstream.headers.get("content-length") || 0) > ART_MAX_BYTES) return new Response("too large", { status: 413 });
  const body = await upstream.arrayBuffer();
  if (body.byteLength > ART_MAX_BYTES) return new Response("too large", { status: 413 });
  const headers = { "Content-Type": type, "Cache-Control": `public, max-age=${ART_FRESH_S}` };
  if (deps.cache) deps.later(deps.cache.put(key, new Response(body.slice(0), { headers })).catch(() => {}));
  return new Response(body, { headers });
}
