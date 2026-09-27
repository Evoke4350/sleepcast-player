// What a night does when the current episode ends.
//
// Night and YouTubeNight each decided this inline, and the copies drifted as
// rules were added. One pure decision, tested, used by both. (Player.tsx
// predates it and plays an audio element only; short episodes there are
// handled up front by its skip-intro check, which plays them whole.)
import type { PlayMode } from "./engine";

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
    // near its end is caught earlier, once its length is known, and played
    // whole the way Player.tsx does.) If even that ends unheard, it is broken: dead tonight.
    // Treating it as a finish instead kept no record, and a feed of such
    // episodes looped in silence all night.
    return i.replayedFromStart ? { action: "skip-dead" } : { action: "replay-from-start" };
  }
  // One-episode mode means one episode: the night ends with it.
  if (i.mode === "one-episode") return { action: "end-night", reason: "faded" };
  return { action: "next" };
}
