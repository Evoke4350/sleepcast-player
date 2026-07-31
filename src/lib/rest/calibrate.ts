import type { RestNight, DetectorParams } from "./types";
import { DEFAULT_PARAMS } from "./detector";

const TICK_MS = 15_000;

/** Re-estimate lambdaAwake from the user's own nights: interactions per awake
 *  tick, where "awake ticks" ≈ time-to-sleep / tick. Falls back to defaults
 *  with too little history. Clamped to a sane range. */
export function paramsFromHistory(nights: RestNight[]): DetectorParams {
  const usable = nights.filter((n) => n.timeToSleepMs && n.timeToSleepMs > 0);
  if (usable.length < 3) return DEFAULT_PARAMS;
  let interactions = 0;
  let awakeTicks = 0;
  for (const n of usable) {
    interactions += n.interactions;
    awakeTicks += Math.max(1, Math.round((n.timeToSleepMs as number) / TICK_MS));
  }
  const rate = interactions / awakeTicks;
  const lambdaAwake = Math.min(0.5, Math.max(0.02, rate));
  return { ...DEFAULT_PARAMS, lambdaAwake };
}

/** A confirmed false positive tightens the detector for this user. */
export function tightenAfterFalsePositive(p: DetectorParams): DetectorParams {
  return { ...p, alpha: Math.max(0.001, p.alpha / 2) };
}
