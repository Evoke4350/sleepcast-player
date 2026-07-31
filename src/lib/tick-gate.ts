// When may the countdown tick run?
//
// The tick applies the volume fade and ends the session, and it used to be
// driven by `setInterval` alone. Browsers throttle background intervals to
// roughly once a minute, and the phone is locked for practically the whole of
// a sleep timer — so a 60-second fade got one or two samples and the stop
// landed late. The fade is this app's entire claim over a hard cut, and it was
// degrading toward a hard cut in exactly the case it exists for.
//
// So the tick is now driven by BOTH the interval (foreground, steady) and the
// media element's "timeupdate" (~4Hz, and it keeps firing while backgrounded —
// the same reason the sleep detector is already fed from it). Two sources
// feeding one function need a gate: one to stop them doing the work twice, and
// one to stop the media source doing it when no timer is live.

export interface TickGate {
  /** When the tick last actually ran. 0 if never. */
  lastRunAt: number;
  now: number;
  /** Minimum gap between runs. Set slightly under 1s so a jittery 1s interval
   *  isn't swallowed by the gate it shares with timeupdate. */
  minIntervalMs: number;
  /** False when no countdown is live. "timeupdate" keeps firing after a
   *  session ends — the audio element is still attached — and an ungated tick
   *  then reads a null end time, computes a hugely negative remaining, and
   *  ends a session that has already ended. */
  sessionActive: boolean;
}

export function shouldTick(g: TickGate): boolean {
  if (!g.sessionActive) return false;
  return g.now - g.lastRunAt >= g.minIntervalMs;
}
