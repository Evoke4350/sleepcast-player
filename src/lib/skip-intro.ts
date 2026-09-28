// The skip-intro: seek past a feed's intro, unless the episode is too short
// for it.
//
// The seek waits until the duration is known (Chrome knows it at metadata,
// Safari can take a moment longer). Seeking first and undoing it later went
// wrong in too many ways: a tail played before the undo, a reload in between
// lost track of which seek was whose, a listener's own scrub got undone. An
// intro that plays for a second or two while the duration arrives costs far
// less.

import { tooShortForStart } from "./episode-end";

/** How far into the episode the skip still applies: past this, it has played
 *  a while or the listener has moved, and it is left where it is. */
export const SKIP_STILL_AT_START_SEC = 15;

export type SkipDecision = "wait" | "skip" | "none";

/** Whether a position is still at the start, for the skip's purposes: the
 *  one rule every player uses. */
export function stillAtStart(positionSec: number, skipSec: number): boolean {
  return positionSec <= SKIP_STILL_AT_START_SEC && positionSec < skipSec;
}

/** Whether to seek past the intro now. */
export function decideSkip(skipSec: number, durationSec: number, currentTime: number): SkipDecision {
  const short = tooShortForStart(skipSec, durationSec);
  if (short === null) return "wait";
  if (short) return "none"; // plays whole
  return stillAtStart(currentTime, skipSec) ? "skip" : "none";
}

/** Where Night and YouTubeNight start a load, by the same rule: the skip
 * applies at a start near the beginning (a first play, or a revive from a
 * snapshot taken a second in), not to a saved position further along. (They
 * check a too-short episode afterwards, with shouldPlayWhole.) */
export function startWithSkip(seekTo: number, skipSec: number): number {
  return stillAtStart(seekTo, skipSec) ? skipSec : seekTo;
}

/** What the listener is told once the skip lands. */
export function skipMessage(skipSec: number): string {
  const seconds = Math.max(1, Math.round(skipSec));
  if (seconds < 60) return `skipped the ${seconds} s intro`;
  const minutes = Number((skipSec / 60).toFixed(1)); // 1.02 shows as 1
  return `skipped the ${minutes} min intro`;
}
