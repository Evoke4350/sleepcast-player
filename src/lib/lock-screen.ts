// The OS lock screen / media widget (the Media Session API), shared so the
// three players leave it the same way.

/** The Media Session, where the browser has one. */
export function mediaSession(): MediaSession | null {
  return typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : null;
}

/** Publish the play state and, when the length is known, the position (the
 *  platform extrapolates from it at `rate` while the state is "playing").
 *  Without a span the position is cleared. */
export function publishLockScreen(
  state: "playing" | "paused",
  span: { pos: number; dur: number } | null,
  rate: number,
): void {
  const ms = mediaSession();
  if (!ms) return;
  ms.playbackState = state;
  try {
    if (span) ms.setPositionState?.({ duration: span.dur, position: span.pos, playbackRate: rate });
    else ms.setPositionState?.();
  } catch {
    /* a platform that rejects it keeps its own */
  }
}

/** Clear everything a player put there: title and artwork, play state and
 *  position. When the night ends or the player goes away, nothing is left
 *  behind to show or to tap. */
export function clearLockScreen(): void {
  const ms = mediaSession();
  if (!ms) return;
  ms.metadata = null;
  ms.playbackState = "none";
  try {
    ms.setPositionState?.();
  } catch {
    /* nothing to clear */
  }
}
