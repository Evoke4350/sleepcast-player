import { describe, it, expect, beforeEach } from "vitest";
import { shouldGreetGoodbye, fmtDuration, markGoodbyeSeen } from "./surface";
import { appendNight } from "./ledger";
import type { RestNight } from "./types";

const night = (over: Partial<RestNight> = {}): RestNight => ({
  startedAt: 1000, timerMinutes: 60, endedVia: "faded",
  sleptAtMs: 300000, timeToSleepMs: 300000, interactions: 1, detector: "inference", ...over,
});

describe("surface", () => {
  beforeEach(() => localStorage.clear());

  it("fmtDuration renders minutes", () => {
    expect(fmtDuration(300000)).toBe("5 min");
    expect(fmtDuration(90000)).toBe("2 min");
  });

  it("greets goodbye once for a slept night, then not again", () => {
    appendNight(night({ startedAt: 5000, sleptAtMs: 240000 }));
    const g = shouldGreetGoodbye(9_999_999);
    expect(g?.startedAt).toBe(5000);
    markGoodbyeSeen(5000);
    expect(shouldGreetGoodbye(9_999_999)).toBeNull();
  });

  it("does not greet if the last night was not detected as slept", () => {
    appendNight(night({ startedAt: 6000, sleptAtMs: null, timeToSleepMs: null }));
    expect(shouldGreetGoodbye(9_999_999)).toBeNull();
  });
});
