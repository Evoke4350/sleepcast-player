/** The fragment key the Shortcut writes: #watch=... Its own module, so the
 *  head script (watch-link-script.ts) shares it without pulling in the
 *  import. */
export const WATCH_HASH = "#watch=";

/** Session storage key a held link is handed on through, across a reload
 *  (AppPlayer's readHeldLink; the head script reads and clears it). */
export const WATCH_PENDING_KEY = "sleepcast2.watch-pending";

const HOUR_MS = 60 * 60_000;

/** How far back a Shortcut run reads: two calendar days, 49 h across a DST
 *  change at most. */
export const SHORTCUT_REACH_MS = 49 * HOUR_MS;

/** How late a run's data may be read and still be taken (a paste, a held
 *  link), by its newest sample, which comes from the run's morning or the
 *  night before: three days, and the half day before the run. Older, it is
 *  a link reopened from history: refused. The ledger keeps timelines this
 *  plus SHORTCUT_REACH_MS, so every night such data can reach still has one. */
export const STALE_AFTER_MS = 3.5 * 24 * HOUR_MS;
