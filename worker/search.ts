// /api/search and /api/art on Cloudflare Workers: a podcast directory for
// the browser, through this site, so the directory sees Cloudflare and not
// the listener.
//
// Two directories. What goes to either is the typed words, nothing else:
// no identity, no cookies, and the query isn't logged here. Results come
// back trimmed to what the app shows, with their artwork rewritten to
// /api/art, which fetches it the same way, so showing the results reaches
// the directory no more than the search did.
//
// Podcast Index (podcastindex.org), an open directory, answers first when
// the worker has a key for it (the request is signed with the key). Its
// artwork sits on the shows' own hosts, so each image link is signed with
// a worker-side key (ART_KEY) and /api/art fetches it only with a valid
// signature: pictures without /api/art becoming an image proxy for anyone.
//
// Apple's free search (itunes.apple.com/search) is the fallback: with no
// key, when Podcast Index is down, or when it finds nothing. It used to be
// first, but Apple limits searches per address and a Worker's outbound
// address is shared with everyone on Cloudflare, so it refused nearly every
// first try and each search waited through the retries for nothing.
//
// Both are cached at the edge: a search for an hour, artwork for a week.

export const SEARCH_MAX_CHARS = 100;
export const SEARCH_LIMIT = 25;
const SEARCH_FRESH_S = 60 * 60;
const ART_FRESH_S = 7 * 24 * 60 * 60;
/** Apple sends thumbnails; a show's own artwork is full size (often a
 *  3000-pixel square), so the cap allows those but not a stray video. */
const ART_MAX_BYTES = 4 * 1024 * 1024;
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
  /** Signs artwork links from hosts other than Apple's (a worker secret);
   *  without it, those results show no artwork. */
  artKey?: string;
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

/** An https image URL on any host, the only kind a signature covers. */
export function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

const SIG_HEX = 32; // 128 bits of the HMAC: enough that no one guesses one

async function hmacHex(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, SIG_HEX);
}

/** The /api/art link for an image on a show's own host, signed. */
export async function signArt(url: string, key: string): Promise<string> {
  return `/api/art?u=${encodeURIComponent(url)}&s=${await hmacHex(key, url)}`;
}

/** Whether `sig` is this worker's signature for `url` (compared in full,
 *  whatever the first differing character). */
export async function verifyArt(url: string, sig: string, key: string): Promise<boolean> {
  const want = await hmacHex(key, url);
  if (sig.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= sig.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

/** Podcast Index's rows (search/byterm → feeds[]), trimmed the same way.
 *  Artwork comes from the shows' own hosts, so each link is signed; with
 *  no key to sign with, the rows carry none. */
export async function trimIndexResults(json: unknown, artKey?: string): Promise<SearchHit[]> {
  const rows = (json as { feeds?: unknown[] })?.feeds;
  if (!Array.isArray(rows)) return [];
  const out: SearchHit[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const feedUrl = typeof r.url === "string" ? r.url : "";
    if (!/^https:\/\//i.test(feedUrl)) continue;
    const title = typeof r.title === "string" ? r.title : "";
    if (!title) continue;
    const hit: SearchHit = { title, author: typeof r.author === "string" ? r.author : "", feedUrl };
    const image = typeof r.image === "string" ? r.image : typeof r.artwork === "string" ? r.artwork : "";
    if (artKey && isHttpsUrl(image)) hit.art = await signArt(image, artKey);
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
    return await trimIndexResults(await resp.json(), deps.artKey);
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

  // Podcast Index first; Apple when it has no key, is down, or finds
  // nothing. Nothing from either: Index's empty answer if it gave one, else
  // Apple's reason.
  const index = await fromIndex(q, deps);
  let hits: SearchHit[];
  if (index && index.length) hits = index;
  else {
    const apple = await fromApple(q, deps);
    if ("hits" in apple) hits = apple.hits;
    else if (index) hits = index;
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
  const params = new URL(request.url).searchParams;
  const target = params.get("u") ?? "";
  // Apple's hosts on their own; any other host only with this worker's
  // signature, given out with a search result.
  const sig = params.get("s");
  const allowed = isAppleArtUrl(target) || (!!sig && !!deps.artKey && isHttpsUrl(target) && (await verifyArt(target, sig, deps.artKey)));
  if (!allowed) return new Response("bad url", { status: 400 });

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
