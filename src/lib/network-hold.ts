// Waiting out a dropped network instead of spending the lineup on it.
//
// Offline, every source fails at once. Skipping through them ends the night
// in seconds, and once something has played that end clears its snapshot, so
// a Wi-Fi blip at 2am cost the listener the whole night. The players hold
// instead (clock frozen, shown paused, nothing skipped) with a reload of the
// current episode pending. navigator.onLine is imprecise: it can read true on
// a network with no internet, where the ordinary failure handling applies.

export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** One pending resume per night. It runs by itself when the browser reports
 *  the network is back, unless the player was paused when the hold began (by
 *  the listener: no sound in a dark room they silenced) or `allow()` says
 *  no (Player's get-up prompt); then it waits for resumeNow(), a tap. The
 *  resume itself decides whether it still applies (a fade-out, a new
 *  episode). A tap during the hold must go through resumeNow too: play() on the failed source does
 *  nothing and would only thaw the clock over silence. Holding again
 *  replaces the pending resume, so it always concerns what failed last. */
export class NetworkHold {
  private pending: (() => void) | null = null;
  private off: (() => void) | null = null;
  /** The first hold's reading, kept until cancel(): through re-holds, and
   *  through a resume attempt that fails again before any sound (its own
   *  refused play() leaves the element paused, and that is not the
   *  listener's pause either). */
  private pausedAtHold: boolean | null = null;

  get holding(): boolean {
    return this.pending !== null;
  }

  /** `paused`: whether the player was paused as the hold begins. Ignored
   *  after the first hold until cancel() (see pausedAtHold). */
  hold(resume: () => void, paused: boolean, allow: () => boolean = () => true): void {
    this.disarm();
    this.pausedAtHold ??= paused;
    this.pending = resume;
    const onOnline = () => {
      if (!this.pausedAtHold && allow()) this.resumeNow();
    };
    window.addEventListener("online", onOnline);
    this.off = () => window.removeEventListener("online", onOnline);
  }

  /** Run the pending resume now. Returns whether there was one. `asked`:
   *  the listener asked for sound, which settles the reading — should this
   *  attempt fail too, the network coming back may resume by itself. */
  resumeNow(asked = false): boolean {
    const resume = this.pending;
    if (!resume) return false;
    this.disarm();
    if (asked) this.pausedAtHold = false;
    resume();
    return true;
  }

  /** Something played, a new episode started, or the night ended. */
  cancel(): void {
    this.disarm();
    this.pausedAtHold = null;
  }

  private disarm(): void {
    this.off?.();
    this.off = null;
    this.pending = null;
  }
}
