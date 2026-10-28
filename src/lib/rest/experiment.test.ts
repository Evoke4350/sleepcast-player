import { describe, it, expect, beforeEach } from "vitest";
import type { RestNight } from "./types";
import {
  startExperiment, assignTonight, currentExperiment, endExperiment, extendExperiment, pastExperiments,
  experimentResult, outcomeMs, rankSumPValue, nightOf, type Arm,
} from "./experiment";

const MIN = 60_000;
const A: Arm = { kind: "show", feedId: "a" };
const B: Arm = { kind: "show", feedId: "b" };

function night(startedAt: number, over: Partial<RestNight> = {}): RestNight {
  return { startedAt, timerMinutes: 45, endedVia: "faded", sleptAtMs: 20 * MIN, timeToSleepMs: 20 * MIN, interactions: 0, detector: "inference", ...over };
}

describe("experiments", () => {
  beforeEach(() => localStorage.clear());

  it("gives nights sides at random, kept even", () => {
    let r = 0;
    const rand = () => [0.2, 0.7, 0.9, 0.1, 0.6][r++ % 5];
    startExperiment([A, B], 3, 0, rand);
    const sides = Array.from({ length: 6 }, (_, i) => assignTonight(i * 86_400_000, rand));
    const feeds = sides.map((s) => (s?.kind === "show" ? s.feedId : null));
    const counts = [feeds.filter((f) => f === "a").length, feeds.filter((f) => f === "b").length];
    expect(counts).toEqual([3, 3]);
    // every two nights are one of each
    for (let i = 0; i < 6; i += 2) expect(new Set([feeds[i], feeds[i + 1]]).size).toBe(2);
  });

  it("one at a time: starting another ends the running one", () => {
    startExperiment([A, B], 5, 1);
    assignTonight(1);
    startExperiment([{ kind: "timer", minutes: 25 }, { kind: "timer", minutes: 45 }], 5, 2);
    expect(currentExperiment()?.arms[0]).toEqual({ kind: "timer", minutes: 25 });
    expect(pastExperiments()).toHaveLength(1);
    expect(pastExperiments()[0].endedAt).toBe(2);
    endExperiment(3);
    expect(currentExperiment()).toBeNull();
    expect(pastExperiments()).toHaveLength(1); // the second had no nights
    expect(assignTonight()).toBeNull();
  });

  it("matches nights by when they started", () => {
    const nights = [night(1000), night(10_000_000)];
    expect(nightOf(900, nights)?.startedAt).toBe(1000);
    expect(nightOf(5_000_000, nights)).toBeUndefined();
  });

  it("times a night by the watch, else the guess; no sleep on the watch is slowest", () => {
    expect(outcomeMs(night(0, { detector: "hr", watchSleptAfterMs: 12 * MIN }))).toBe(12 * MIN);
    expect(outcomeMs(night(0, { detector: "hr", watchSleptAfterMs: null }))).toBe(Infinity);
    expect(outcomeMs(night(0))).toBe(20 * MIN);
    expect(outcomeMs(night(0, { sleptAtMs: null, timeToSleepMs: null }))).toBeNull();
  });

  it("no result until both sides have their nights; then a winner when it's unlikely to be chance", () => {
    let r = 0;
    const rand = () => (r++ % 2 ? 0.9 : 0.1);
    startExperiment([A, B], 5, 0, rand);
    const nights: RestNight[] = [];
    for (let i = 0; i < 10; i++) {
      const at = i * 86_400_000;
      const arm = assignTonight(at, rand);
      const t = (arm?.kind === "show" && arm.feedId === "a" ? 10 + i : 40 + i) * MIN;
      nights.push(night(at + 1000, { sleptAtMs: t, timeToSleepMs: t }));
      if (i === 5) expect(experimentResult(currentExperiment()!, nights)).toMatchObject({ done: false, pValue: null, winner: null });
    }
    const res = experimentResult(currentExperiment()!, nights);
    expect(res.done).toBe(true);
    expect(res.winner).toBe(0);
    expect(res.pValue).toBeCloseTo(2 / 252); // the most lopsided split, either way, of C(10,5)
    extendExperiment(5);
    expect(experimentResult(currentExperiment()!, nights).done).toBe(false);
  });
});

describe("rankSumPValue", () => {
  it("1 when the sides are alike, small when they don't overlap", () => {
    expect(rankSumPValue([1, 2, 3], [1, 2, 3])).toBe(1);
    expect(rankSumPValue([1, 2, 3, 4], [5, 6, 7, 8])).toBeCloseTo(2 / 70);
  });
  it("samples splits when there are too many to count, landing near the exact answer", () => {
    const a = Array.from({ length: 14 }, (_, i) => i * 2);
    const b = Array.from({ length: 14 }, (_, i) => i * 2 + 7);
    // 40 million splits; the normal approximation puts this near 0.05.
    const p = rankSumPValue(a, b);
    expect(p).toBeGreaterThan(0.03);
    expect(p).toBeLessThan(0.07);
    expect(rankSumPValue(a, b)).toBe(p); // the same each time
  });
});
