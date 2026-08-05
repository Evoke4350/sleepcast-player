import type { SleepSignal, SleepOnset, RestNight } from "./types";
import { SleepDetector, DEFAULT_PARAMS } from "./detector";
import { loadNights, loadParams } from "./ledger";
import { paramsFromHistory } from "./calibrate";

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

  constructor(private startedAt: number, private timerMinutes: number) {
    const params = loadParams() ?? paramsFromHistory(loadNights()) ?? DEFAULT_PARAMS;
    this.detector = new SleepDetector(params);
  }

  private lastInteractionAt: number | null = null;

  /** Any transport touch since the last tick. */
  noteInteraction(now: number = Date.now()): void {
    this.interactions++;
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
    const at = atMs === null ? null : this.timeline.filter((e) => e.t <= atMs).at(-1);
    const after = atMs === null ? [] : this.timeline.filter((e) => e.t > atMs);
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
      ...(at ? { onsetFeedId: at.feedId, onsetEpisodeId: at.episodeId } : {}),
      ...(sleptThrough.length ? { sleptThrough } : {}),
      ...(this.skipped.size ? { skipped: [...this.skipped] } : {}),
    };
  }
}
