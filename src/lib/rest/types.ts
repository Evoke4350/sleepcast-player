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
export interface RestNight {
  startedAt: number;
  timerMinutes: number;
  endedVia: "faded" | "ended" | "abandoned";
  sleptAtMs: number | null;
  timeToSleepMs: number | null;
  interactions: number;
  detector: "inference" | "hr" | "fused" | "none";
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
  /** How long the night played, start to end. Absent on nights recorded
   *  before it was kept. */
  playedMs?: number;
  /** Each episode start, ms from night start: lets an onset that arrives
   *  later (from the watch) credit what was playing then. Absent on nights
   *  recorded before it was kept. */
  episodes?: NightEpisode[];
  /** Set when the watch's sleep was matched to this night (detector "hr"):
   *  when it says you fell asleep, ms from night start, even after the audio
   *  ended; null when it saw no sleep within WATCH_WINDOW_MS. sleptAtMs and
   *  timeToSleepMs then hold the watch's onset if it came while the night
   *  played, else null. */
  watchSleptAfterMs?: number | null;
  /** The detector's own onset, kept when the guess was tuned to the watch
   *  (calibrate.ts guessCorrectionMs) and so differs from sleptAtMs. */
  detectorAtMs?: number;
  /** Sleepcast's own guess (sleptAtMs) from before the watch replaced it. */
  appSleptAtMs?: number | null;
  /** The night's sleep stages from the watch, set with watchSleptAfterMs
   *  (watch.ts nightStages). Absent on nights matched before it was kept. */
  watchSleep?: SleepStretch[];
  /** Each burst of touches (RestSession.noteInteraction), ms from night
   *  start. Absent on nights recorded before it was kept; a night revived
   *  after a reload keeps only those since. */
  touchedAt?: number[];
  /** "leaned": the night's shuffle leaned on the scores (favorWhatWorks).
   *  Absent: a plain shuffle, the baseline to compare against. */
  shuffle?: "leaned";
}
export interface NightEpisode { t: number; feedId: string; episodeId: string }
/** Health's sleep stages; "asleep" is a watch that doesn't tell them apart. */
export type SleepStage = "awake" | "rem" | "core" | "deep" | "asleep" | "inbed";
/** One stretch of one stage, ms from night start. */
export interface SleepStretch { from: number; to: number; stage: SleepStage }
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
