import type { SleepSignal, SleepOnset, RestNight } from "./types";
import { SleepDetector } from "./detector";
import { loadNights, loadParams } from "./ledger";
import { currentParams } from "./calibrate";

/** Touches closer together than this are one interaction (see noteInteraction). */
export const INTERACTION_MERGE_MS = 3000;

export class RestSession {
  private detector: SleepDetector;
  private onset: SleepOnset | null = null;
  private interactions = 0;
  private pendingInteraction = false;
  /** Episode starts, t relative to night start so it compares directly with
   *  SleepOnset.atMs. This is why attribution is a comparison and not a join
   *  against the play ledger, which de-duplicates by episode id and so cannot
   *  answer "what was playing then" for any night but the most recent. */
  private timeline: { t: number; feedId: string; episodeId: string }[] = [];
  private skipped = new Set<string>();

  constructor(readonly startedAt: number, readonly timerMinutes: number) {
    const params = currentParams(loadParams(), loadNights());
    this.detector = new SleepDetector(params);
  }

  private lastInteractionAt: number | null = null;
  /** When a touch last counted: touches closer together than
   *  INTERACTION_MERGE_MS are one intent (a lock-screen drag's steps, a
   *  double tap on ±30 s) and count once. */
  private lastCountedAt: number | null = null;

  /** Any transport touch since the last tick. Every touch marks the listener
   *  active now; a burst counts as one interaction. */
  noteInteraction(now: number = Date.now()): void {
    if (this.lastCountedAt === null || now - this.lastCountedAt > INTERACTION_MERGE_MS) {
      this.interactions++;
      this.lastCountedAt = now;
    }
    this.pendingInteraction = true;
    this.lastInteractionAt = now;
  }

  /** Observable wakefulness, for the opt-in quarter-hour rule. The detector's
   *  own onset is gated on the timer fade and says nothing mid-night, so
   *  interaction is the only live signal there is. */
  wakefulness(now: number): { interactions: number; msSinceLastInteraction: number | null } {
    return {
      interactions: this.interactions,
      msSinceLastInteraction:
        this.lastInteractionAt === null ? null : now - this.lastInteractionAt,
    };
  }

  /** Transport touches so far, for carrying across a reload (see seed). */
  get interactionCount(): number {
    return this.interactions;
  }

  /** A revived night keeps its real start (revivedNightStart), so it must keep
   *  the touches from before the reload too: otherwise its RestNight pairs a
   *  whole-night time-to-sleep with only the post-reload interactions, and
   *  calibration underestimates how often this listener touches the phone. */
  seedInteractions(n: number): void {
    if (Number.isFinite(n) && n > 0) this.interactions += Math.floor(n);
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
