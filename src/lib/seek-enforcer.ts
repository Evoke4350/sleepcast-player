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
// there that doesn't read exactly the value just assigned (an earlier
// seek's "seeked" can arrive with the echo), or playback reading anything
// but that echo. Any reading away from
// the target is simply retried (bounded), so a seek dropped without a word
// is tried again.
//
// It doesn't fight what isn't its own. A "seeked" away from the target while
// paused, with none of its seeks outstanding, was someone else's seek; so is
// a paused reading away from a confirmed target (Safari's reset comes as
// playback starts, never while paused), or a playing reading well past it (a
// reset only ever goes back). Each stands the seek down, without claiming it
// landed, and without vouching for where the element now is. A caller that
// knows the listener wants another position retargets this one (it keeps
// count of its own seeks still in flight, which a fresh enforcer couldn't)
// or cancels it.
//
// It seeks at once when created or retargeted on an element that already
// knows its media, rather than waiting for an event that a paused element
// may not send; except when asked not to (a drag step: moveTarget, or
// creation with deferSeek), where the next event seeks.

import { knownDuration, shortOfEnd } from "./duration";

/** The parts of a media element this needs. */
export interface Seekable {
  currentTime: number;
  readonly paused: boolean;
  /** HTMLMediaElement.seeking: a seek (anyone's) is in progress. */
  readonly seeking: boolean;
  /** NaN until known. The target is kept short of the end (see at): of this
   *  duration unless the constructor's `duration` source says otherwise. */
  readonly duration: number;
  /** HTMLMediaElement.readyState: 0 until the element knows its media. */
  readonly readyState: number;
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

export interface SeekHooks {
  /** When it lands with playback rolling (the skip-intro says so). */
  onLanded?: () => void;
}

/** How it ended. Only "landed" vouches for the element's position.
 *  "stood-down" (something else moved it: see above), "gave-up" (a stubborn
 *  stream) and "cancelled" do not. */
export type SeekEnd = "landed" | "stood-down" | "gave-up" | "cancelled";

// "durationchange": a new duration can move the end clamp (see at), which
// is acted on at once, not at the next playback event.
const EVENTS = ["loadedmetadata", "durationchange", "canplay", "playing", "seeked", "timeupdate"] as const;
const SLACK_SEC = 2;
/** HTMLMediaElement.HAVE_METADATA, without needing the DOM. */
const HAVE_METADATA = 1;
/** HTMLMediaElement.HAVE_FUTURE_DATA: playing, not just loading. */
const HAVE_FUTURE_DATA = 3;
/** An unconfirmed reading this close to the assigned value is its echo
 *  (engines may read it back through a time-base conversion). */
const ECHO_SEC = 1e-3;
const MAX_ATTEMPTS = 12;
/** How many times a moving end clamp may renew the bound: plenty for an
 *  estimate settling over a load, finite for one that never does. */
const MAX_CLAMP_RENEWALS = 60;

export class SeekEnforcer {
  private attempts = 0;
  private sawPlaying = false;
  private reached = false;
  /** Assignments not yet answered by a "seeked". Counted, not flagged: a
   *  late "seeked" from an earlier (clamped) seek must not confirm a newer
   *  one. Browsers that coalesce seeks answer only the last, which leaves
   *  this above 0: confirmation then comes from playback alone, and a
   *  paused reading away is retried rather than taken as the listener's. */
  private outstanding = 0;
  private done = false;
  private target: number;
  /** The position last put in place (assigned, or found already there);
   *  null before any, or after a failed assignment. Whenever the effective
   *  target differs from it, it is stale: readings are then only echoes of
   *  an earlier seek, possibly within the slack, and every event just
   *  seeks. */
  private placedAt: number | null = null;
  /** The target placedAt was for: a renewal is for the same target whose
   *  clamp moved, not a drag step or a retarget. */
  private placedFor = NaN;
  /** Where the end is (see at): the constructor's source, or the element's. */
  private readonly duration: () => number | null;
  /** Bound renewals granted to a moving end clamp, itself bounded: a
   *  duration that keeps being re-estimated mustn't lift the bound. */
  private clampRenewals = 0;

  /** `onDone` runs once, when it lands or stands down for any reason
   *  (including cancel()). `deferSeek`: don't seek at creation (a drag
   *  step); the next event does. `duration`: where the end is, when the
   *  caller knows better than the element (a reload's element knows
   *  nothing yet); the element's own by default. */
  constructor(
    private readonly el: Seekable,
    at: number,
    private hooks: SeekHooks = {},
    private readonly onDone: (end: SeekEnd) => void = () => {},
    { deferSeek = false, duration }: { deferSeek?: boolean; duration?: () => number | null } = {},
  ) {
    this.target = at;
    this.duration = duration ?? (() => knownDuration(el.duration));
    // A seek already in flight when it starts (a plain one the listener
    // made, or a cancelled enforcer's) will answer with a "seeked" too:
    // count it, so that answer isn't taken for this one's.
    if (el.seeking) this.outstanding = 1;
    // Armed mid-playback (the skip-intro, once the duration is known), the
    // "playing" it waits for has already fired and may not fire again.
    this.sawPlaying = !el.paused && el.readyState >= HAVE_FUTURE_DATA;
    for (const ev of EVENTS) el.addEventListener(ev, this.handle);
    if (!deferSeek) this.trySeek(this.at, { unlessThere: true });
  }

