import { describe, it, expect } from "vitest";
import { paramsFromHistory, tightenAfterFalsePositive } from "./calibrate";
import { DEFAULT_PARAMS } from "./detector";
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
