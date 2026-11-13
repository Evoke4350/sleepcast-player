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
}

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

export async function search(request: Request, deps: SearchDeps): Promise<Response> {
  if (!(await deps.allow())) return new Response("slow down", { status: 429, headers: { "Retry-After": "60" } });
  const self = new URL(request.url);
  const q = normalizeQuery(self.searchParams.get("q") ?? "");
  if (q.length < 2) return new Response("say more", { status: 400 });

  const key = new Request(new URL(`/api/search-cache?q=${encodeURIComponent(q.toLowerCase())}`, request.url));
  const cached = await deps.cache?.match(key).catch(() => undefined);
  if (cached) return cached;

  const upstream = new URL("https://itunes.apple.com/search");
  upstream.searchParams.set("media", "podcast");
  upstream.searchParams.set("entity", "podcast");
  upstream.searchParams.set("limit", String(SEARCH_LIMIT));
  upstream.searchParams.set("term", q);
  let json: unknown;
  try {
    const resp = await deps.fetch(upstream.toString(), { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return new Response("directory " + resp.status, { status: 502 });
    json = await resp.json();
  } catch {
    return new Response("directory failed", { status: 502 });
  }
  const body = JSON.stringify(trimResults(json));
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
