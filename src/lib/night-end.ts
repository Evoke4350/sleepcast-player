// Everything a night writes when it ends, in one place.
//
// Player, Night and YouTubeNight each carried their own copy of this, and the
// copies drifted: a fix to one (a night that never played records nothing)
// reached two of them and missed the third. The media teardown genuinely
// differs per player; the bookkeeping does not.
import type { Episode, PlayMode } from "./engine";
import { clearLive, recordSessionEnd, saveLastEpisode, saveLastNight, type LastNight } from "./store";
import { appendNight } from "./rest/ledger";
import type { RestSession } from "./rest/session";
import type { RestNight } from "./rest/types";

export interface NightEnd {
  reason: RestNight["endedVia"];
  /** Whether anything actually played this night. */
  played: boolean;
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
  if (e.played || !e.gaveUp) clearLive();
  // A night that never played records nothing: no re-arm stamp, no empty last
  // night, no RestNight for calibration to learn from.
  if (!e.played) return;
  // "faded" is the natural end — stamp it so setup can offer a smaller re-arm.
  if (e.reason === "faded") recordSessionEnd(e.timerMinutes, e.modeKind);
  saveLastNight({ ...e.lastNight, endedVia: e.reason, endedAt: e.now });
  // For "the exact one again" (a blocked one is hidden when read back).
  // Always set here: whatever made `played` true also set it.
  if (e.lastHeard) saveLastEpisode(e.lastHeard);
  if (e.rest) appendNight(e.rest.finish(e.reason, e.now));
}
