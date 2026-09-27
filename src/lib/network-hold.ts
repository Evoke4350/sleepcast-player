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
 *  the network is back and `auto()` allows it (not over a listener's own
 *  pause, say); otherwise it waits for resumeNow(), a tap. A tap during the
 *  hold must go through resumeNow too: play() on the failed source does
 *  nothing and would only thaw the clock over silence. Holding again
 *  replaces the pending resume, so it always concerns what failed last. */
export class NetworkHold {
  private pending: (() => void) | null = null;
  private off: (() => void) | null = null;

  get holding(): boolean {
    return this.pending !== null;
  }

  hold(resume: () => void, auto: () => boolean = () => true): void {
    this.cancel();
    this.pending = resume;
    const onOnline = () => {
      if (auto()) this.resumeNow();
    };
    window.addEventListener("online", onOnline);
    this.off = () => window.removeEventListener("online", onOnline);
  }

  /** Run the pending resume now. Returns whether there was one. */
  resumeNow(): boolean {
    const resume = this.pending;
    if (!resume) return false;
    this.cancel();
    resume();
    return true;
  }

  /** Something played, a new episode started, or the night ended. */
  cancel(): void {
    this.off?.();
    this.off = null;
    this.pending = null;
  }
}
