import type { APIRoute } from "astro";
import { youtubeHandleUrl, channelIdFromHtml } from "../../lib/youtube-resolve";
import { rateLimit, clientIp } from "../../lib/ratelimit";

// Resolve a YouTube @handle to a channel id.
//
// Deliberately NOT part of /api/relay, and deliberately not shaped like it.
// The relay takes a URL from the caller and spends its guard budget proving
// that URL is safe; this takes a handle and never lets the caller near a URL
// at all. The only thing it can ever fetch is https://www.youtube.com/@<h>
// where <h> matched /^[A-Za-z0-9._-]{1,64}$/, and the only thing it can ever
// return is a 24-character channel id. The page is never sent back, so this
// cannot be used to read anything, and there is no redirect to follow because
// a wrong handle is a 404 rather than a hop somewhere else.
//
// It exists because the honest alternative was a chore: a handle carries no
// channel id, and telling a listener on a phone to go find the /channel/UC…
// address is telling them to do something YouTube's mobile UI mostly doesn't
// let them do.

// The page is around 1MB. Four is slack, not an invitation.
const MAX_BYTES = 4 * 1024 * 1024;
const UA = { "User-Agent": "sleepcast/2.0" };

// Far tighter than the relay's 60: adding a channel is a once-in-a-while act,
// not something a night does. A handful of typos, then wait.
const RATE_MAX = 10;
const RATE_WINDOW_MS = 5 * 60 * 1000;

// Handles do not change often and the answer is a permanent fact about a
// channel, so a hit costs nothing and spares both us and YouTube the fetch.
const CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { id: string; at: number }>();

function cached(handle: string): string | null {
  const hit = cache.get(handle);
  if (!hit || Date.now() - hit.at > CACHE_MS) return null;
  cache.delete(handle);
  cache.set(handle, hit); // most-recently-used
  return hit.id;
}

function remember(handle: string, id: string) {
  cache.delete(handle);
  cache.set(handle, { id, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

export const GET: APIRoute = async ({ url, request }) => {
  const handle = (url.searchParams.get("handle") ?? "").trim();

  const target = youtubeHandleUrl(handle);
  if (!target) return json({ error: "not a handle" }, 400);
  const key = handle.replace(/^@/, "").toLowerCase();

  const hit = cached(key);
  if (hit) return json({ channelId: hit }, 200);

  // After the cache, before the fetch: a cache hit costs nothing and should
  // not spend anyone's budget.
  const limit = rateLimit(`yt:${clientIp(request)}`, RATE_MAX, RATE_WINDOW_MS);
  if (!limit.ok) {
    return new Response("slow down", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(limit.resetIn / 1000)) },
    });
  }

  let resp: Response;
  try {
    resp = await fetch(target, {
      headers: UA,
      redirect: "follow", // youtube.com only; the URL was built here, not taken
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return json({ error: "couldn't reach youtube" }, 502);
  }
  if (resp.status === 404) return json({ error: "no such channel" }, 404);
  if (!resp.ok) return json({ error: "youtube said no" }, 502);

  // Read with a ceiling rather than resp.text(): an unbounded body on a 512MB
  // machine is a denial of service with extra steps.
  const reader = resp.body?.getReader();
  if (!reader) return json({ error: "empty response" }, 502);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return json({ error: "channel page too large" }, 502);
      }
      chunks.push(value);
    }
  } catch {
    return json({ error: "couldn't read the channel page" }, 502);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const id = channelIdFromHtml(new TextDecoder("utf-8", { fatal: false }).decode(merged));
  if (!id) return json({ error: "no channel id on that page" }, 404);

  remember(key, id);
  return json({ channelId: id }, 200);
};
