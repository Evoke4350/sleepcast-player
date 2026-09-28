// Landing a new load at a position, and making it stay there.
//
// A single seek at loadedmetadata isn't enough: Safari quietly resets a seek
// made before playback starts, reading ~0 once "playing" fires, and a server
// without byte ranges can drop a seek altogether. So the seek is enforced
// across the loading lifecycle until playback is actually there: a
// timeupdate, after a "playing", at the target, with the element not paused.
// `paused` alone is not proof: it turns false the moment play() is called,
// while the element is still loading.
//
// Only a position the element has confirmed counts as reaching the target:
// currentTime reads the target the instant it is assigned, before the seek
// completes, or even if it is dropped. Confirmation is a "seeked" there, or
// playback there. Any reading away from the target is simply retried
// (bounded), so a seek dropped without a word is tried again.
//
// The listener stays in charge. A "seeked" away from the target while paused
// is the listener scrubbing (their seek replaced this one; Safari's reset
// comes as playback starts, never while paused), and so is any paused
// reading away from a confirmed target, or a playing reading well past it (a
// reset only ever goes back). Each stands the seek down rather than fight
// them, and without claiming it landed.

/** The parts of a media element this needs. */
export interface Seekable {
  currentTime: number;
  readonly paused: boolean;
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

export interface SeekHooks {
  /** When it lands with playback rolling (the skip-intro says so). */
  onLanded?: () => void;
}

const EVENTS = ["loadedmetadata", "canplay", "playing", "seeked", "timeupdate"] as const;
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
    readonly hooks: SeekHooks = {},
    private readonly onDone: () => void = () => {},
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
    if (e.type === "playing") this.sawPlaying = true;
    const cur = el.currentTime;
    const near = Math.abs(cur - this.at) <= SLACK_SEC;
    if (near && (e.type === "seeked" || (this.sawPlaying && !el.paused))) this.reached = true;
    if (el.paused) {
      if (near) return; // there (or on its way), waiting for playback
      if (this.reached || e.type === "seeked") {
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
    this.seek();
  };

  private seek(): void {
    try {
      this.el.currentTime = this.at;
    } catch {
      /* not seekable yet: a later event retries */
    }
  }
}
