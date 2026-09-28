// The OS lock screen / media widget (the Media Session API), shared so the
// three players leave it the same way.

/** Clear everything a player put there: title and artwork, play state and
 *  position. When the night ends or the player goes away, nothing is left
 *  behind to show or to tap. */
export function clearLockScreen(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = null;
  navigator.mediaSession.playbackState = "none";
  try {
    navigator.mediaSession.setPositionState?.();
  } catch {
    /* nothing to clear */
  }
}
