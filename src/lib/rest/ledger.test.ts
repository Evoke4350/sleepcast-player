import { describe, it, expect, beforeEach } from "vitest";
import { loadNights, appendNight, rollup, setSelfLabel, leanComparison, MIN_PLAUSIBLE_ONSET_MS, PRE_FIX_BEFORE_MS } from "./ledger";
import { DEFAULT_PARAMS, LAMBDA_MAX, quietTicksToDecide, TICK_MS } from "./detector";
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

describe("rollup and self-labels", () => {
  // "I was awake" means the detector was wrong about that night. stepback.ts
  // and scoreFeeds already discard such nights; the headline stats did not,
  // so telling the app it was wrong still counted the night as slept and fed
  // its bogus onset into "fastest" and "usually".
  it("does not count a night the listener marked awake as slept", () => {
    const r = rollup([
      night({ timeToSleepMs: 600_000, sleptAtMs: 600_000 }),
      night({ timeToSleepMs: 420_000, sleptAtMs: 420_000, selfLabel: "awake" }),
    ]);
    expect(r.nights).toBe(2);
    expect(r.nightsSlept).toBe(1);
    expect(r.bestTimeToSleepMs).toBe(600_000);
    expect(r.medianTimeToSleepMs).toBe(600_000);
  });
});

describe("MIN_PLAUSIBLE_ONSET_MS", () => {
  // The floor assumed the default interaction rate (~30 ticks to decide).
  // Calibration can raise the rate to LAMBDA_MAX, where a real onset is
  // reached in a handful of ticks, so those real fast nights were hidden.
  it("is no higher than the fastest onset the detector can report", () => {
    const fastest = (quietTicksToDecide({ ...DEFAULT_PARAMS, lambdaAwake: LAMBDA_MAX }) - 1) * TICK_MS;
    expect(MIN_PLAUSIBLE_ONSET_MS).toBeLessThanOrEqual(fastest);
  });

  it("still filters the pre-fix one-minute artifacts", () => {
    expect(MIN_PLAUSIBLE_ONSET_MS).toBeGreaterThan(60_000);
  });
});

describe("rollup floor for nights recorded before the detector fix", () => {
  // Pre-fix onsets were anchored at the first quiet tick after the last touch,
  // so they can land anywhere below ~7 min, not only near zero. The derived
  // floor is right for nights the fixed detector recorded; older nights keep
  // the old one.
  it("keeps the 7-minute floor for nights started before the fix shipped", () => {
    const old = night({ startedAt: PRE_FIX_BEFORE_MS - 1, timeToSleepMs: 3 * 60_000, sleptAtMs: 3 * 60_000 });
    expect(rollup([old]).bestTimeToSleepMs).toBeNull();
  });

  it("uses the derived floor for nights after it", () => {
    const fresh = night({ startedAt: PRE_FIX_BEFORE_MS + 1, timeToSleepMs: 3 * 60_000, sleptAtMs: 3 * 60_000 });
    expect(rollup([fresh]).bestTimeToSleepMs).toBe(3 * 60_000);
  });
});

describe("leanComparison", () => {
  it("is nothing until a night leaned and either side has a timed night", () => {
    expect(leanComparison([night(), night()])).toBeNull();
    expect(leanComparison([night({ shuffle: "leaned", sleptAtMs: null, timeToSleepMs: null })])).toBeNull();
  });
  it("splits typical time to sleep by whether the shuffle leaned", () => {
    const c = leanComparison([
      night({ shuffle: "leaned", sleptAtMs: 20 * 60_000, timeToSleepMs: 20 * 60_000 }),
      night({ shuffle: "leaned", sleptAtMs: null, timeToSleepMs: null }), // no time: not counted
      night({ sleptAtMs: 40 * 60_000, timeToSleepMs: 40 * 60_000 }),
      night({ sleptAtMs: 30 * 60_000, timeToSleepMs: 30 * 60_000 }),
    ])!;
    expect(c.leaned).toEqual({ nights: 1, medianMs: 20 * 60_000 });
    expect(c.plain).toEqual({ nights: 2, medianMs: 35 * 60_000 });
  });
  it("shows with an untimed leaned side when the other side is timed", () => {
    const c = leanComparison([
      night({ shuffle: "leaned", sleptAtMs: null, timeToSleepMs: null }),
      night({ sleptAtMs: 30 * 60_000, timeToSleepMs: 30 * 60_000 }),
    ]);
    expect(c).toEqual({ leaned: { nights: 0, medianMs: null }, plain: { nights: 1, medianMs: 30 * 60_000 } });
  });
});
