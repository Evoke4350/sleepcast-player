// Waiting out a dropped network instead of spending the lineup on it.
//
// Offline, every source fails at once. Skipping through them ends the night
// in seconds, and once something has played that end clears its snapshot, so
// a Wi-Fi blip at 2am cost the listener the whole night. The players hold
// instead (clock frozen, nothing skipped) and retry the current episode when
// the browser says the network is back. navigator.onLine is imprecise: it can
// read true on a network with no internet, where the ordinary failure
// handling still applies. It does not read false while online.

export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** One pending wait per night. Holding again replaces the wait, so the retry
 *  always concerns whatever failed last, never an episode since left. */
export class NetworkHold {
  private off: (() => void) | null = null;

  get holding(): boolean {
    return this.off !== null;
  }

  hold(resume: () => void): void {
    this.cancel();
    const onOnline = () => {
      this.off = null;
      resume();
    };
    window.addEventListener("online", onOnline, { once: true });
    this.off = () => window.removeEventListener("online", onOnline);
  }

  /** Something played, a new episode started, or the night ended. */
  cancel(): void {
    this.off?.();
    this.off = null;
  }
}
