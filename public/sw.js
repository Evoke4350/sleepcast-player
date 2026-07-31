/* sleepcast service worker — vanilla, no Workbox.
 * Strategies:
 *   - Navigation: network-first, fall back to the cached page, then to the
 *     cached player shell at /.
 *   - Static assets (js, css, fonts, images): stale-while-revalidate.
 *   - API endpoints: not intercepted (real network only).
 */
const VERSION = "v3";
const SHELL_CACHE = `sleepcast-shell-${VERSION}`;
const PAGE_CACHE  = `sleepcast-pages-${VERSION}`;
const ASSET_CACHE = `sleepcast-assets-${VERSION}`;

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
          .filter((k) => k.startsWith("sleepcast-") && !k.endsWith(VERSION))
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

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  // Worker scripts on a crossOriginIsolated page must load straight from the
  // network: SW-mediated responses fail the COEP check and the worker dies
  // with an opaque error.
  if (req.destination === "worker" || req.destination === "sharedworker") return;
  const url = new URL(req.url);

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
