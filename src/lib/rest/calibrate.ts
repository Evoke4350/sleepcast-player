import type { RestNight, DetectorParams } from "./types";
import { DEFAULT_PARAMS, LAMBDA_MAX, TICK_MS } from "./detector";
import { loadNights, loadParams, saveParams, median } from "./ledger";

/** Re-estimate lambdaAwake from the user's own nights: interactions per awake
 *  tick, where "awake ticks" ≈ time-to-sleep / tick. Falls back to defaults
 *  with too little history. Clamped to a sane range. */
export function paramsFromHistory(nights: RestNight[]): DetectorParams {
  // A night marked "awake" has no real time-to-sleep to learn from.
  const usable = nights.filter((n) => n.timeToSleepMs && n.timeToSleepMs > 0 && n.selfLabel !== "awake");
  if (usable.length < 3) return DEFAULT_PARAMS;
  let interactions = 0;
  let awakeTicks = 0;
  for (const n of usable) {
    interactions += n.interactions;
    awakeTicks += Math.max(1, Math.round((n.timeToSleepMs as number) / TICK_MS));
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
  const alpha = Math.min(saved ? saved.alpha : fromHistory.alpha, alphaFromWatch(nights));
  return { ...fromHistory, alpha };
}

/** Recent nights the detector called slept and the watch didn't. */
const WATCH_RECENT = 14;
export function watchCaughtFalsePositives(nights: readonly RestNight[]): number {
  return nights
    .slice(-WATCH_RECENT)
    .filter((n) => n.detector === "hr" && n.appSleptAtMs != null && n.sleptAtMs === null).length;
}

/** The watch grading the detector: each recent night it called slept that the
 *  watch says wasn't halves alpha, as an "I was awake" does. Worked out from
 *  the ledger every night, not saved, so matching the same watch data twice
 *  can't tighten it twice, and it eases off as those nights age out. */
function alphaFromWatch(nights: readonly RestNight[]): number {
  return Math.max(0.001, DEFAULT_PARAMS.alpha / 2 ** watchCaughtFalsePositives(nights));
}

/** The listener confirmed a false positive ("I was awake" on a night the
 *  detector called slept). Tighten from the params actually in use, not from
 *  a saved copy that may not exist yet: nothing saves params before the first
 *  false positive, so requiring one meant the tightening never happened. */
export function recordFalsePositive(): void {
  saveParams(tightenAfterFalsePositive(currentParams(loadParams(), loadNights())));
}

// ---------------------------------------------------------------------------
// Tuning the guess to the watch. The detector decides you're asleep a fixed
// stretch of quiet after your last touch; how long you really take after
// putting the phone down is your own. Each night the watch timed is a
// measure of that: the watch's onset against the detector's. The middle of
// those differences moves later guesses, when it would have moved the past
// ones closer (checked night by night, each against the others).
// ---------------------------------------------------------------------------

/** Nights needed before the guess is tuned, and how many recent ones count. */
export const MIN_PAIRS = 3;
const PAIRS_KEPT = 30;
const MAX_CORRECTION_MS = 60 * 60_000;

interface Pair { raw: number; watch: number }

/** The detector's own onset against the watch's, on recent nights with both. */
function pairs(nights: readonly RestNight[]): Pair[] {
  return nights
    .filter((n) => n.detector === "hr" && n.appSleptAtMs != null && n.watchSleptAfterMs != null)
    .slice(-PAIRS_KEPT)
    // detectorAtMs: a night whose guess was already tuned keeps the untuned one.
    .map((n) => ({ raw: n.detectorAtMs ?? (n.appSleptAtMs as number), watch: n.watchSleptAfterMs as number }));
}

function shiftOf(ps: readonly Pair[]): number {
  const m = median(ps.map((p) => p.watch - p.raw)) ?? 0;
  return Math.max(-MAX_CORRECTION_MS, Math.min(MAX_CORRECTION_MS, Math.round(m)));
}

export interface GuessAccuracy {
  /** Nights the watch and the detector both timed. */
  nights: number;
  /** How much later (negative: earlier) the guess moves. */
  correctionMs: number;
  /** Typical miss, untuned and tuned (each night tuned on the others). */
  beforeMs: number;
  afterMs: number;
  /** Whether the tuning is used: only when it misses by less. */
  applied: boolean;
}

export function guessAccuracy(nights: readonly RestNight[]): GuessAccuracy | null {
  const ps = pairs(nights);
  if (ps.length < MIN_PAIRS) return null;
  const beforeMs = median(ps.map((p) => Math.abs(p.watch - p.raw)))!;
  const afterMs = median(ps.map((p, i) => {
    const shift = shiftOf(ps.filter((_, j) => j !== i));
    return Math.abs(p.watch - Math.max(0, p.raw + shift));
  }))!;
  return { nights: ps.length, correctionMs: shiftOf(ps), beforeMs, afterMs, applied: afterMs < beforeMs };
}

/** How far to move tonight's guess. */
export function guessCorrectionMs(nights: readonly RestNight[]): number {
  const a = guessAccuracy(nights);
  return a?.applied ? a.correctionMs : 0;
}
