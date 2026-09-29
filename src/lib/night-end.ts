// Everything a night writes when it ends, in one place.
//
// Player, Night and YouTubeNight each carried their own copy of this, and the
// copies drifted: a fix to one (a night that never played records nothing)
// reached two of them and missed the third. The media teardown genuinely
// differs per player; the bookkeeping does not.
import type { Episode, PlayMode } from "./engine";
import { clearLastEpisode, clearLive, loadLive, recordSessionEnd, saveLastEpisode, saveLastNight, type LastNight } from "./store";
import { appendNight } from "./rest/ledger";
import type { RestSession } from "./rest/session";
import type { RestNight } from "./rest/types";

export interface NightEnd {
  reason: RestNight["endedVia"];
  /** Whether anything actually played this night, in this page. */
  played: boolean;
  /** A revived night: when the snapshot it was revived from was saved. What
   *  played before the reload counts, while that snapshot is still the
   *  stored one (another tab hasn't reconciled or replaced it). */
  revivedFrom?: number;
  /** The app, not the listener, is ending a night that never played (nothing
   *  playable, an error screen). Its live snapshot is kept, so a revived night
   *  that failed offline can be revived again. */
  gaveUp?: boolean;
  timerMinutes: number;
  modeKind: PlayMode["kind"];
  lastNight: Omit<LastNight, "endedVia" | "endedAt">;
  /** The last episode that actually made a sound tonight, saved as "the
   *  exact one again". Not simply the current one: a night that ended on a run
   *  of failures, or on a timer that ran out just after a switch, would offer
   *  tomorrow an episode that never played. A saved position does not count as
   *  heard here; only playback tonight does. */
  lastHeard: Episode | null;
  rest: RestSession | null;
  now: number;
}

export function recordNightEnd(e: NightEnd): void {
  let lastHeard = e.lastHeard;
  if (!e.played) {
    const stored = e.revivedFrom !== undefined ? loadLive() : null;
    const revivedIntact = stored !== null && stored.savedAt === e.revivedFrom;
    // A revived night that never sounded here but played before the
    // reload, ended any way but the app giving up, is recorded like any
    // played night (its RestSession carries the start and touches). Else a
    // night that never played records nothing: no re-arm stamp, no empty
    // last night, no RestNight for calibration to learn from. Its snapshot
    // is kept when the app gives up, or when it is no longer this night's.
    if (!revivedIntact || e.gaveUp) {
      if (!e.gaveUp && e.revivedFrom === undefined) clearLive();
      return;
    }
    // Its last sound was before the reload: the snapshot's own record of
    // it, else (an older snapshot) its episode if heard there (past its
    // start), else none, so an earlier night's pick isn't left standing.
    lastHeard = stored.lastHeard ?? (stored.position > 0 ? stored.current : null);
    if (!lastHeard) clearLastEpisode();
  }
  clearLive();
  // "faded" is the natural end — stamp it so setup can offer a smaller re-arm.
  if (e.reason === "faded") recordSessionEnd(e.timerMinutes, e.modeKind);
  saveLastNight({ ...e.lastNight, endedVia: e.reason, endedAt: e.now });
  // For "the exact one again" (a blocked one is hidden when read back).
  if (lastHeard) saveLastEpisode(lastHeard);
  if (e.rest) appendNight(e.rest.finish(e.reason, e.now));
}
