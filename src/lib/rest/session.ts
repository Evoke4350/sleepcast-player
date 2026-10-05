import type { SleepSignal, SleepOnset, RestNight } from "./types";
import { SleepDetector } from "./detector";
import { loadNights, loadParams } from "./ledger";
import { currentParams } from "./calibrate";

/** Touches closer together than this are one interaction for the night's
 *  record (see noteInteraction). */
export const INTERACTION_MERGE_MS = 3000;

export class RestSession {
  private detector: SleepDetector;
  private onset: SleepOnset | null = null;
  private interactions = 0;
  /** Every touch, unmerged: the live wakefulness signal, where a long
   *  restless stretch of fiddling must count as more than one. */
  private touches = 0;
  private pendingInteraction = false;
  /** Episode starts, t relative to night start so it compares directly with
   *  SleepOnset.atMs. This is why attribution is a comparison and not a join
   *  against the play ledger, which de-duplicates by episode id and so cannot
   *  answer "what was playing then" for any night but the most recent. */
  private timeline: { t: number; feedId: string; episodeId: string }[] = [];
  private skipped = new Set<string>();

  /** When (ms since the night began) the first pick the lean shaped was
   *  made, or null. */
  private leanedAt: number | null = null;

  /** `revived.shuffleLeanedAt`: the first lean-shaped pick before the
   *  reload, kept so the revived night's record still sees it. */
  constructor(readonly startedAt: number, readonly timerMinutes: number, revived?: { shuffleLeanedAt?: unknown } | null) {
    const at = revived?.shuffleLeanedAt;
    this.leanedAt = typeof at === "number" && Number.isFinite(at) && at >= 0 ? at : null;
    const params = currentParams(loadParams(), loadNights());
    this.detector = new SleepDetector(params);
  }

  private lastInteractionAt: number | null = null;
  /** Any transport touch since the last tick. Every touch marks the listener
   *  active now and counts toward wakefulness. For the night's record
   *  (calibration), touches closer than INTERACTION_MERGE_MS to the one
   *  before are one burst (a lock-screen drag's steps, taps on ±30 s),
   *  however long the burst runs, and count once. */
  noteInteraction(now: number = Date.now()): void {
    // Closer than the window merges; a gap of exactly the window, or a
    // clock stepped back (a negative gap), starts a new burst.
    const gap = this.lastInteractionAt === null ? Infinity : now - this.lastInteractionAt;
    if (gap < 0 || gap >= INTERACTION_MERGE_MS) this.interactions++;
    this.touches++;
    this.pendingInteraction = true;
    this.lastInteractionAt = now;
  }

  /** Observable wakefulness, for the opt-in quarter-hour rule. The detector's
   *  own onset is gated on the timer fade and says nothing mid-night, so
   *  interaction is the only live signal there is: every touch, unmerged. */
  wakefulness(now: number): { interactions: number; msSinceLastInteraction: number | null } {
    return {
      interactions: this.touches,
      msSinceLastInteraction:
        this.lastInteractionAt === null ? null : now - this.lastInteractionAt,
    };
  }

  /** Transport touches so far, for carrying across a reload (see seed). */
  get interactionCount(): number {
    return this.interactions;
  }

  /** Every touch so far, unmerged (wakefulness), for carrying across a reload. */
  get touchCount(): number {
    return this.touches;
  }

  /** A revived night keeps its real start (revivedNightStart), so it must keep
   *  the touches from before the reload too: otherwise its RestNight pairs a
   *  whole-night time-to-sleep with only the post-reload interactions, and
   *  calibration underestimates how often this listener touches the phone. */
  seedInteractions(n: number, touches: number = n): void {
    const count = (x: number) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
    this.interactions += count(n);
    // Wakefulness's unmerged count; a snapshot from before it was kept
    // carries only the merged one.
    this.touches += count(touches);
  }

