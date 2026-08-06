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
