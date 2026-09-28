// Media durations: when one is known, and the one-second margin a seek keeps
// short of the end (a seek onto the very end ends the episode).

/** A media duration, when it is one: finite and positive. NaN (unknown yet),
 *  0 and Infinity (a stream) are not. */
export function knownDuration(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** A position kept within the episode: not before 0, and a second short of a
 *  known end. */
export function shortOfEnd(positionSec: number, durationSec: number | null): number {
  const capped = durationSec === null ? positionSec : Math.min(positionSec, durationSec - 1);
  return Math.max(0, capped);
}
