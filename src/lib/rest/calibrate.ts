import type { RestNight, DetectorParams } from "./types";
import { DEFAULT_PARAMS, LAMBDA_MAX, TICK_MS } from "./detector";
import { loadNights, loadParams, saveParams } from "./ledger";

/** Re-estimate lambdaAwake from the user's own nights: interactions per awake
 *  tick, where "awake ticks" ≈ time-to-sleep / tick. Falls back to defaults
 *  with too little history. Clamped to a sane range. */
export function paramsFromHistory(nights: RestNight[]): DetectorParams {
  // A night marked "awake" has no real time-to-sleep to learn from. A
  // watch-timed one counts by the detector's own onset (inferredAtMs), as it
  // did before the watch re-timed it: its touches are counted over the whole
  // night, and the detector's onset follows the last touch, while the
  // watch's needn't (after-onset touches would read as awake ones and make
  // the detector bolder).
  const usable = nights.flatMap((n) => {
    const t = n.detector === "watch" ? n.inferredAtMs : n.timeToSleepMs;
    return t && t > 0 && n.selfLabel !== "awake" ? [{ t, interactions: n.interactions }] : [];
  });
  if (usable.length < 3) return DEFAULT_PARAMS;
  let interactions = 0;
  let awakeTicks = 0;
  for (const n of usable) {
    interactions += n.interactions;
    awakeTicks += Math.max(1, Math.round(n.t / TICK_MS));
  }
  const rate = interactions / awakeTicks;
  // Never below the default. A quiet listener (0 interactions) estimated at
  // the old 0.02 floor made each quiet tick such weak evidence that the bound
  // took ~49 min to reach: every shorter night hit its fade undecided, was
  // never scored as slept, and so never fed a better estimate back. Quiet
  // while awake is indistinguishable from asleep here; the fade gate, not a
  // lower rate, is what keeps that honest.
  const lambdaAwake = Math.min(LAMBDA_MAX, Math.max(DEFAULT_PARAMS.lambdaAwake, rate));
  return { ...DEFAULT_PARAMS, lambdaAwake };
}

/** A confirmed false positive tightens the detector for this user. */
export function tightenAfterFalsePositive(p: DetectorParams): DetectorParams {
  return { ...p, alpha: Math.max(0.001, p.alpha / 2) };
}

/** The params a night's detector should use: lambdaAwake re-estimated from
 *  this listener's history every night, alpha carried from any tightening
 *  they have confirmed. Only alpha is taken from the saved copy, so saving it
 *  never freezes the history estimate at the moment of the first save. */
export function currentParams(saved: DetectorParams | null, nights: RestNight[]): DetectorParams {
  const fromHistory = paramsFromHistory(nights);
  return saved ? { ...fromHistory, alpha: saved.alpha } : fromHistory;
}

/** The listener confirmed a false positive ("I was awake" on a night the
 *  detector called slept). Tighten from the params actually in use, not from
 *  a saved copy that may not exist yet: nothing saves params before the first
 *  false positive, so requiring one meant the tightening never happened. */
export function recordFalsePositive(): void {
  saveParams(tightenAfterFalsePositive(currentParams(loadParams(), loadNights())));
}
