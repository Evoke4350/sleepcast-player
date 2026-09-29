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
