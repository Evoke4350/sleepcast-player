/** How much a feed's episodes lean in the shuffle (1 = no lean); see
 *  sleepscore shuffleWeights. */
export type FeedWeight = (feedId: string) => number;

export interface SleepSignal {
  t: number;              // ms since night start
  interacted: boolean;    // tap/skip/pause/extend/scrub this tick
  hidden: boolean;        // document.hidden
  fadingOrDone: boolean;  // timer fade in progress or complete
  hr?: number;            // Phase 2 only
}
export interface SleepOnset { atMs: number; confidence: number; via: "inference" | "hr" | "fused"; }
/** An episode start within a night, t relative to the night's start. */
export interface TimelineEntry {
  t: number;
  feedId: string;
  episodeId: string;
}
export interface RestNight {
  startedAt: number;
  /** When the night ended (finish's now). Absent for nights recorded before
   *  this shipped. */
  endedAt?: number;
  timerMinutes: number;
  endedVia: "faded" | "ended" | "abandoned";
  sleptAtMs: number | null;
  timeToSleepMs: number | null;
  interactions: number;
  /** "watch": the onset came from the Apple Watch's sleep stages (watch.ts),
   *  replacing the detector's. */
  detector: "inference" | "hr" | "fused" | "watch" | "none";
  /** The detector's own onset (sleptAtMs as it was) on a night the watch
   *  re-timed, so the two can be compared. Null when it found none. */
  inferredAtMs?: number | null;
  /** The night's episode starts, so a later onset (the watch's) can be
   *  attributed as finish attributes the detector's. Kept only while a watch
   *  import can still reach the night (TIMELINE_KEEP_MS, ledger.ts). */
  timeline?: TimelineEntry[];
  selfLabel?: "slept" | "awake";
  /** Feed playing when sleep was inferred. Absent when no onset was detected,
   *  or for any night recorded before this shipped. */
  onsetFeedId?: string;
  onsetEpisodeId?: string;
  /** How long the onset feed had been playing when sleep was inferred, as
   *  distinct from how long the night had been running. Absent when no onset
   *  was attributed. */
  onsetAfterMs?: number;
  /** Feeds that auto-advanced after onset — they played while you stayed under. */
  sleptThrough?: string[];
  /** Feeds you manually skipped or blocked during the night. */
  skipped?: string[];
  /** "leaned": the night's shuffle leaned on the scores (favorWhatWorks).
   *  Absent: a plain shuffle, the baseline to compare against. */
  shuffle?: "leaned";
}
export interface RestRollup {
  nights: number;
  nightsSlept: number;
  bestTimeToSleepMs: number | null;
  medianTimeToSleepMs: number | null;
  avgInteractions7: number;
}
export interface DetectorParams {
  lambdaAwake: number;   // P(interaction in a tick | awake)
  pHiddenAwake: number;  // P(tab hidden | awake)
  pHiddenAsleep: number; // P(tab hidden | asleep)
  alpha: number;         // target false-positive rate
  beta: number;          // target false-negative rate
}
