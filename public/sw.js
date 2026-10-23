/* sleepcast service worker — vanilla, no Workbox.
 * Strategies:
 *   - Navigation: network-first, fall back to the cached page, then to the
 *     cached player shell at /.
 *   - Static assets (js, css, fonts, images): stale-while-revalidate.
 *   - API endpoints: not intercepted (real network only).
 *   - /offline-audio?u=…: an episode saved for tonight (src/lib/offline-audio.ts),
 *     answered from its cache with the byte ranges a media element asks for.
 */
const VERSION = "v4";
const SHELL_CACHE = `sleepcast-shell-${VERSION}`;
const PAGE_CACHE  = `sleepcast-pages-${VERSION}`;
const ASSET_CACHE = `sleepcast-assets-${VERSION}`;

// Not versioned: what's saved for tonight outlives an app update.
// Shared with src/lib/offline-audio.ts.
const AUDIO_CACHE = "sleepcast-offline-audio";
const AUDIO_PATH = "/offline-audio";

const SHELL = ["/", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Best-effort precache; don't block install if a route 500s.
      await Promise.allSettled(SHELL.map((u) => cache.add(u)));
      self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          // Only reap OUR versioned caches — anything else on the origin
          // belongs to another feature and is not ours to clear.
          .filter((k) => k.startsWith("sleepcast-") && !k.endsWith(VERSION) && k !== AUDIO_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

function isNavigation(req) {
  return (
    req.mode === "navigate" ||
    (req.method === "GET" &&
      req.headers.get("accept")?.includes("text/html"))
  );
}

async function networkFirstPage(req) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    // The player itself runs offline once its feeds are in localStorage, so
    // the shell is a working fallback rather than an apology page.
    const shell = await caches.match("/");
    return shell ?? new Response("Offline", { status: 503 });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached ?? (await network) ?? Response.error();
}

/** A saved file's answer to a media element's request: the whole file, or
 *  the byte range asked for (Safari asks for ranges, and plays nothing from
 *  a server that won't give them). */
function rangeResponse(blob, type, range) {
  const size = blob.size;
  const base = { "Content-Type": type, "Accept-Ranges": "bytes" };
  if (!range) {
    return new Response(blob, { status: 200, headers: { ...base, "Content-Length": String(size) } });
  }
  const unsatisfiable = () => new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (m[1] === "" && m[2] === "")) return unsatisfiable();
  let start, end;
  if (m[1] === "") {
    // A suffix: the last N bytes.
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) return unsatisfiable();
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: { ...base, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
  });
}

async function offlineAudio(req) {
  const url = new URL(req.url);
  const remote = url.searchParams.get("u");
  let hit;
  try {
    hit = await (await caches.open(AUDIO_CACHE)).match(url.pathname + url.search);
  } catch {
    hit = undefined;
  }
  if (!hit) {
    // Gone since the page chose it (cleared, evicted): stream it instead.
    return remote && /^https:\/\//i.test(remote) ? Response.redirect(remote, 302) : new Response(null, { status: 404 });
  }
  return rangeResponse(await hit.blob(), hit.headers.get("content-type") || "audio/mpeg", req.headers.get("range"));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  // Worker scripts on a crossOriginIsolated page must load straight from the
  // network: SW-mediated responses fail the COEP check and the worker dies
  // with an opaque error.
  if (req.destination === "worker" || req.destination === "sharedworker") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin && url.pathname === AUDIO_PATH) {
    event.respondWith(offlineAudio(req));
    return;
  }

  // Don't intercept the api endpoints — they need real network.
  if (url.pathname.startsWith("/api/")) return;

  if (isNavigation(req)) {
    event.respondWith(networkFirstPage(req));
    return;
  }
  // Static assets: js, css, fonts, images.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
  }
});
