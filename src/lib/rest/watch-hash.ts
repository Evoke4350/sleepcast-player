/** The fragment key the Shortcut writes: #watch=... Its own module, so the
 *  head script (watch-link-script.ts) shares it without pulling in the
 *  import. */
export const WATCH_HASH = "#watch=";

/** Session storage key a held link is handed on through, across a reload
 *  (AppPlayer's readHeldLink and reloadAfterPaste; the head script reads and clears it). */
export const WATCH_PENDING_KEY = "sleepcast.watch-pending";
