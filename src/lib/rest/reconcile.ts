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
import type { RestNight } from "./types";
import { validLean } from "./sleepscore";

/** A snapshot younger than this may belong to a night still playing in
 *  another tab (snapshots are rewritten every SNAPSHOT_EVERY_TICKS ticks,
 *  ~10 s in the foreground). Leave it alone: that night will record itself
 *  when it ends. */
export const SNAPSHOT_FRESH_MS = 30_000;

/** Whether the night was stored: if not (storage full), the snapshot is
 *  kept, so the night isn't lost from both the ledger and the resume offer. */
export function reconcileLive(l: LiveSession, now: number): boolean {
  const k = killedNight(l, now);
  // Only once the night is in the ledger: kept back, its last night mustn't
  // say it faded (a re-anchor would continue a night recorded nowhere).
  if (!appendNight(k.night, now)) return false;
  k.commit();
  return true;
}

/** A killed tab's night as the ledger records it, and `commit`, to run once
 *  it is stored: the last-night record (for a re-anchor, which continues a
 *  "faded" one; `lastEndedVia`) and clearing the snapshot. */
export function killedNight(
  l: LiveSession,
  now: number,
  lastEndedVia: "faded" | "ended" = "faded",
): { night: RestNight; commit: () => void } {
  const elapsedMs = Math.max(0, l.totalSeconds * 1000 - Math.max(0, l.remainingMs));
  const timerMinutes = nightTimerMinutes(l);
  // As if it faded on schedule. A timerless night (one-episode, all-night)
  // snapshots no remaining time, so it ends where it was last seen alive.
  const endedAt = Math.min(now, l.savedAt + Math.max(0, l.remainingMs));
  // Never after its end: a clock stepped back since the snapshot leaves
  // savedAt, and the start, in the future.
  const startedAt = Math.min(l.nightStartedAt ?? l.savedAt - elapsedMs, endedAt);
  const playedIds = withCurrentPlayed(l);

  const night: RestNight = {
    startedAt,
    // Last seen alive, not the scheduled fade above: the tab (and its
    // audio, and its touch count) died by its last snapshot, so nothing
    // after that was observed.
    endedAt: Math.max(startedAt, Math.min(now, l.savedAt)),
    timerMinutes,
    endedVia: "faded",
    sleptAtMs: null,
    timeToSleepMs: null,
    interactions: l.interactions ?? 0, // touches before the tab died
    detector: "none",
    ...(validLean(l.shuffleLean) ? { shuffle: "leaned" as const } : {}),
  };
  const commit = () => {
    saveLastNight({
      pool: l.pool,
      playedIds,
      feedTitles: l.feedTitles,
      artworkByFeedId: l.artworkByFeedId,
      skipIntroByFeedId: l.skipIntroByFeedId,
      endedVia: lastEndedVia,
      endedAt,
      wasVaried: l.wasVaried ?? false, // steers which lineup a re-anchor continues
    });
    clearLive();
  };
  return { night, commit };
}

/** On page load: return the snapshot if it should be offered for revival;
 *  otherwise reconcile it (unless it may still be live in another tab) and
 *  return null. */
export function settleLive(l: LiveSession | null, now: number): LiveSession | null {
  if (!l) return null;
  if (isRevivable(l, now)) return l;
  if (!isFresh(l, now)) reconcileLive(l, now);
  return null;
}

/** For a watch import, which means the night is over (the Shortcut runs in
 *  the morning): a killed tab's snapshot as a night to record, even one
 *  that could still be revived (a timerless night's, under
 *  LIVE_MAX_AGE_MS), as that is the night the import is for. None when one
 *  may still be live in another tab. The import records it with its own
 *  write, and commits only once that took. */
export function killedNightToRecord(now: number): { night: RestNight; commit: () => void } | null {
  const l = loadLive();
  if (!l || isFresh(l, now)) return null;
  // Its last night "ended", not "faded": the listener is up and closed it
  // (the import), so no re-anchor offers to continue it.
  return killedNight(l, now, "ended");
}

/** Whether a snapshot may still be live in another tab. Saved in the future
 *  means the clock stepped back since: not another tab's live night (it
 *  shares this clock), so it is reconciled now rather than offered hours
 *  late. */
function isFresh(l: LiveSession, now: number): boolean {
  const age = now - l.savedAt;
  return age >= 0 && age < SNAPSHOT_FRESH_MS;
}

/** What tapping "keep going" on a resume card (showing `card`) should do,
 *  read from storage once, now (another tab may have moved on): revive the
 *  stored snapshot when it is still revivable and the card's night (its
 *  own, or a newer snapshot of it); otherwise show what settleLive makes of
 *  storage now (another card, or none), as the card is stale. Two tabs
 *  playing one night at once is out of scope (spec §6). */
export function resumeTarget(card: LiveSession, now: number): { revive: LiveSession } | { card: LiveSession | null } {
  const stored = loadLive();
  // The same night: the same snapshot, or one with the card's start, or
  // (both written before the night's start was known) the card's lineup.
  // (As a set: a snapshot puts its current episode first, so the order
  // moves as the night plays.)
  const lineup = (l: LiveSession) => l.pool.map((e) => e.id).sort().join("\n");
  const sameNight = (l: LiveSession) =>
    l.savedAt === card.savedAt ||
    (l.nightStartedAt !== undefined
      ? l.nightStartedAt === card.nightStartedAt
      : card.nightStartedAt === undefined && lineup(l) === lineup(card));
  if (stored && sameNight(stored) && isRevivable(stored, now)) return { revive: stored };
  return { card: settleLive(stored, now) };
}
