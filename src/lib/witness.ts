// Has this episode actually made a sound?
//
// A player's own "playing" is not proof. An audio element reads "playing" over
// a stream that has hung; an embed keeps reporting the PREVIOUS video's state
// and time for a while after a switch. The one reading that can't lie is the
// position moving the way playback moves. Night and YouTubeNight both decide
// "played" with this, so the rule can't drift between them.

import type { Transport } from "./media/backend";

/**
 * Whether going from `prevPos` (seen at `prevAt`) to
 * `pos` (at `now`) is playback rather than a seek or a stale reading:
 *
 *  - forward, and no faster than the wall clock (plus slack) — a seek jumps;
 *    a fixed cap would miss real playback when background ticks are throttled
 *    a minute apart;
 *  - not a jump ONTO the requested start from somewhere else — that is the
 *    start seek landing (from 0 before metadata, or from the previous video's
 *    leftover position), which with throttled ticks can fit under the cap.
 *
 * `prevAt` must be a real time: PlaybackWitness seeds it with the load
 * time, so the first look's allowance is the time since the load (a throttled
 * first look a minute later still counts), not an assumed second.
 */
export function isPlaybackStep(prevPos: number, prevAt: number, pos: number, now: number, startSec: number): boolean {
  const step = pos - prevPos;
  if (!(step > 0)) return false;
  if (!(prevAt > 0)) return false;
  const wallSec = (now - prevAt) / 1000;
  if (step > wallSec + 2) return false;
  const landsOnStart = startSec > 1 && Math.abs(pos - startSec) < 1.5 && Math.abs(prevPos - startSec) >= 1.5;
  return !landsOnStart;
}

/**
 * The "has this episode played" state, kept with its rule. Reset on every
 * load (a new episode, or a retry reloading one), fed each reading.
 */
export class PlaybackWitness {
  private pos = 0;
  private at = 0;
  private start = 0;
  private seen = false;
  // Per EPISODE, kept across reloads of it (a retry, a replay): whether it has
  // been heard at all, and whether it was replayed from 0 after ending unheard.
  // See decideAfterEnded.
  private heardEp = false;
  private replayedEp = false;
  // Whether it had been heard when the current load began. Rules that must
  // decide before this load's own first second counts (see shouldPlayWhole)
  // read this rather than the live `heard`.
  private heardAtLoad = false;

  /** A new episode, loaded to start at `startSec`. `heardBefore`: it was
   *  already being listened to (a revived night, a saved position), so an
   *  early end is a finish, not a failure. */
  newEpisode(startSec: number, now: number, heardBefore = false): void {
    this.heardEp = heardBefore;
    this.replayedEp = false;
    this.reset(startSec, now);
  }

  /** A reload of the same episode (a retry, a replay) at `startSec`. Only
   *  the per-load state starts over. */
  reset(startSec: number, now: number): void {
    this.pos = startSec;
    this.at = now;
    this.start = startSec;
    this.seen = false;
    this.heardAtLoad = this.heardEp;
  }

  /** Feed a reading. Only counts while the player says it is playing, so a
   *  paused or unstarted reading can never open the gate. Returns whether
   *  playback has been witnessed since the last (re)load. */
  observe(pos: number, now: number, playing: boolean): boolean {
    if (!this.seen && playing && isPlaybackStep(this.pos, this.at, pos, now, this.start)) this.markPlayed();
    this.pos = pos;
    this.at = now;
    return this.seen;
  }

  /** The player's own PLAYING event is proof enough. */
  markPlayed(): void {
    this.seen = true;
    this.heardEp = true;
  }

  /** It is about to be replayed from 0 after ending unheard. */
  markReplayed(): void {
    this.replayedEp = true;
  }

  /** Witnessed playing since the last (re)load: the snapshot gate. */
  get played(): boolean {
    return this.seen;
  }

  /** Heard at any point in this episode (across reloads). */
  get heard(): boolean {
    return this.heardEp;
  }

  get replayed(): boolean {
    return this.replayedEp;
  }

  /** Heard before the current load began. */
  get heardBeforeLoad(): boolean {
    return this.heardAtLoad;
  }

  /** Where to reload this episode: where it was, if this load ever played,
   *  else where it was meant to start (a revived position, the skip-intro).
   *  Reloading at 0 restarted a long episode mid-night, and a position read
   *  before it played may not be its own. */
  resumeAt(currentTime: number): number {
    return this.seen ? Math.max(this.start, currentTime) : this.start;
  }

  /** Where the current load was asked to start. */
  get startSec(): number {
    return this.start;
  }
}

/**
 * Whether a request for sound re-times the watchdog. An episode that has never
 * made a sound gets its watchdog timed from this tap rather than from its load
 * or an earlier refused tap: a refusal sits the episode at unstarted/paused
 * (exempt, or stood down), and a working tap minutes later otherwise read as a
 * stall the moment it began buffering. Not while it is already buffering:
 * repeated taps on a hung stream would then postpone the watchdog forever. And
 * never once it has played, or a slow 2am rebuffer after a mid-night resume
 * would condemn it.
 */
export function rearmsWatchdogOnTap(played: boolean, transport: Transport): boolean {
  return !played && transport !== "buffering";
}
