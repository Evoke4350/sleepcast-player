// The skip-intro on one load, from the seek to the decision whether the
// episode is long enough for it.
//
// An episode barely longer than its feed's skip plays whole instead: landing
// within 30 s of the end would play a tail and move on. Whether it is too
// short needs the duration, which Chrome knows before the seek and Safari
// can report only after the seek has landed. So the question is asked twice:
// before each seek (the SeekEnforcer's skipIf, which stops a seek that would
// be wrong) and once the duration is known (decide, which undoes one that
// already happened, unless the listener has moved since).

/** Whether an episode is too short for its skip: null while the duration
 *  is unknown. A stream with no length (Infinity) is long. */
export function tooShortForSkip(skipSec: number, durationSec: number): boolean | null {
  if (Number.isNaN(durationSec) || durationSec <= 0) return null;
  return skipSec >= durationSec - 30;
}

export type SkipDecision = "wait" | "none" | "announce" | "play-whole";

export class SkipIntro {
  private landed = false;
  private moved = false;
  private decided = false;
  private owed = false;

  constructor(readonly skipSec: number) {}

  get minutes(): number {
    return Math.round(this.skipSec / 60);
  }

  /** The seek landed with playback rolling. Returns whether to say so now;
   *  otherwise it is said, or not, when decide() knows. */
  landedNow(): boolean {
    this.landed = true;
    if (this.decided) return true;
    this.owed = true;
    return false;
  }

  /** A seek after landing is the listener's: the skip is no longer ours to
   *  undo. */
  seeked(): void {
    if (this.landed) this.moved = true;
  }

  /** Called with each new reading until it returns something other than
   *  "wait". `seekPending`: the skip's own seek has not landed yet. */
  decide(durationSec: number, seekPending: boolean): SkipDecision {
    if (this.decided) return "none";
    const short = tooShortForSkip(this.skipSec, durationSec);
    if (short === null) return "wait";
    this.decided = true;
    const owed = this.owed;
    this.owed = false;
    if (!short) return owed ? "announce" : "none";
    return seekPending || (this.landed && !this.moved) ? "play-whole" : "none";
  }
}
