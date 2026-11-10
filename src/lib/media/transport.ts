// What a media element is doing, the one rule for every audio player.

/** HTMLMediaElement.HAVE_FUTURE_DATA: playing, not just loading. */
const HAVE_FUTURE_DATA = 3;

/** An element playing through, not just asked to: not paused, and with
 *  data ahead (`paused` alone turns false the moment play() is called). */
export function isPlayingThrough(el: { paused: boolean; readyState: number }): boolean {
  return !el.paused && el.readyState >= HAVE_FUTURE_DATA;
}

/** Paused; playing through; or asked to play but not moving (loading,
 *  stalled, seeking), which is buffering. */
export function mediaTransport(el: { paused: boolean; readyState: number; seeking: boolean }): "paused" | "playing" | "buffering" {
  if (el.paused) return "paused";
  return isPlayingThrough(el) && !el.seeking ? "playing" : "buffering";
}

/**
 * Whether a request for sound re-times the watchdog. An episode that has never
 * made a sound gets its watchdog timed from this tap rather than from its load
 * or an earlier refused tap: a refusal sits the episode at paused, and a
 * working tap minutes later otherwise read as a stall the moment it began
 * buffering. Not while it is already buffering: repeated taps on a hung
 * stream would then postpone the watchdog forever. And never once it has
 * played, or a slow 2am rebuffer after a mid-night resume would condemn it.
 */
export function rearmsWatchdogOnTap(played: boolean, transport: ReturnType<typeof mediaTransport>): boolean {
  return !played && transport !== "buffering";
}
