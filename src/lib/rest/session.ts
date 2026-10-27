import type { SleepSignal, SleepOnset, RestNight, NightEpisode } from "./types";
import { SleepDetector } from "./detector";
import { loadNights, loadParams } from "./ledger";
import { currentParams, guessCorrectionMs } from "./calibrate";

/** Touches closer together than this are one interaction for the night's
 *  record (see noteInteraction). */
export const INTERACTION_MERGE_MS = 3000;

export class RestSession {
  private detector: SleepDetector;
  /** How far the watch says to move the detector's onset (calibrate.ts). */
  private correction: number;
  /** The detector's verdict, held until the night ends. The detector decides
   *  on the first tick inside the fade, which is the very moment an awake
   *  listener hears the volume drop and reaches for the phone: a stretch or a
   *  hold-to-end in the remaining seconds says they were awake after all. So
   *  a verdict only stands if no touch follows it and the night fades out. */
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
  private timeline: NightEpisode[] = [];
  /** When each burst of touches began, for the night's chart. */
  private touchedAt: number[] = [];
  private skipped = new Set<string>();

  /** `shuffleLeaned`: the night's shuffle leaned on the scores (the
   *  opt-in lean was in effect for it), recorded on its RestNight. By what
   *  was in effect, not by whether a pick it shaped came before sleep: the
   *  latter is decided by the night itself (a restless night reaches more
   *  picks), which would bias the leaned-vs-other comparison. */
  constructor(readonly startedAt: number, readonly timerMinutes: number, readonly shuffleLeaned = false) {
    const nights = loadNights();
    this.detector = new SleepDetector(currentParams(loadParams(), nights));
    this.correction = guessCorrectionMs(nights);
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
    if (gap < 0 || gap >= INTERACTION_MERGE_MS) {
      this.interactions++;
      if (this.touchedAt.length < MAX_TOUCHES) this.touchedAt.push(Math.max(0, now - this.startedAt));
    }
    this.touches++;
    this.pendingInteraction = true;
    // A touch after the verdict overturns it. The night may go on (a stretch)
    // and reach another fade, so the evidence starts again from nothing.
    if (this.onset) {
      this.onset = null;
      this.detector.reset();
    }
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
    // Only a night that faded out stands as slept: one ended by hand in the
    // fade was ended by someone awake.
    const onset = endedVia === "faded" ? this.onset : null;
    const playedMs = Math.max(0, now - this.startedAt);
    // Tuned to the watch, but never before the last touch (you were awake
    // for it) or after the night ended.
    const lastTouch = this.lastInteractionAt === null ? 0 : this.lastInteractionAt - this.startedAt;
    const atMs = onset
      ? Math.round(Math.min(playedMs, Math.max(lastTouch, 0, onset.atMs + this.correction)))
      : null;
    const episodes = [...this.timeline].sort((a, b) => a.t - b.t).slice(-MAX_EPISODES);

    return {
      startedAt: this.startedAt,
      timerMinutes: this.timerMinutes,
      endedVia,
      sleptAtMs: atMs,
      timeToSleepMs: atMs,
      interactions: this.interactions,
      detector: onset ? "inference" : "none",
      ...(this.shuffleLeaned ? { shuffle: "leaned" as const } : {}),
      ...attributeOnset(episodes, atMs),
      ...(this.skipped.size ? { skipped: [...this.skipped] } : {}),
      playedMs,
      ...(onset && atMs !== onset.atMs ? { detectorAtMs: onset.atMs } : {}),
      ...(episodes.length ? { episodes } : {}),
      ...(this.touchedAt.length ? { touchedAt: [...this.touchedAt] } : {}),
    };
  }
}

/** Episode starts kept on a night's record: plenty for any real night, and
 *  bounded so a night of skipping can't bloat the 90-night ledger. */
const MAX_EPISODES = 40;
/** Touch bursts kept, likewise: a restless night still draws, bounded. */
const MAX_TOUCHES = 80;

/** What was playing at an onset `atMs` ms into the night, and what played on
 *  after it, from the night's episode starts. Empty when there's no onset.
 *  Spread into a RestNight rather than assigned: an absent field and an empty
 *  array must not become two shapes in a ledger that already holds 90 nights
 *  without them. */
export function attributeOnset(
  timeline: readonly NightEpisode[],
  atMs: number | null,
): Pick<RestNight, "onsetFeedId" | "onsetEpisodeId" | "onsetAfterMs" | "sleptThrough"> {
  if (atMs === null) return {};
  // noteEpisode takes an explicit `now`, so a clock adjustment or a resumed
  // night can append an earlier t after a later one. .at(-1) means "latest
  // by time" only if entries arrived in time order, so sort a copy before
  // trusting it.
  const sorted = [...timeline].sort((a, b) => a.t - b.t);
  const at = sorted.filter((e) => e.t <= atMs).at(-1);
  const sleptThrough = [...new Set(sorted.filter((e) => e.t > atMs).map((e) => e.feedId))];
  return {
    // at.t is when the credited feed itself started, so atMs - at.t is how
    // long *it* had been playing — not timeToSleepMs, which is measured from
    // night start regardless of how much got skipped first.
    ...(at ? { onsetFeedId: at.feedId, onsetEpisodeId: at.episodeId, onsetAfterMs: atMs - at.t } : {}),
    ...(sleptThrough.length ? { sleptThrough } : {}),
  };
}

/** When a revived night's session should say it began: the snapshot's real
 *  start when it has a believable one, else now. */
export function revivedNightStart(savedStart: number | undefined, now: number): number {
  return savedStart !== undefined && Number.isFinite(savedStart) && savedStart <= now ? savedStart : now;
}
