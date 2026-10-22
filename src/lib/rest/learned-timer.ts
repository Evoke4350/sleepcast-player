// The sleep timer, learned from the nights: long enough to cover how long you
// usually take to fall asleep, with room to spare, so the fade comes after
// you're under rather than while you're still listening.
import type { RestNight } from "./types";
import { believableOnsetMs } from "./ledger";

/** Timed nights needed before the timer learns. Fewer and one odd night
 *  moves it too far. */
export const LEARN_MIN_NIGHTS = 5;
/** Only the recent nights: sleep changes (a new job, a hard month), and the
 *  timer should follow. */
export const LEARN_WINDOW = 14;
/** Room after the onset the timer aims to cover. */
export const LEARN_MARGIN_MIN = 10;
const LEARN_FLOOR_MIN = 20;
const LEARN_CEIL_MIN = 180;

export interface LearnedTimer {
  /** Tonight's timer, in minutes (a multiple of 5). */
  minutes: number;
  /** The middle of the recent times to sleep. */
  usualMs: number;
  /** Nights it learned from. */
  nights: number;
}

/**
 * What a night says about how long the timer needs to be, in ms; null when it
 * says nothing.
 *
 * A slept night with a believable onset: that time to sleep. A night that
 * faded on its timer with no onset and not marked slept: the timer ran out
 * first, so sleep took at least that long. Counting it (at the timer's
 * length) is what lets a timer that's too short grow. Nights ended by hand
 * or abandoned with no onset say nothing about the timer.
 */
function evidenceMs(n: RestNight): number | null {
  const onset = believableOnsetMs(n);
  if (onset !== null) return onset;
  if (n.endedVia === "faded" && n.sleptAtMs === null && n.selfLabel !== "slept" && n.timerMinutes > 0) {
    return n.timerMinutes * 60_000;
  }
  return null;
}

function quantile(sorted: readonly number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** Timed nights so far, toward LEARN_MIN_NIGHTS (for "learns after 5"). */
export function timedNights(nights: readonly RestNight[]): number {
  return nights.filter((n) => believableOnsetMs(n) !== null).length;
}

/**
 * The learned timer, or null until there are LEARN_MIN_NIGHTS timed nights
 * among the recent ones.
 *
 * Aims at the slower nights, not the usual one: the 75th percentile of the
 * recent evidence plus LEARN_MARGIN_MIN, rounded up to 5 minutes. A timer
 * that ends before you're asleep wakes you; one a little long costs nothing.
 */
export function learnedTimer(nights: readonly RestNight[]): LearnedTimer | null {
  const recent: { ms: number; timed: boolean }[] = [];
  for (let i = nights.length - 1; i >= 0 && recent.length < LEARN_WINDOW; i--) {
    const ms = evidenceMs(nights[i]);
    if (ms !== null) recent.push({ ms, timed: believableOnsetMs(nights[i]) !== null });
  }
  const timed = recent.filter((r) => r.timed).map((r) => r.ms).sort((a, b) => a - b);
  if (timed.length < LEARN_MIN_NIGHTS) return null;
  const all = recent.map((r) => r.ms).sort((a, b) => a - b);
  const aimMin = quantile(all, 0.75) / 60_000 + LEARN_MARGIN_MIN;
  const minutes = Math.min(LEARN_CEIL_MIN, Math.max(LEARN_FLOOR_MIN, Math.ceil(aimMin / 5) * 5));
  return { minutes, usualMs: Math.round(quantile(timed, 0.5)), nights: recent.length };
}

/** A timer picked by hand holds for this long (tonight), then the learned
 *  one is back. */
export const HAND_PICK_HOLDS_MS = 12 * 60 * 60 * 1000;

export function handPickHolds(pickedAt: number | undefined, now: number): boolean {
  return pickedAt !== undefined && now - pickedAt >= 0 && now - pickedAt < HAND_PICK_HOLDS_MS;
}
