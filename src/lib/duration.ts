// Media durations: when one is known, and the one-second margin a seek keeps
// short of the end (a seek onto the very end ends the episode).

/** A media duration, when it is one: finite and positive. NaN (unknown yet),
 *  0 and Infinity (a stream) are not. */
export function knownDuration(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** A position kept within the episode: not before 0, and a second short of a
 *  known end. */
export function shortOfEnd(positionSec: number, durationSec: number | null): number {
  const capped = durationSec === null ? positionSec : Math.min(positionSec, durationSec - 1);
  return Math.max(0, capped);
}

/** Where an episode is and how long it is, with the position kept within
 *  it; null while the length is unknown. */
export function spanOf(positionSec: number, durationSec: number | null): { pos: number; dur: number } | null {
  if (durationSec === null) return null;
  return { pos: Math.min(Math.max(0, positionSec), durationSec), dur: durationSec };
}

/** Time left in a span, for the fade; null while the length is unknown. */
export function remainingOf(span: { pos: number; dur: number } | null): number | null {
  return span ? span.dur - span.pos : null;
}

/** The last known duration of one load, kept through a momentary NaN or
 *  Infinity (a reload's element knows nothing yet; some engines report
 *  Infinity for a moment). A stream that never reports a finite length
 *  never sets it. */
export class DurationLatch {
  private known: number | null = null;

  /** A new load: forget the last one's length. */
  reset(): void {
    this.known = null;
  }

  /** Take a reading of the element's duration; the latched length. */
  read(raw: number): number | null {
    const d = knownDuration(raw);
    if (d !== null) this.known = d;
    return this.known;
  }
}
