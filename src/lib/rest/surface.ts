import type { RestNight } from "./types";
import { loadNights } from "./ledger";
import { fmtOnsetMinutes } from "./sleepscore";

const GOODBYE_SEEN_KEY = "sleepcast2.rest.goodbye";

/** Minutes, as fmtOnsetMinutes words them: a watch onset can be under a
 *  minute, and the headline must read the same as the watch's line. */
export function fmtDuration(ms: number): string {
  return fmtOnsetMinutes(ms);
}

export function lastNight(): RestNight | null {
  const n = loadNights();
  return n.length ? n[n.length - 1] : null;
}

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
