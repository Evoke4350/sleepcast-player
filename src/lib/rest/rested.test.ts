import { describe, it, expect, beforeEach } from "vitest";
import type { RestNight, Rested, SleepStretch } from "./types";
import { MIN_RATED, nightToRate, rateNight, restedSummary, spearman } from "./rested";
import { loadNights, saveNights } from "./ledger";

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();
const st = (from: number, to: number, stage: SleepStretch["stage"]): SleepStretch => ({ from: from * MIN, to: to * MIN, stage });

function night(startedAt: number, over: Partial<RestNight> = {}): RestNight {
  return {
    startedAt, timerMinutes: 45, endedVia: "faded", sleptAtMs: 20 * MIN, timeToSleepMs: 20 * MIN, interactions: 0,
    detector: "hr", watchSleptAfterMs: 20 * MIN, playedMs: 45 * MIN,
    watchSleep: [st(0, 20, "awake"), st(20, 200, "core"), st(200, 260, "deep"), st(260, 420, "rem")],
    ...over,
  };
}

/** A night with `deep` minutes of Deep sleep, rated `rested`. */
const withDeep = (day: number, deep: number, rested: Rested) =>
  night(at(day, 23), { rested, watchSleep: [st(0, 20, "awake"), st(20, 200, "core"), st(200, 200 + deep, "deep"), st(200 + deep, 420, "rem")] });

describe("nightToRate", () => {
  const n = night(at(20, 23));
  it("asks the morning after", () => {
    expect(nightToRate([n], at(21, 7))?.startedAt).toBe(n.startedAt);
  });
  it("not while the night is young, nor the next evening", () => {
    expect(nightToRate([n], at(21, 1))).toBeNull();
    expect(nightToRate([n], at(21, 20))).toBeNull();
  });
  it("a 3am re-anchor is the same sleep: asks about its first night", () => {
    const second = night(at(21, 3));
    expect(nightToRate([n, second], at(21, 8))?.startedAt).toBe(n.startedAt);
  });
  it("nothing to ask with no nights", () => {
    expect(nightToRate([], at(21, 7))).toBeNull();
  });
});

describe("rateNight", () => {
  beforeEach(() => localStorage.clear());
  it("keeps the rating on that night", () => {
    saveNights([night(at(20, 23)), night(at(21, 23))]);
    rateNight(at(21, 23), 4);
    expect(loadNights().map((n) => n.rested)).toEqual([undefined, 4]);
  });
});

describe("spearman", () => {
  it("is 1 for any rising pairing, and unlikely by chance", () => {
    const r = spearman([1, 2, 3, 4, 5, 6, 7, 8], [10, 20, 25, 40, 41, 60, 70, 99]);
    expect(r.rho).toBeCloseTo(1);
    expect(r.pValue).toBeLessThan(0.001);
  });
  it("NaN when one side never varies", () => {
    expect(spearman([1, 2, 3], [4, 4, 4]).rho).toBeNaN();
  });
});

describe("restedSummary", () => {
  it("null until a morning is rated", () => {
    expect(restedSummary([night(at(20, 23))])).toBeNull();
  });
  it("counts and averages, but tests nothing below MIN_RATED", () => {
    const s = restedSummary([withDeep(20, 30, 2), withDeep(21, 60, 4)])!;
    expect(s).toMatchObject({ rated: 2, average: 3, links: [] });
  });
  it("finds Deep sleep going with rested mornings, and nothing in measures that don't vary", () => {
    const deep = [20, 30, 45, 50, 60, 75, 80, 90, 100, 110];
    const rested: Rested[] = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
    const nights = deep.map((d, i) => withDeep(10 + i, d, rested[i]));
    expect(nights.length).toBeGreaterThanOrEqual(MIN_RATED);
    const s = restedSummary(nights)!;
    expect(s.links[0]).toMatchObject({ measure: "deep", clear: true });
    expect(s.links[0].rho).toBeGreaterThan(0.9);
    // REM is what Deep leaves, so it falls as Deep rises.
    expect(s.links.find((l) => l.measure === "rem")!.rho).toBeLessThan(-0.9);
    // Asleep and to-sleep are the same every night: nothing to test.
    expect(s.links.some((l) => l.measure === "asleep" || l.measure === "toSleep")).toBe(false);
  });
  it("no Deep or REM from a watch that doesn't tell stages apart", () => {
    const nights = Array.from({ length: 8 }, (_, i) =>
      night(at(10 + i, 23), { rested: ((i % 5) + 1) as Rested, watchSleep: [st(0, 20, "awake"), st(20, 300 + i * 10, "asleep")] }));
    const s = restedSummary(nights)!;
    expect(s.links.map((l) => l.measure)).toContain("asleep");
    expect(s.links.some((l) => l.measure === "deep" || l.measure === "rem")).toBe(false);
  });
  it("weak links among many aren't called clear", () => {
    const rested: Rested[] = [3, 1, 4, 1, 5, 2, 2, 3];
    const nights = rested.map((r, i) => withDeep(10 + i, [50, 40, 70, 30, 60, 90, 20, 80][i], r));
    expect(restedSummary(nights)!.links.every((l) => !l.clear)).toBe(true);
  });
});
