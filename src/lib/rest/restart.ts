// A night started again soon after the last one stopped on its own.
//
// The detector only calls a night slept when it reaches its last minute
// untouched (docs/gated-model.md). That used to be the fade: someone awake
// heard the volume drop and reached for the phone. With no fade, the sound
// plays on until it stops, and someone lying still and awake looks the same
// as someone asleep. The stop itself is now the cue: whoever starts another
// night within a few minutes of it was awake when it ended, so the guess that
// they slept is taken back.
import type { RestNight } from "./types";
import { loadNights, saveNights } from "./ledger";

/** A start this soon after the stop means the stop was heard. */
export const RESTART_WITHIN_MS = 5 * 60_000;

/**
 * The ledger with its last night's guessed sleep taken back, or null when
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
  const {
    onsetFeedId: _f, onsetEpisodeId: _e, onsetAfterMs: _a, sleptThrough: _s, detectorAtMs: _d,
    ...rest
  } = last;
  return [
    ...nights.slice(0, -1),
    { ...rest, sleptAtMs: null, timeToSleepMs: null, detector: "none", restartedAfter: true },
  ];
}

/** At the start of a new night (not a revived one): take back last night's
 *  guess if it ended moments ago. */
export function noteNightStart(now: number = Date.now()): void {
  const next = overturnOnRestart(loadNights(), now);
  if (next) saveNights(next);
}