  /** Where it is putting the element: the target, kept a second short of
   *  the end once the duration is known (a seek onto the end ends the
   *  episode), however early the target was chosen. */
  get at(): number {
    return shortOfEnd(this.target, this.duration());
  }

  /** Aim at another position (the listener's seek), seeking now, and keeping
   *  the count of seeks in flight so their late answers aren't misread.
   *  Returns false if it has already ended; the caller then starts a new
   *  one. `hooks` replace the current ones when given. */
  retarget(at: number, hooks?: SeekHooks): boolean {
    if (!this.moveTarget(at, hooks)) return false;
    this.trySeek(this.at, { unlessThere: true });
    return true;
  }

  /** A step of a drag: only move the target (the next event seeks).
   *  `hooks` replace the current ones when given. */
  moveTarget(at: number, hooks?: SeekHooks): boolean {
    if (this.done) return false;
    this.target = at;
    if (hooks !== undefined) this.hooks = hooks;
    this.reached = false;
    this.attempts = 0;
    return true;
  }

  cancel(): void {
    this.finish("cancelled");
  }

  private finish(end: SeekEnd): void {
    if (this.done) return;
    this.done = true;
    for (const ev of EVENTS) this.el.removeEventListener(ev, this.handle);
    this.onDone(end);
  }

  private handle = (e: Event): void => {
    if (this.done) return;
    const el = this.el;
    if (e.type === "playing") this.sawPlaying = true;
    // Seeks of ours in flight before this event (a "seeked" could be one of
    // theirs only if any were) and after it (while any are, readings may be
    // echoes).
    const oursOutstanding = this.outstanding > 0;
    if (e.type === "seeked") this.outstanding = Math.max(0, this.outstanding - 1);
    const unconfirmed = this.outstanding > 0;
    const at = this.at;
    if (this.placedAt === null || at !== this.placedAt) {
      // Something was placed and the effective target has moved since: a
      // clamp moved by a new duration estimate (a moved target has reset
      // the bound already), not a failed attempt, so the bound isn't spent
      // on estimates settling. A failed assignment leaves nothing placed.
      // A moved clamp: the element may already be within the slack of the
      // new one (a small refinement), and then there's nothing to seek.
      const clampMoved = this.placedAt !== null && this.placedFor === this.target;
      if (clampMoved && this.clampRenewals < MAX_CLAMP_RENEWALS) {
        this.clampRenewals++;
        this.attempts = 0;
      }
      this.reached = false;
      this.trySeek(at, { unlessThere: clampMoved });
      return;
    }
    const cur = el.currentTime;
    const near = Math.abs(cur - at) <= SLACK_SEC;
    // Exactly the value assigned. While seeks are outstanding that is only
    // the assignment's echo, not a position the element has reached. And a
    // "seeked" confirms only a reading that isn't exact: an earlier seek's
    // "seeked" can be queued before this one was made (the element no
    // longer reports it as seeking), and then reads this seek's echo.
    // Playback confirms the rest.
    const exact = Math.abs(cur - at) < ECHO_SEC;
    const echo = unconfirmed && exact;
    const playingHere = near && !echo && this.sawPlaying && !el.paused && e.type === "timeupdate";
    if (near && ((e.type === "seeked" && !unconfirmed && !exact) || playingHere)) this.reached = true;
    if (el.paused) {
      if (near) return; // there (or on its way), waiting for playback
      // A "seeked" away with none of ours outstanding was someone else's
      // seek; one answering ours (clamped, or late) is retried.
      if (this.reached || (e.type === "seeked" && !oursOutstanding)) {
        this.finish("stood-down"); // not ours to fight
        return;
      }
    } else {
      if (near) {
        if (playingHere) {
          this.hooks.onLanded?.();
          this.finish("landed"); // playback is rolling there
        }
        return;
      }
      if (this.reached && cur > at + SLACK_SEC) {
        this.finish("stood-down"); // something skipped it ahead
        return;
      }
    }
    this.trySeek(at);
  };

  /** One attempt, if the element can take it: not before metadata (a seek
   *  then becomes the start position, applied unasked once the media is
   *  known), and not beyond the attempt bound. `unlessThere` (creation and
   *  retarget): not if it's already there, which counts as placed; a
   *  reading while seeks are outstanding is only their echo, so never. */
  private trySeek(at: number, { unlessThere = false }: { unlessThere?: boolean } = {}): void {
    if (this.el.readyState < HAVE_METADATA) return;
    // Already there with none of ours in flight: nothing to assign.
    if (unlessThere && this.outstanding === 0 && Math.abs(this.el.currentTime - at) <= SLACK_SEC) {
      this.placedAt = at;
      this.placedFor = this.target;
      return;
    }
    if (this.attempts++ >= MAX_ATTEMPTS) {
      this.finish("gave-up"); // stop fighting a stubborn stream
      return;
    }
    try {
      this.el.currentTime = at;
      this.placedAt = at;
      this.placedFor = this.target;
      this.outstanding++;
    } catch {
      // Not seekable yet: a later event retries (it stays stale), and each
      // such retry spends the bound.
      this.placedAt = null;
    }
  }
}
