import { describe, expect, it } from "vitest";
import {
  qualifiesForStepBack,
  isQuiet,
  quietUntilFrom,
  STEPBACK_WINDOW,
  STEPBACK_MIN_NIGHTS,
  QUIET_DAYS,
} from "./stepback";
import type { RestNight } from "./types";

const DAY = 86_400_000;

const night = (over: Partial<RestNight> = {}): RestNight => ({
  startedAt: 1_000_000,
  timerMinutes: 45,
  endedVia: "faded",
  sleptAtMs: 8 * 60_000,
  timeToSleepMs: 8 * 60_000,
  interactions: 1,
  detector: "inference",
  ...over,
});

/** n nights that all went well. */
const goodNights = (n: number) =>
  Array.from({ length: n }, (_, i) => night({ startedAt: 1_000_000 + i * DAY }));

describe("qualifiesForStepBack", () => {
  it("says no when there is barely any history", () => {
    expect(qualifiesForStepBack(goodNights(3))).toBe(false);
    expect(qualifiesForStepBack(goodNights(STEPBACK_MIN_NIGHTS - 1))).toBe(false);
  });

  it("says yes after a long run of falling asleep quickly", () => {
    expect(qualifiesForStepBack(goodNights(STEPBACK_WINDOW))).toBe(true);
  });

  it("says no when too many recent nights were not slept through", () => {
    const nights = goodNights(STEPBACK_WINDOW);
    for (let i = 0; i < 6; i++) {
      nights[i] = night({ startedAt: nights[i].startedAt, sleptAtMs: null, timeToSleepMs: null });
    }
    expect(qualifiesForStepBack(nights)).toBe(false);
  });

  it("says no when sleep is happening but slowly — that person still needs help", () => {
    const slow = Array.from({ length: STEPBACK_WINDOW }, (_, i) =>
      night({ startedAt: 1_000_000 + i * DAY, sleptAtMs: 55 * 60_000, timeToSleepMs: 55 * 60_000 }),
    );
    expect(qualifiesForStepBack(slow)).toBe(false);
  });

  it("does not count a night the listener said they were actually awake", () => {
    // A self-labelled false positive is the detector being wrong, not a good night.
    const nights = goodNights(STEPBACK_WINDOW).map((n) => ({ ...n, selfLabel: "awake" as const }));
    expect(qualifiesForStepBack(nights)).toBe(false);
  });

  it("only considers the most recent window, not a good patch from long ago", () => {
    const old = goodNights(STEPBACK_WINDOW);
    const recentBad = Array.from({ length: STEPBACK_WINDOW }, (_, i) =>
      night({ startedAt: 9_000_000 + i * DAY, sleptAtMs: null, timeToSleepMs: null }),
    );
    expect(qualifiesForStepBack([...old, ...recentBad])).toBe(false);
  });

  it("says no for an empty ledger", () => {
    expect(qualifiesForStepBack([])).toBe(false);
  });

  it("ignores daytime sessions that were never slept through", () => {
    // Listening at noon and staying awake records a night with sleptAtMs null.
    // Those must not drag a genuine good run below the ratio... but they also
    // must not be silently discarded, or a person who naps once a fortnight
    // would be told they are cured. They count as not-slept, which is honest.
    const mixed = goodNights(STEPBACK_WINDOW);
    mixed[0] = night({ startedAt: mixed[0].startedAt, sleptAtMs: null, timeToSleepMs: null });
    expect(qualifiesForStepBack(mixed)).toBe(true); // one miss is within tolerance
  });
});

describe("isQuiet", () => {
  it("is quiet before the expiry", () => {
    expect(isQuiet(5000, 4999)).toBe(true);
  });

  it("stops being quiet once the expiry passes", () => {
    expect(isQuiet(5000, 5001)).toBe(false);
  });

  it("is not quiet when nothing was ever set", () => {
    expect(isQuiet(null, 5000)).toBe(false);
  });
});

describe("quietUntilFrom", () => {
  it("is the configured number of days out", () => {
    expect(quietUntilFrom(0)).toBe(QUIET_DAYS * DAY);
  });
});
