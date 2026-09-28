// Landing a new load at a position, and making it stay there.
//
// A single seek at loadedmetadata isn't enough: Safari quietly resets a seek
// made before playback starts, reading ~0 once "playing" fires, and duration
// can still be NaN at loadedmetadata. So the seek is enforced across the
// loading lifecycle until playback is actually there: a timeupdate, after a
// "playing", at the target, with the element not paused. `paused` alone is
// not proof: it turns false the moment play() is called, while the element
// is still loading.
//
// The listener stays in charge. Once the target has been reached, a later
// paused reading away from it is the listener scrubbing (Safari's reset comes
// as playback starts, never while paused), and so is a playing reading well
// past it (a reset only ever goes back). Either way the seek stands down
// rather than fight them, and without claiming it landed.

/** The parts of a media element this needs. */
export interface Seekable {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

/** A seek's extras: the skip-intro plays a short episode whole, and says so
 *  when it lands. */
export interface SeekHooks {
  playWholeIf?: (durationSec: number) => boolean;
  onLanded?: () => void;
}

const EVENTS = ["loadedmetadata", "canplay", "playing", "timeupdate"] as const;
const SLACK_SEC = 2;
const MAX_ATTEMPTS = 12;

export class SeekEnforcer {
  private attempts = 0;
  private sawPlaying = false;
  private reached = false;
  private done = false;

  /** `onDone` runs once, when it lands or stands down for any reason
   *  (including cancel()). */
  constructor(
    private readonly el: Seekable,
    readonly at: number,
    readonly hooks: SeekHooks,
    private readonly onDone: () => void,
  ) {
    for (const ev of EVENTS) el.addEventListener(ev, this.handle);
  }

  cancel(): void {
    this.finish();
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    for (const ev of EVENTS) this.el.removeEventListener(ev, this.handle);
    this.onDone();
  }

  private handle = (e: Event): void => {
    if (this.done) return;
    const el = this.el;
    const dur = el.duration;
    if (this.hooks.playWholeIf && Number.isFinite(dur) && dur > 0 && this.hooks.playWholeIf(dur)) {
      // Undo a seek already made (before metadata it becomes the start
      // position, applied once the duration is known): whole means from 0.
      if (el.currentTime > 0) {
        try {
          el.currentTime = 0;
        } catch {
          /* not seekable: it plays from wherever it is */
        }
      }
      this.finish();
      return;
    }
    if (e.type === "playing") this.sawPlaying = true;
    const cur = el.currentTime;
    const near = Math.abs(cur - this.at) <= SLACK_SEC;
    if (near) this.reached = true;
    if (el.paused) {
      if (near) return; // there, waiting for playback
      if (this.reached) {
        this.finish(); // the listener moved it
        return;
      }
    } else {
      if (near) {
        if (this.sawPlaying && e.type === "timeupdate") {
          this.hooks.onLanded?.();
          this.finish(); // landed, and playback is rolling
        }
        return;
      }
      if (this.reached && cur > this.at + SLACK_SEC) {
        this.finish(); // the listener skipped ahead
        return;
      }
    }
    if (this.attempts++ >= MAX_ATTEMPTS) {
      this.finish(); // stop fighting a stubborn stream
      return;
    }
    try {
      el.currentTime = this.at;
    } catch {
      /* not seekable yet: a later event retries */
    }
  };
}
