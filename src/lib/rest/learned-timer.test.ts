import { describe, it, expect } from "vitest";
import { learnedTimer, timedNights, handPickHolds, HAND_PICK_HOLDS_MS, LEARN_MIN_NIGHTS } from "./learned-timer";
import type { RestNight } from "./types";

const START = Date.UTC(2026, 9, 1, 6);
const DAY = 86_400_000;
const MIN = 60_000;

function slept(i: number, minutes: number, extra: Partial<RestNight> = {}): RestNight {
  return {
    startedAt: START + i * DAY,
    timerMinutes: 45,
    endedVia: "faded",
    sleptAtMs: minutes * MIN,
    timeToSleepMs: minutes * MIN,
    interactions: 0,
    detector: "inference",
    ...extra,
  };
}
function awakeAtFade(i: number, timerMinutes: number): RestNight {
  return { ...slept(i, 0), timerMinutes, sleptAtMs: null, timeToSleepMs: null };
}

describe("learnedTimer", () => {
  it("waits for enough timed nights", () => {
    const nights = Array.from({ length: LEARN_MIN_NIGHTS - 1 }, (_, i) => slept(i, 20));
    expect(learnedTimer(nights)).toBeNull();
    expect(timedNights(nights)).toBe(LEARN_MIN_NIGHTS - 1);
  });

  it("covers the slower nights with room, rounded up to 5", () => {
    // 15, 18, 20, 22, 30: p75 = 22 → 22 + 10 = 32 → 35.
    const nights = [15, 18, 20, 22, 30].map((m, i) => slept(i, m));
    expect(learnedTimer(nights)).toEqual({ minutes: 35, usualMs: 20 * MIN, nights: 5 });
  });

  it("grows when the timer kept running out first", () => {
    const quick = [15, 15, 15, 15, 15].map((m, i) => slept(i, m));
    const base = learnedTimer(quick)!.minutes;
    const outlasted = [...quick, awakeAtFade(5, 45), awakeAtFade(6, 45), awakeAtFade(7, 45)];
    expect(learnedTimer(outlasted)!.minutes).toBeGreaterThan(base);
    expect(learnedTimer(outlasted)!.minutes).toBe(55);
  });

  it("ignores nights marked awake, ended by hand, and implausible onsets", () => {
    const good = [20, 20, 20, 20, 20].map((m, i) => slept(i, m));
    const noise = [
      slept(5, 90, { selfLabel: "awake" }),
      { ...awakeAtFade(6, 45), endedVia: "ended" as const },
      slept(7, 0.5),
    ];
    expect(learnedTimer([...good, ...noise])).toEqual(learnedTimer(good));
  });

  it("follows the recent nights only", () => {
    const old = Array.from({ length: 14 }, (_, i) => slept(i, 60));
    const recent = Array.from({ length: 14 }, (_, i) => slept(14 + i, 15));
    expect(learnedTimer([...old, ...recent])!.minutes).toBe(25);
  });

  it("stays within its floor", () => {
    const nights = Array.from({ length: 6 }, (_, i) => slept(i, 8));
    expect(learnedTimer(nights)!.minutes).toBe(20);
  });
});

describe("handPickHolds", () => {
  it("holds for the night, then lets go", () => {
    const now = START;
    expect(handPickHolds(undefined, now)).toBe(false);
    expect(handPickHolds(now - 60 * MIN, now)).toBe(true);
    expect(handPickHolds(now - HAND_PICK_HOLDS_MS, now)).toBe(false);
    expect(handPickHolds(now + MIN, now)).toBe(false);
  });
});
