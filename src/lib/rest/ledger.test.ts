import { describe, it, expect, beforeEach } from "vitest";
import { loadNights, appendNight, rollup, setSelfLabel } from "./ledger";
import type { RestNight } from "./types";

const night = (over: Partial<RestNight> = {}): RestNight => ({
  startedAt: 1000, timerMinutes: 60, endedVia: "faded",
  sleptAtMs: 5 * 60_000, timeToSleepMs: 5 * 60_000,
  interactions: 1, detector: "inference", ...over,
});

describe("ledger", () => {
  beforeEach(() => localStorage.clear());

  it("append then load round-trips", () => {
    appendNight(night());
    expect(loadNights()).toHaveLength(1);
    expect(loadNights()[0].timeToSleepMs).toBe(300000);
  });

  it("keeps at most 90 nights, newest last", () => {
    for (let i = 0; i < 95; i++) appendNight(night({ startedAt: i }));
    const n = loadNights();
    expect(n).toHaveLength(90);
    expect(n[n.length - 1].startedAt).toBe(94);
    expect(n[0].startedAt).toBe(5);
  });

  it("rollup: best is the minimum time-to-sleep, median is robust", () => {
    // Fixture values raised above MIN_PLAUSIBLE_ONSET_MS. The original used a
    // 2-minute onset, which the fixed detector cannot produce — onset is now
    // anchored at the decision bound, unreachable in under ~7 minutes of
    // quiet. This still exercises exactly what it did before, the min and
    // median arithmetic, using figures the system can actually emit.
    const r = rollup([night({ timeToSleepMs: 600000 }), night({ timeToSleepMs: 480000 }), night({ sleptAtMs: null, timeToSleepMs: null })]);
    expect(r.nights).toBe(3);
    expect(r.nightsSlept).toBe(2);           // one had null sleptAtMs
    expect(r.bestTimeToSleepMs).toBe(480000); // fastest to leave
    expect(r.medianTimeToSleepMs).toBe(540000); // median of [480000,600000]
  });

  it("rollup: avgInteractions7 uses trailing 7 nights", () => {
    const many = Array.from({ length: 10 }, (_, i) => night({ startedAt: i, interactions: i }));
    // trailing 7 = interactions 3..9 => mean 6
    expect(rollup(many).avgInteractions7).toBe(6);
  });

  it("setSelfLabel tags the matching night", () => {
    appendNight(night({ startedAt: 42 }));
    const updated = setSelfLabel(42, "awake");
    expect(updated?.selfLabel).toBe("awake");
    expect(loadNights()[0].selfLabel).toBe("awake");
  });
});

describe("rollup ignores pre-fix onset artifacts", () => {
  const n = (over: Partial<RestNight> = {}): RestNight => ({
    startedAt: 1, timerMinutes: 45, endedVia: "faded",
    sleptAtMs: 9 * 60_000, timeToSleepMs: 9 * 60_000,
    interactions: 0, detector: "inference", ...over,
  });

  it("does not let a bogus one-minute night become your 'fastest'", () => {
    // Before the detector fix, onset was pinned to the first quiet tick, so
    // untouched nights recorded ~0ms. Those values are unreachable now.
    const r = rollup([n({ timeToSleepMs: 0, sleptAtMs: 0 }), n(), n()]);
    expect(r.bestTimeToSleepMs).toBe(9 * 60_000);
  });

  it("still counts those nights as slept — only the figure was wrong", () => {
    const r = rollup([n({ timeToSleepMs: 0, sleptAtMs: 0 }), n(), n()]);
    expect(r.nightsSlept).toBe(3);
  });

  it("returns null rather than a lie when every night is an artifact", () => {
    const r = rollup([n({ timeToSleepMs: 0, sleptAtMs: 0 })]);
    expect(r.bestTimeToSleepMs).toBeNull();
    expect(r.medianTimeToSleepMs).toBeNull();
  });
});
