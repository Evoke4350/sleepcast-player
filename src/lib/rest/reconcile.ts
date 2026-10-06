// A night whose tab was killed never reaches endSession, so it never wrote the
// rest ledger or the last-night record. The live snapshot (store.saveLive,
// written every ~10 s while a night plays) is all that survives it. When that
// snapshot can no longer be revived, turn it into the records the night would
// have written had it faded on schedule, instead of silently dropping it.
//
// The detector never saw the night finish, so there is no onset to report:
// the ledger gets a detector:"none" night, which keeps the night count honest
// without claiming a time-to-sleep.
import { clearLive, isRevivable, loadLive, nightTimerMinutes, saveLastNight, withCurrentPlayed, type LiveSession } from "../store";
import { appendNight } from "./ledger";
import { validLean } from "./sleepscore";

/** A snapshot younger than this may belong to a night still playing in
 *  another tab (snapshots are rewritten every SNAPSHOT_EVERY_TICKS ticks,
 *  ~10 s in the foreground). Leave it alone: that night will record itself
 *  when it ends. */
export const SNAPSHOT_FRESH_MS = 30_000;

export function reconcileLive(l: LiveSession, now: number): void {
  const elapsedMs = Math.max(0, l.totalSeconds * 1000 - Math.max(0, l.remainingMs));
  const timerMinutes = nightTimerMinutes(l);
  // As if it faded on schedule. A timerless night (one-episode, all-night)
  // snapshots no remaining time, so it ends where it was last seen alive.
  const endedAt = Math.min(now, l.savedAt + Math.max(0, l.remainingMs));
  // Never after its end: a clock stepped back since the snapshot leaves
  // savedAt, and the start, in the future.
  const startedAt = Math.min(l.nightStartedAt ?? l.savedAt - elapsedMs, endedAt);
  const playedIds = withCurrentPlayed(l);

  saveLastNight({
    pool: l.pool,
    playedIds,
    feedTitles: l.feedTitles,
    artworkByFeedId: l.artworkByFeedId,
    skipIntroByFeedId: l.skipIntroByFeedId,
    endedVia: "faded",
    endedAt,
    wasVaried: l.wasVaried ?? false, // steers which lineup a re-anchor continues
  });
  appendNight({
    startedAt,
    // Last seen alive, not the scheduled fade above: the tab (and its
    // audio, and its touch count) died by its last snapshot, so nothing
    // after that was observed.
    endedAt: Math.max(startedAt, Math.min(endedAt, l.savedAt)),
    timerMinutes,
    endedVia: "faded",
    sleptAtMs: null,
    timeToSleepMs: null,
    interactions: l.interactions ?? 0, // touches before the tab died
    detector: "none",
    ...(validLean(l.shuffleLean) ? { shuffle: "leaned" as const } : {}),
  });
  clearLive();
}

/** On page load: return the snapshot if it should be offered for revival;
 *  otherwise reconcile it (unless it may still be live in another tab) and
 *  return null. */
export function settleLive(l: LiveSession | null, now: number): LiveSession | null {
  if (!l) return null;
  if (isRevivable(l, now)) return l;
  reconcileUnlessFresh(l, now);
  return null;
}

/** Records a snapshot's night unless it may still be live in another tab.
 *  Saved in the future means the clock stepped back since: not another
 *  tab's live night (it shares this clock), so reconcile it now rather than
 *  leave it to be offered hours late. */
function reconcileUnlessFresh(l: LiveSession, now: number): void {
  const age = now - l.savedAt;
  if (age >= 0 && age < SNAPSHOT_FRESH_MS) return;
  reconcileLive(l, now);
}

/** A watch import means the night is over (the Shortcut runs in the
 *  morning): a killed tab's snapshot is recorded now, even one that could
 *  still be revived (a timerless night's, under LIVE_MAX_AGE_MS), as that
 *  is the night the import is for. Not one that may still be live in
 *  another tab. */
export function endKilledNight(now: number): void {
  const l = loadLive();
  if (l) reconcileUnlessFresh(l, now);
}
