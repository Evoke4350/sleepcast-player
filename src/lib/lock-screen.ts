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

/** What's playing: the episode and its feed (or "sleepcast"), with the
 *  feed's artwork when there is one. */
export function publishLockScreenMetadata(title: string, feedTitle: string | undefined, artwork: string | undefined): void {
  const ms = mediaSession();
  if (!ms) return;
  ms.metadata = new MediaMetadata({
    title,
    artist: feedTitle ?? "sleepcast",
    album: "sleepcast",
    ...(artwork ? { artwork: [{ src: artwork, sizes: "512x512" }] } : {}),
  });
}

/** Remove the action handlers a player registered, the same list it set up. */
export function clearActionHandlers(actions: readonly MediaSessionAction[]): void {
  const ms = mediaSession();
  if (!ms) return;
  for (const action of actions) {
    try {
      ms.setActionHandler(action, null);
    } catch {
      /* an action this browser doesn't know */
    }
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
