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
// currentTime reads exactly the target the instant it is assigned, before
// the seek completes, or even if it is dropped. Confirmation is a "seeked"
// there, or playback reading anything but that echo. Any reading away from
// the target is simply retried (bounded), so a seek dropped without a word
// is tried again.
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
  /** HTMLMediaElement.readyState: 0 until the element knows its media. */
  readonly readyState: number;
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

export interface SeekHooks {
  /** When it lands with playback rolling (the skip-intro says so). */
  onLanded?: () => void;
}

const EVENTS = ["loadedmetadata", "canplay", "playing", "seeked", "timeupdate"] as const;
const SLACK_SEC = 2;
/** HTMLMediaElement.HAVE_METADATA, without needing the DOM. */
const HAVE_METADATA = 1;
/** An unconfirmed reading this close to the assigned value is its echo
 *  (engines may read it back through a time-base conversion). */
const ECHO_SEC = 1e-3;
const MAX_ATTEMPTS = 12;

export class SeekEnforcer {
  private attempts = 0;
  private sawPlaying = false;
  private reached = false;
  /** An assignment not yet confirmed by "seeked". */
  private unconfirmed = false;
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
    if (e.type === "seeked") this.unconfirmed = false;
    const cur = el.currentTime;
    const near = Math.abs(cur - this.at) <= SLACK_SEC;
    // The assignment's own echo, not a position the element has reached.
    const echo = this.unconfirmed && Math.abs(cur - this.at) < ECHO_SEC;
    const playingHere = near && !echo && this.sawPlaying && !el.paused && e.type === "timeupdate";
    if (near && (e.type === "seeked" || playingHere)) this.reached = true;
    if (el.paused) {
      if (near) return; // there (or on its way), waiting for playback
      if (this.reached || e.type === "seeked") {
        this.finish(); // the listener moved it
        return;
      }
    } else {
      if (near) {
        if (playingHere) {
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
    // Not before metadata: a seek then becomes the start position, applied
    // unasked once the media is known.
    if (el.readyState < HAVE_METADATA) return;
    if (this.attempts++ >= MAX_ATTEMPTS) {
      this.finish(); // stop fighting a stubborn stream
      return;
    }
    this.seek();
  };

  private seek(): void {
    try {
      this.el.currentTime = this.at;
      this.unconfirmed = true;
    } catch {
      /* not seekable yet: a later event retries */
    }
  }
}
