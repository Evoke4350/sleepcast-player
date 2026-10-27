import { describe, it, expect, beforeEach } from "vitest";
import { paramsFromHistory, tightenAfterFalsePositive, currentParams, recordFalsePositive, guessAccuracy, guessCorrectionMs } from "./calibrate";
import { loadParams, loadNights } from "./ledger";
import { DEFAULT_PARAMS, quietTicksToDecide, TICK_MS } from "./detector";
import type { RestNight } from "./types";

const night = (interactions: number, timeToSleepMs = 300000): RestNight => ({
  startedAt: Math.random(), timerMinutes: 60, endedVia: "faded",
  sleptAtMs: timeToSleepMs, timeToSleepMs, interactions, detector: "inference",
});

describe("paramsFromHistory", () => {
  it("cold start returns defaults", () => {
    expect(paramsFromHistory([])).toEqual(DEFAULT_PARAMS);
  });
  it("high-interaction history raises lambdaAwake above default", () => {
    const p = paramsFromHistory(Array.from({ length: 10 }, () => night(20)));
    expect(p.lambdaAwake).toBeGreaterThan(DEFAULT_PARAMS.lambdaAwake);
  });
  it("lambdaAwake stays within sane bounds", () => {
    const p = paramsFromHistory(Array.from({ length: 10 }, () => night(9999)));
    expect(p.lambdaAwake).toBeLessThanOrEqual(0.5);
    expect(p.lambdaAwake).toBeGreaterThan(0);
  });
});

describe("tightenAfterFalsePositive", () => {
  it("lowers alpha (raises the bar)", () => {
    expect(tightenAfterFalsePositive(DEFAULT_PARAMS).alpha).toBeLessThan(DEFAULT_PARAMS.alpha);
  });
  it("never drops below a floor", () => {
    let p = DEFAULT_PARAMS;
    for (let i = 0; i < 50; i++) p = tightenAfterFalsePositive(p);
    expect(p.alpha).toBeGreaterThanOrEqual(0.001);
  });
});

describe("recording a false positive", () => {
  beforeEach(() => localStorage.clear());

  // "I was awake" after a night the detector called slept is meant to tighten
  // the detector. Both call sites did `const p = loadParams(); if (p) save…`,
  // and nothing else ever saves params, so p was always null and the
  // tightening was silently dropped for every listener.
  it("tightens the detector even when no params were ever saved", () => {
    expect(loadParams()).toBeNull();
    recordFalsePositive();
    expect(loadParams()?.alpha).toBe(DEFAULT_PARAMS.alpha / 2);
  });

  it("keeps tightening on each confirmed false positive", () => {
    recordFalsePositive();
    recordFalsePositive();
    expect(loadParams()?.alpha).toBe(DEFAULT_PARAMS.alpha / 4);
  });

  it("the tightening reaches the params a new night's detector uses", () => {
    recordFalsePositive();
    expect(currentParams(loadParams(), loadNights()).alpha).toBe(DEFAULT_PARAMS.alpha / 2);
  });

  // Saving full params must not freeze lambdaAwake: it should keep being
  // re-estimated from history; only alpha is carried from the saved copy.
  it("keeps re-estimating lambdaAwake from history after a save", () => {
    recordFalsePositive();
    const busy = Array.from({ length: 3 }, (_, i) => ({
      startedAt: i, timerMinutes: 45, endedVia: "faded" as const,
      sleptAtMs: 600_000, timeToSleepMs: 600_000, interactions: 12, detector: "inference" as const,
    }));
    expect(currentParams(loadParams(), busy).lambdaAwake).toBe(paramsFromHistory(busy).lambdaAwake);
    expect(paramsFromHistory(busy).lambdaAwake).not.toBe(DEFAULT_PARAMS.lambdaAwake);
  });
});

describe("paramsFromHistory keeps the detector able to decide", () => {
  // A listener who never touches the phone has 0 interactions per awake
  // tick, and the estimate was clamped to 0.02. At that rate a quiet tick is
  // such weak evidence that the bound takes ~195 ticks (~49 min), so every
  // shorter night reached its fade undecided and was never scored as slept
  // again, and the estimate could never recover.
  it("never calibrates below the default rate", () => {
    const quiet = [night(0, 450_000), night(0, 450_000), night(0, 450_000)];
    expect(paramsFromHistory(quiet).lambdaAwake).toBe(DEFAULT_PARAMS.lambdaAwake);
  });

  it("a quiet listener's detector still decides inside a 25-minute night", () => {
    const quiet = [night(0, 450_000), night(0, 450_000), night(0, 450_000)];
    const ticks = quietTicksToDecide(paramsFromHistory(quiet));
    expect(ticks * TICK_MS).toBeLessThan(25 * 60_000 - 60_000); // before the fade window
  });
});

describe("tuning the guess to the watch", () => {
  const MIN = 60_000;
  /** A night the watch timed: the detector guessed `app` min, the watch `watch` min. */
  const timed = (app: number, watch: number, over: Partial<RestNight> = {}): RestNight => ({
    startedAt: Math.random(), timerMinutes: 60, endedVia: "faded", sleptAtMs: watch * MIN, timeToSleepMs: watch * MIN,
    interactions: 0, detector: "hr", appSleptAtMs: app * MIN, watchSleptAfterMs: watch * MIN, ...over,
  });

  it("nothing below 3 nights", () => {
    expect(guessAccuracy([timed(10, 20), timed(12, 22)])).toBeNull();
    expect(guessCorrectionMs([timed(10, 20), timed(12, 22)])).toBe(0);
  });
  it("moves the guess by the middle difference when that misses by less", () => {
    const a = guessAccuracy([timed(10, 22), timed(12, 23), timed(8, 21), timed(15, 26)])!;
    expect(a.correctionMs).toBe(11.5 * MIN);
    expect(a).toMatchObject({ nights: 4, applied: true });
    expect(a.beforeMs).toBeGreaterThan(10 * MIN);
    expect(a.afterMs).toBeLessThan(2 * MIN);
    expect(guessCorrectionMs([timed(10, 22), timed(12, 23), timed(8, 21), timed(15, 26)])).toBe(11.5 * MIN);
  });
  it("leaves the guess alone when moving it wouldn't help", () => {
    const ns = [timed(20, 10), timed(10, 20), timed(20, 21), timed(15, 15)];
    expect(guessAccuracy(ns)!.applied).toBe(false);
    expect(guessCorrectionMs(ns)).toBe(0);
  });
  it("learns from the untuned guess, so a tuned night doesn't shrink the tuning", () => {
    // Already tuned by 12: the shown guess (appSleptAtMs) matched the watch.
    const ns = [10, 11, 9].map((raw) => timed(raw + 12, raw + 12, { detectorAtMs: raw * MIN }));
    expect(guessCorrectionMs(ns)).toBe(12 * MIN);
  });
  it("only nights both timed", () => {
    const ns = [timed(10, 20), timed(10, 20), timed(10, 20, { appSleptAtMs: null }), timed(10, 20, { watchSleptAfterMs: null })];
    expect(guessAccuracy(ns)).toBeNull();
  });
});
