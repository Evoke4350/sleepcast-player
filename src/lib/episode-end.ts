// How a short episode, or a run of failures, ends things.

/** Consecutive failures (stuck episodes, source errors) before the player
 *  gives up on the whole lineup and ends the night. */
export const MAX_FAILS = 6;

/** Seconds from the end within which a start means "play it whole". */
export const PLAY_WHOLE_WITHIN_SEC = 30;

/** Whether starting at `startSec` would land within PLAY_WHOLE_WITHIN_SEC of
 *  the end: null while the duration is unknown. A stream with no length
 *  (Infinity) is long. Player's skip-intro uses it to play such an episode
 *  whole. */
export function tooShortForStart(startSec: number, durationSec: number): boolean | null {
  if (Number.isNaN(durationSec) || durationSec <= 0) return null;
  return startSec >= durationSec - PLAY_WHOLE_WITHIN_SEC;
}
