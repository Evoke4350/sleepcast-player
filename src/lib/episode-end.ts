// What a night does when the current episode ends.
//
// Night and YouTubeNight each decided this inline, and the copies drifted as
// rules were added. One pure decision, tested, used by both. (Player.tsx
// predates it and plays an audio element only; short episodes there are
// handled up front by its skip-intro check, which plays them whole.)
import type { PlayMode } from "./engine";
import type { PlaybackWitness } from "./witness";

export type EndedDecision =
  | { action: "ignore" }
  | { action: "end-night"; reason: "ended" | "faded" }
  | { action: "replay-from-start" }
  | { action: "skip-dead" }
  | { action: "next" };

export interface EndedInput {
  /** The listener asked to stop and the courtesy fade is running. */
  stopping: boolean;
  /** The night is still running (its tick is live). */
  active: boolean;
  /** This episode has been heard at some point: per episode, not per load, so
   *  a retry that reloads it near its end doesn't forget it played. */
  playedThisEpisode: boolean;
  /** It has already been replayed from 0 after ending unplayed. */
  replayedFromStart: boolean;
  mode: PlayMode["kind"];
}

export function decideAfterEnded(i: EndedInput): EndedDecision {
  // Ending underneath the courtesy fade: starting another would resurrect a
  // night the listener just ended.
  if (i.stopping) return { action: "end-night", reason: "ended" };
  if (!i.active) return { action: "ignore" };
  if (!i.playedThisEpisode) {
    // It ended without ever being heard: most often because it was started
    // past its end (a Short, or a bonus episode, shorter than its skip-intro
    // or saved position). Play it from the top once. (One that merely starts
    // near its end is caught earlier by shouldPlayWhole.) If even that ends
    // unheard, it is broken: dead tonight.
    // Treating it as a finish instead kept no record, and a feed of such
    // episodes looped in silence all night.
    return i.replayedFromStart ? { action: "skip-dead" } : { action: "replay-from-start" };
  }
  // One-episode mode means one episode: the night ends with it.
  if (i.mode === "one-episode") return { action: "end-night", reason: "faded" };
  return { action: "next" };
}

/** Seconds from the end within which a start means "play it whole". */
export const PLAY_WHOLE_WITHIN_SEC = 30;

/**
 * Whether to restart the current load from 0 because it was started within
 * PLAY_WHOLE_WITHIN_SEC of its end (a skip-intro nearly as long as the
 * episode), as Player.tsx does for audio. Asked once the duration is known.
 *
 * It reads `heardBeforeLoad`, not the live `heard`: by the time a duration
 * arrives, this load's own first second has usually already counted as heard,
 * and the rule then never fired. A reload of an episode heard before (a
 * retry near its end, a revived night) is left alone.
 */
export function shouldPlayWhole(w: PlaybackWitness, durationSec: number): boolean {
  return (
    !w.heardBeforeLoad &&
    !w.replayed &&
    w.startSec > 0 &&
    durationSec > 0 &&
    w.startSec >= durationSec - PLAY_WHOLE_WITHIN_SEC
  );
}
