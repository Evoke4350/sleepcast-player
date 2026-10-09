// The head script that moves a #watch= fragment (an Apple Watch link's
// sleep stages, rest/watch.ts) out of the address before analytics can read
// the page's URL, on load and if one lands later. The island then reads it
// from window.__sleepcastWatch (AppPlayer's takeWatchLink), told by a
// "sleepcast-watch" event. A held link handed on across a reload
// (AppPlayer's readHeldLink and reloadAfterPaste) arrives through session storage instead,
// read and cleared here (only on /, where the island reads it: elsewhere it
// waits). On any other page (/watch, /privacy) the link is
// sent on to / (out of this page's address first), where it is read. A
// second link before the island reads the first replaces it: harmless, as
// each run reads two days. Server-side only (PlayerLayout).
import { createHash } from "node:crypto";
import { WATCH_HASH, WATCH_PENDING_KEY } from "./rest/watch-hash";

export const TAKE_WATCH_LINK = `(function(){function take(){var h=location.hash;if(h.indexOf(${JSON.stringify(WATCH_HASH)})!==0)return;history.replaceState(null,'',location.pathname+location.search);if(location.pathname!=='/'){location.replace('/'+h);return}window.__sleepcastWatch=h;window.dispatchEvent(new Event('sleepcast-watch'))}try{var p=location.pathname==='/'?sessionStorage.getItem(${JSON.stringify(WATCH_PENDING_KEY)}):null;if(p!==null){sessionStorage.removeItem(${JSON.stringify(WATCH_PENDING_KEY)});if(p.indexOf(${JSON.stringify(WATCH_HASH)})===0)window.__sleepcastWatch=p}}catch(e){}take();addEventListener('popstate',take);addEventListener('hashchange',take)})();`;

/** Its CSP hash: the CSP (astro.config.mjs) blocks an inline script it has
 *  no hash for, and Astro doesn't hash is:inline ones. Computed once. */
export const TAKE_WATCH_LINK_HASH = `sha256-${createHash("sha256").update(TAKE_WATCH_LINK).digest("base64")}` as const;