  /** A pick the opt-in lean actually shaped (FeedWeight.onLeanedPick). The
   *  first one's time is kept; the night is recorded as leaned when it came
   *  before the inferred onset (wasLeaned): a pick after it (an auto-advance
   *  while asleep) had no part in getting there. The detector only reports
   *  an onset at the fade, after the fact, so this is a time compared in
   *  finish(), not a flag set now. */
  noteShuffleLeaned(now: number = Date.now()): void {
    if (this.leanedAt === null) this.leanedAt = Math.max(0, now - this.startedAt);
  }

  /** The first lean-shaped pick's time, for the snapshot. */
  get shuffleLeanedAt(): number | null {
    return this.leanedAt;
  }

  /** Called whenever an episode starts playing. */
  noteEpisode(feedId: string, episodeId: string, now: number = Date.now()): void {
    this.timeline.push({ t: now - this.startedAt, feedId, episodeId });
  }

  /** Called on Next and on "never again" — both mean this one didn't work. */
  noteSkip(feedId: string): void {
    this.skipped.add(feedId);
  }

  tick(s: Omit<SleepSignal, "t" | "interacted"> & { now: number; interacted?: boolean }): void {
    if (this.onset) return;
    const sig: SleepSignal = {
      t: s.now - this.startedAt,
      interacted: s.interacted ?? this.pendingInteraction,
      hidden: s.hidden,
      fadingOrDone: s.fadingOrDone,
    };
    this.pendingInteraction = false;
    const o = this.detector.observe(sig);
    if (o) this.onset = o;
  }

  finish(endedVia: RestNight["endedVia"], now: number): RestNight {
    const atMs = this.onset ? this.onset.atMs : null;
    // noteEpisode takes an explicit `now`, so a clock adjustment or a resumed
    // night can append an earlier t after a later one. .at(-1) means "latest
    // by time" only if entries arrived in time order, so sort a copy — this
    // must not mutate state a caller might still read — before trusting it.
    const sorted = [...this.timeline].sort((a, b) => a.t - b.t);
    const at = atMs === null ? null : sorted.filter((e) => e.t <= atMs).at(-1);
    const after = atMs === null ? [] : sorted.filter((e) => e.t > atMs);
    const sleptThrough = [...new Set(after.map((e) => e.feedId))];

    return {
      startedAt: this.startedAt,
      timerMinutes: this.timerMinutes,
      endedVia,
      sleptAtMs: atMs,
      timeToSleepMs: atMs,
      interactions: this.interactions,
      detector: this.onset ? "inference" : "none",
      ...(wasLeaned(this.leanedAt, atMs) ? { shuffle: "leaned" as const } : {}),
      // Spread rather than assign: an absent field and an empty array must not
      // become two shapes in a ledger that already holds 90 nights without them.
      // at.t is when the credited feed itself started, so atMs - at.t is how
      // long *it* had been playing — not the timeToSleepMs above, which is
      // measured from night start regardless of how much got skipped first.
      ...(at
        ? { onsetFeedId: at.feedId, onsetEpisodeId: at.episodeId, onsetAfterMs: (atMs as number) - at.t }
        : {}),
      ...(sleptThrough.length ? { sleptThrough } : {}),
      ...(this.skipped.size ? { skipped: [...this.skipped] } : {}),
    };
  }
}

/** When a revived night's session should say it began: the snapshot's real
 *  start when it has a believable one, else now. */
export function revivedNightStart(savedStart: number | undefined, now: number): number {
  return savedStart !== undefined && Number.isFinite(savedStart) && savedStart <= now ? savedStart : now;
}

/** Whether a night counts as leaned: its first lean-shaped pick (ms since
 *  the night began) came at or before sleep was inferred, or, with no onset
 *  (no time to sleep to credit), at all. Shared by finish() and reconcile. */
export function wasLeaned(leanedAt: number | null | undefined, onsetAtMs: number | null): boolean {
  if (typeof leanedAt !== "number" || !Number.isFinite(leanedAt)) return false;
  return onsetAtMs === null || leanedAt <= onsetAtMs;
}
