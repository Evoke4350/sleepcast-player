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
