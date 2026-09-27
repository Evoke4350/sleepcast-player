// A night whose tab was killed never reaches endSession, so it never wrote the
// rest ledger or the last-night record. The live snapshot (store.saveLive,
// written every ~10 s while a night plays) is all that survives it. When that
// snapshot can no longer be revived, turn it into the records the night would
// have written had it faded on schedule, instead of silently dropping it.
//
// The detector never saw the night finish, so there is no onset to report:
// the ledger gets a detector:"none" night, which keeps the night count honest
// without claiming a time-to-sleep.
import { clearLive, isRevivable, saveLastNight, type LiveSession } from "../store";
import { appendNight } from "./ledger";

/** A snapshot younger than this may belong to a night still playing in
 *  another tab (snapshots are rewritten every ~10 s). Leave it alone: that
 *  night will record itself when it ends. */
export const SNAPSHOT_FRESH_MS = 30_000;

export function reconcileLive(l: LiveSession, now: number): void {
  const elapsedMs = Math.max(0, l.totalSeconds * 1000 - Math.max(0, l.remainingMs));
  const startedAt = l.nightStartedAt ?? l.savedAt - elapsedMs;
  const timerMinutes = l.timerMinutes ?? Math.max(1, Math.round(l.totalSeconds / 60));
  // As if it faded on schedule. A timerless night (one-episode, all-night)
  // snapshots no remaining time, so it ends where it was last seen alive.
  const endedAt = Math.min(now, l.savedAt + Math.max(0, l.remainingMs));
  const playedIds = l.playedIds.includes(l.current.id) ? l.playedIds : [...l.playedIds, l.current.id];

  saveLastNight({
    pool: l.pool,
    playedIds,
    feedTitles: l.feedTitles,
    artworkByFeedId: l.artworkByFeedId,
    skipIntroByFeedId: l.skipIntroByFeedId,
    endedVia: "faded",
    endedAt,
    wasVaried: false, // not snapshotted; only steers which lineup a re-anchor continues
  });
  appendNight({
    startedAt,
    timerMinutes,
    endedVia: "faded",
    sleptAtMs: null,
    timeToSleepMs: null,
    interactions: 0,
    detector: "none",
  });
  clearLive();
}

/** On page load: return the snapshot if it should be offered for revival;
 *  otherwise reconcile it (unless it may still be live in another tab) and
 *  return null. */
export function settleLive(l: LiveSession | null, now: number): LiveSession | null {
  if (!l) return null;
  if (isRevivable(l, now)) return l;
  if (now - l.savedAt < SNAPSHOT_FRESH_MS) return null;
  reconcileLive(l, now);
  return null;
}
