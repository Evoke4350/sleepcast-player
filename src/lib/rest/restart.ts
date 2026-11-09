// A night started again soon after the last one stopped on its own.
//
// The detector only calls a night slept when it reaches its last minute
// untouched (docs/gated-model.md). That used to be the fade: someone awake
// heard the volume drop and reached for the phone. With no fade, the sound
// plays on until it stops, and someone lying still and awake looks the same
// as someone asleep.
//
// A new night within a few minutes of the stop means you were awake then,
// but not why: still awake when it stopped, or asleep and woken by the stop.
// Those can't be told apart, so the night is neither: its guess is set aside
// (not counted as slept, and not as "the timer ran out first", which would
// stretch the learned timer), kept, and put back if you say you fell asleep.
import type { RestNight, RestartGuess } from "./types";
import { loadNights, saveNights } from "./ledger";

/** A start this soon after the stop means the stop was heard. */
export const RESTART_WITHIN_MS = 5 * 60_000;

/**
 * The ledger with its last night's guessed sleep set aside, or null when
 * nothing changes: only the most recent night, only one that stopped on its
 * own within RESTART_WITHIN_MS of `now`, only Sleepcast's own guess (the
 * watch measured its nights), and never one you marked slept yourself.
 */
export function overturnOnRestart(nights: readonly RestNight[], now: number): RestNight[] | null {
  const last = nights[nights.length - 1];
  if (!last || last.endedVia !== "faded" || last.detector !== "inference") return null;
  if (last.sleptAtMs === null || last.selfLabel === "slept") return null;
  if (last.playedMs === undefined) return null; // no end time to measure from
  const since = now - (last.startedAt + last.playedMs);
  if (since < 0 || since > RESTART_WITHIN_MS) return null;
  const { onsetFeedId, onsetEpisodeId, onsetAfterMs, sleptThrough, detectorAtMs, ...rest } = last;
  const guess: RestartGuess = {
    sleptAtMs: last.sleptAtMs, timeToSleepMs: last.timeToSleepMs, detector: last.detector,
    ...(onsetFeedId !== undefined ? { onsetFeedId } : {}),
    ...(onsetEpisodeId !== undefined ? { onsetEpisodeId } : {}),
    ...(onsetAfterMs !== undefined ? { onsetAfterMs } : {}),
    ...(sleptThrough !== undefined ? { sleptThrough } : {}),
    ...(detectorAtMs !== undefined ? { detectorAtMs } : {}),
  };
  return [
    ...nights.slice(0, -1),
    { ...rest, sleptAtMs: null, timeToSleepMs: null, detector: "none", restartedAfter: true, restartGuess: guess },
  ];
}

/** At the start of a new night (not a revived one): set last night's guess
 *  aside if it ended moments ago. */
export function noteNightStart(now: number = Date.now()): void {
  const next = overturnOnRestart(loadNights(), now);
  if (next) saveNights(next);
}

/** Set aside and not yet answered: says nothing either way. */
export function undecided(n: RestNight): boolean {
  return n.restartedAfter === true && n.selfLabel === undefined;
}
