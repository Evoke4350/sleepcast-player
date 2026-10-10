import type { RestNight } from "./types";
import { lastOf, loadNights } from "./ledger";
import { fmtOnsetMinutes } from "./sleepscore";

// Also imported by the host app (sleepcast-app), so they stay exported; the
// goodbye below uses lastNight too.
/** The newest night (lastOf over the ledger). */
export function lastNight(): RestNight | null {
  return lastOf(loadNights());
}

/** Minutes, as fmtOnsetMinutes words them (the host app's name for it). */
export { fmtOnsetMinutes as fmtDuration };

const GOODBYE_SEEN_KEY = "sleepcast2.rest.goodbye";

/** The most recent night, only if it was detected as slept and we haven't
 *  already said goodbye for it. Time-agnostic beyond the once-per-night guard —
 *  a sleep app should not do date math on the user's timezone at 6am. */
export function shouldGreetGoodbye(_now: number): RestNight | null {
  const n = lastNight();
  if (!n || n.sleptAtMs === null) return null;
  let seen: number | null = null;
  try { seen = Number(localStorage.getItem(GOODBYE_SEEN_KEY)); } catch { /* ignore */ }
  return seen === n.startedAt ? null : n;
}

export function markGoodbyeSeen(startedAt: number): void {
  try { localStorage.setItem(GOODBYE_SEEN_KEY, String(startedAt)); } catch { /* ignore */ }
}
