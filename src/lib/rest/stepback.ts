// Letting the app fire itself.
//
// The colophon says we're rooting for the nights you don't need us. This is
// that sentence made operational: after a long run of falling asleep quickly,
// the app offers to stop nudging — no 3am re-anchor, no goodbye line — for a
// month. Every other product in this category optimises the opposite way,
// because retention is the metric. It isn't one here.
//
// Deliberately clock-blind. People listen during the day too, and a daytime
// session where nobody fell asleep simply records sleptAtMs: null and counts
// as a night that wasn't slept through. That is honest, and it means the
// offer never fires off the back of afternoon listening.

import type { RestNight } from "./types";

const DAY = 86_400_000;

/** How many recent nights are considered. */
export const STEPBACK_WINDOW = 14;

/** Below this much history the question isn't worth asking. */
export const STEPBACK_MIN_NIGHTS = 10;

/** Share of the window that must have been slept through. One or two misses
 *  are normal in anyone's fortnight and shouldn't disqualify. */
export const STEPBACK_SLEPT_RATIO = 0.8;

/** Falling asleep slower than this means the app is still doing work. */
export const STEPBACK_MEDIAN_MS = 20 * 60_000;

/** How long "go quiet" lasts before the app resumes normal behaviour. */
export const QUIET_DAYS = 30;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Whether the listener looks like they've stopped needing this.
 *
 * A night counts as slept only if the detector said so AND the listener didn't
 * later say otherwise — a self-labelled false positive is the detector being
 * wrong, not evidence of a good night.
 */
export function qualifiesForStepBack(nights: RestNight[]): boolean {
  const window = nights.slice(-STEPBACK_WINDOW);
  if (window.length < STEPBACK_MIN_NIGHTS) return false;

  const slept = window.filter(
    (n) => n.sleptAtMs !== null && n.timeToSleepMs !== null && n.selfLabel !== "awake",
  );
  if (slept.length / window.length < STEPBACK_SLEPT_RATIO) return false;

  const m = median(slept.map((n) => n.timeToSleepMs as number));
  return m !== null && m < STEPBACK_MEDIAN_MS;
}

export function isQuiet(quietUntil: number | null, now: number): boolean {
  return quietUntil !== null && now < quietUntil;
}

export function quietUntilFrom(now: number): number {
  return now + QUIET_DAYS * DAY;
}
