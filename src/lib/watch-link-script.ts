// The head script that moves a #watch= fragment (an Apple Watch link's
// sleep stages, rest/watch.ts) out of the address before analytics can read
// the page's URL, on load and if one lands later. The island then reads it
// from window.__sleepcastWatch (AppPlayer's takeWatchLink), told by a
// "sleepcast-watch" event. Server-side only (PlayerLayout).
import { createHash } from "node:crypto";

export const TAKE_WATCH_LINK = `(function(){function take(){if(location.hash.indexOf('#watch=')!==0)return;window.__sleepcastWatch=location.hash;history.replaceState(null,'',location.pathname+location.search);window.dispatchEvent(new Event('sleepcast-watch'))}take();addEventListener('popstate',take);addEventListener('hashchange',take)})();`;

/** Its CSP hash: the CSP (astro.config.mjs) blocks an inline script it has
 *  no hash for, and Astro doesn't hash is:inline ones. Computed once. */
export const TAKE_WATCH_LINK_HASH = `sha256-${createHash("sha256").update(TAKE_WATCH_LINK).digest("base64")}` as const;
