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

/** Whether to seek past the intro now. */
export function decideSkip(skipSec: number, durationSec: number, currentTime: number): SkipDecision {
  const short = tooShortForStart(skipSec, durationSec);
  if (short === null) return "wait";
  if (short) return "none"; // plays whole
  return currentTime <= SKIP_STILL_AT_START_SEC && currentTime < skipSec ? "skip" : "none";
}

/** What the listener is told once the skip lands. */
export function skipMessage(skipSec: number): string {
  if (skipSec < 60) return `skipped the ${Math.round(skipSec)} s intro`;
  const minutes = skipSec / 60;
  const shown = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
  return `skipped the ${shown} min intro`;
}
