// The two decisions a YouTube night makes that are not about pixels.
//
// Both exist because the failure they guard against is the same one, and it is
// this app's worst: playing nothing while the countdown runs down. The timer
// completes, the fade runs, the session is recorded as a night slept through,
// and the listener got silence. A video that cannot play must move the night
// on; a night with nothing left to play must end rather than spin.

import type { Episode } from "./engine";
import { pickNextEpisode, type Play } from "./plays";
import { classifyYouTubeError } from "./youtube-errors";

/** Retries allowed for one episode before it is skipped. */
export const MAX_RETRIES = 1;

/** YT.Player's own state codes, from getPlayerState(). */
export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

/** What the transport should show. Four outcomes, not a boolean: "not
 *  playing" and "paused" are different things, and conflating them is what
 *  made a video that had never started render a Pause button over silence. */
export type Transport = "playing" | "paused" | "buffering" | "awaiting-start";

export function transportFor(state: number): Transport {
  switch (state) {
    case YT_STATE.PLAYING:
      return "playing";
    case YT_STATE.PAUSED:
      return "paused";
    // Loaded and waiting to be told to go. On a phone this is the normal
    // outcome of an autoplay attempt, not a fault.
    case YT_STATE.UNSTARTED:
    case YT_STATE.CUED:
      return "awaiting-start";
    default:
      // Buffering, ended, and anything undocumented. Deliberately not
      // "playing": a wrong "playing" is a Pause button over silence, while a
      // wrong "buffering" is a spinner that resolves itself in a moment.
      return "buffering";
  }
}

export interface GiveUpArgs {
  state: number;
  /** Whether anything at all has played this session. */
  hasEverPlayed: boolean;
  elapsedMs: number;
  limitMs: number;
}

/**
 * Whether a video that has not started is a dead video.
 *
 * The distinction that matters is autoplay. Before anything has played,
 * "unstarted" almost always means the browser is refusing to begin playback
 * without a tap — every video in the lineup would refuse identically, so
 * skipping burns through the whole spread in a couple of minutes and ends a
 * night having played nothing. That case needs a tap, not a funeral.
 *
 * Once something HAS played, playback is clearly permitted, so a video still
 * sitting at unstarted is this video's problem and the night should move on.
 */
export function shouldGiveUp({ state, hasEverPlayed, elapsedMs, limitMs }: GiveUpArgs): boolean {
  if (elapsedMs <= limitMs) return false;
  if (state === YT_STATE.PLAYING || state === YT_STATE.PAUSED) return false;
  if (!hasEverPlayed && (state === YT_STATE.UNSTARTED || state === YT_STATE.CUED)) return false;
  return true;
}

/**
 * The next video to try, or null when there is nothing left.
 *
 * `dead` holds both kinds of unplayable at once — blocked across nights
 * (embedding disabled, video removed) and failed just tonight — because the
 * choice is identical either way: do not offer it.
 */
export function nextPlayable(
  pool: readonly Episode[],
  dead: ReadonlySet<string>,
  currentId: string | null,
  plays: Play[],
  rand: () => number = Math.random,
): Episode | null {
  const alive = pool.filter((e) => !dead.has(e.id));
  if (!alive.length) return null;
  // Prefer anything other than what is playing, but fall back to it: one
  // survivor repeating beats a night that stops on a technicality.
  const others = currentId ? alive.filter((e) => e.id !== currentId) : alive;
  return pickNextEpisode(others.length ? others : alive, plays, rand);
}

/**
 * True when every episode is a video, so the night belongs to the embed rather
 * than to the audio element.
 *
 * Empty is deliberately false: `[].every()` is true, and the one-line version
 * routes an empty lineup to the video player, which renders a black rectangle
 * and no explanation.
 */
export function isYouTubeLineup(pool: readonly Episode[]): boolean {
  return pool.length > 0 && pool.every((e) => !!e.youtubeId);
}

/**
 * True when a lineup holds both kinds. Neither player can carry it — the embed
 * cannot play an enclosure and the audio element cannot play a videoId — so
 * whichever one ran would silently drop half of it. The caller refuses the
 * night instead, which is a sentence the listener can act on.
 */
export function isMixedLineup(pool: readonly Episode[]): boolean {
  return pool.some((e) => !!e.youtubeId) && pool.some((e) => !e.youtubeId);
}

export interface ErrorDecision {
  action: "skip" | "retry";
  /** True when the video should be remembered as dead beyond tonight. */
  permanent: boolean;
}

/**
 * What to do about a video that just errored, given how many times this one has
 * already been retried. The retry budget is per-episode: a code that always
 * says "retry" would otherwise be an infinite loop.
 */
export function decideAfterError(code: number, retriesUsed: number): ErrorDecision {
  const verdict = classifyYouTubeError(code);
  if (verdict.action === "retry" && retriesUsed < MAX_RETRIES) {
    return { action: "retry", permanent: false };
  }
  return { action: "skip", permanent: verdict.permanent };
}
