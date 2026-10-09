import { describe, it, expect, beforeEach } from "vitest";
import { loadNights, appendNight, rollup, setSelfLabel, leanComparison, pruneTimelines, offerForLabel, lastOf, newestByStart, withNight, MIN_PLAUSIBLE_ONSET_MS, PRE_FIX_BEFORE_MS, TIMELINE_KEEP_MS } from "./ledger";
import { DEFAULT_PARAMS, LAMBDA_MAX, quietTicksToDecide, TICK_MS } from "./detector";
import type { RestNight } from "./types";
import { onsetAfterEnd } from "./attribution";

const night = (over: Partial<RestNight> = {}): RestNight => ({
  startedAt: 1000, timerMinutes: 60, endedVia: "faded",
  sleptAtMs: 5 * 60_000, timeToSleepMs: 5 * 60_000,
  interactions: 1, detector: "inference", ...over,
});

describe("ledger", () => {
  beforeEach(() => localStorage.clear());

  it("append then load round-trips", () => {
    appendNight(night(), Date.now());
    expect(loadNights()).toHaveLength(1);
    expect(loadNights()[0].timeToSleepMs).toBe(300000);
  });

  it("keeps at most 90 nights, newest last", () => {
    for (let i = 0; i < 95; i++) appendNight(night({ startedAt: i }), Date.now());
    const n = loadNights();
    expect(n).toHaveLength(90);
    expect(n[n.length - 1].startedAt).toBe(94);
    expect(n[0].startedAt).toBe(5);
  });

  it("evicts the oldest by start, not the first recorded", () => {
    for (let i = 10; i < 100; i++) appendNight(night({ startedAt: i }), Date.now());
    // Recorded last, but the oldest: it is the one that goes.
    appendNight(night({ startedAt: 1 }), Date.now());
    const n = loadNights();
    expect(n).toHaveLength(90);
    expect(n.some((x) => x.startedAt === 1)).toBe(false);
    expect(n.some((x) => x.startedAt === 10)).toBe(true);
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
    appendNight(night({ startedAt: 42 }), Date.now());
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
    expect(c.leaned).toEqual({ timedNights: 1, medianMs: 20 * 60_000 });
    expect(c.plain).toEqual({ timedNights: 2, medianMs: 35 * 60_000 });
  });
  it("shows with an untimed leaned side when the other side is timed", () => {
    const c = leanComparison([
      night({ shuffle: "leaned", sleptAtMs: null, timeToSleepMs: null }),
      night({ sleptAtMs: 30 * 60_000, timeToSleepMs: 30 * 60_000 }),
    ]);
    expect(c).toEqual({ leaned: { timedNights: 0, medianMs: null }, plain: { timedNights: 1, medianMs: 30 * 60_000 } });
  });
  it("leaves out what the headline median does: an 'awake' night and an implausibly fast onset", () => {
    const tooFast = MIN_PLAUSIBLE_ONSET_MS - 1;
    const c = leanComparison([
      night({ shuffle: "leaned", sleptAtMs: 20 * 60_000, timeToSleepMs: 20 * 60_000 }),
      night({ shuffle: "leaned", sleptAtMs: 5 * 60_000, timeToSleepMs: 5 * 60_000, selfLabel: "awake" }),
      night({ sleptAtMs: 30 * 60_000, timeToSleepMs: 30 * 60_000 }),
      night({ sleptAtMs: tooFast, timeToSleepMs: tooFast }),
    ])!;
    expect(c.leaned).toEqual({ timedNights: 1, medianMs: 20 * 60_000 });
    expect(c.plain).toEqual({ timedNights: 1, medianMs: 30 * 60_000 });
  });
});

describe("timelines", () => {
  beforeEach(() => localStorage.clear());
  const timeline = [{ t: 0, feedId: "a", episodeId: "a1" }];
  const at = (startedAt: number): RestNight => ({
    startedAt, timerMinutes: 60, endedVia: "faded", sleptAtMs: null, timeToSleepMs: null,
    interactions: 0, detector: "none", timeline,
  });

  it("are kept for TIMELINE_KEEP_MS, then dropped", () => {
    const now = 100 * TIMELINE_KEEP_MS;
    const [old, recent] = pruneTimelines([at(now - TIMELINE_KEEP_MS - 1), at(now - TIMELINE_KEEP_MS)], now);
    expect(old).not.toHaveProperty("timeline");
    expect(recent.timeline).toEqual(timeline);
  });

  it("are pruned as each night is appended", () => {
    appendNight(at(0), 0);
    appendNight(at(TIMELINE_KEEP_MS + 1), TIMELINE_KEEP_MS + 1); // pruned against now
    const [first, second] = loadNights();
    expect(first).not.toHaveProperty("timeline");
    expect(second.timeline).toEqual(timeline);
  });
});

describe("offerForLabel", () => {
  const n = (over: Partial<RestNight>): RestNight => ({
    startedAt: 0, timerMinutes: 60, endedVia: "faded", sleptAtMs: 600_000, timeToSleepMs: 600_000,
    interactions: 0, detector: "inference", ...over,
  });
  it("asks about the detector's unconfirmed onset, never a watch's", () => {
    expect(offerForLabel(n({}))).toBe(true);
    expect(offerForLabel(n({ selfLabel: "slept" }))).toBe(false);
    expect(offerForLabel(n({ sleptAtMs: null, timeToSleepMs: null, detector: "none" }))).toBe(false);
    expect(offerForLabel(n({ detector: "watch" }))).toBe(false);
  });
});

describe("onsetAfterEnd", () => {
  const n: RestNight = { startedAt: 1000, endedAt: 1000 + 600_000, timerMinutes: 10, endedVia: "faded", sleptAtMs: null, timeToSleepMs: null, interactions: 0, detector: "none" };
  it("is whether the onset came after the night ended, unknown being no", () => {
    expect(onsetAfterEnd(n, 600_000)).toBe(false);
    expect(onsetAfterEnd(n, 600_001)).toBe(true);
    expect(onsetAfterEnd({ ...n, endedAt: undefined }, 10 ** 9)).toBe(false);
  });
});

describe("setSelfLabel and watch nights", () => {
  beforeEach(() => localStorage.clear());
  it("won't label a watch-timed night", () => {
    appendNight({ startedAt: 5, timerMinutes: 60, endedVia: "faded", sleptAtMs: 60_000, timeToSleepMs: 60_000, interactions: 0, detector: "watch" }, Date.now());
    expect(setSelfLabel(5, "awake")).toBeNull();
    expect(loadNights()[0]).not.toHaveProperty("selfLabel");
  });
});

describe("setSelfLabel when storage is full", () => {
  beforeEach(() => localStorage.clear());
  it("returns null: the label didn't take", () => {
    appendNight({ startedAt: 7, timerMinutes: 60, endedVia: "faded", sleptAtMs: 60_000, timeToSleepMs: 60_000, interactions: 0, detector: "inference" }, Date.now());
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      expect(setSelfLabel(7, "awake")).toBeNull();
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });
});

describe("lastOf", () => {
  const n = (startedAt: number): RestNight => ({ startedAt, timerMinutes: 60, endedVia: "faded", sleptAtMs: null, timeToSleepMs: null, interactions: 0, detector: "none" });
  it("is the newest by start, whatever the recording order", () => {
    expect(lastOf([n(3), n(1), n(2)])?.startedAt).toBe(3);
    expect(lastOf([])).toBeNull();
    expect(newestByStart([n(1), n(2)], 0)).toEqual([]);
  });
});

describe("saveNights over the cap", () => {
  beforeEach(() => localStorage.clear());
  it("drops the earliest-started, not the first recorded", () => {
    const n = (startedAt: number): RestNight => ({ startedAt, timerMinutes: 60, endedVia: "faded", sleptAtMs: null, timeToSleepMs: null, interactions: 0, detector: "none" });
    // 90 nights from 100 on, then one recorded late that started at 50.
    for (let i = 0; i < 90; i++) appendNight(n(100 + i), 0);
    appendNight(n(50), 0);
    const starts = loadNights().map((x) => x.startedAt);
    expect(starts).toHaveLength(90);
    expect(starts).not.toContain(50);
    expect(starts).toContain(100);
  });
});

describe("withNight and a night already there twice", () => {
  it("collapses every copy into one, keeping the watch's time", () => {
    const base: RestNight = { startedAt: 9, timerMinutes: 60, endedVia: "faded", sleptAtMs: null, timeToSleepMs: null, interactions: 0, detector: "none" };
    const watched = { ...base, detector: "watch" as const, sleptAtMs: 60_000, timeToSleepMs: 60_000, inferredAtMs: null };
    const other: RestNight = { ...base, startedAt: 10 };
    const out = withNight([base, other, watched], { ...base, interactions: 5 });
    expect(out.map((x) => x.startedAt)).toEqual([9, 10]);
    expect(out[0]).toMatchObject({ detector: "watch", sleptAtMs: 60_000, interactions: 5 });
  });
});

describe("labels and merges with a night recorded twice", () => {
  beforeEach(() => localStorage.clear());
  const n = (over: Partial<RestNight> = {}): RestNight => ({ startedAt: 11, timerMinutes: 60, endedVia: "faded", sleptAtMs: 600_000, timeToSleepMs: 600_000, interactions: 0, detector: "inference", ...over });
  it("setSelfLabel labels every copy, so the one offered is labelled", () => {
    localStorage.setItem("sleepcast2.rest", JSON.stringify([n(), n({ interactions: 3 })]));
    expect(setSelfLabel(11, "slept")?.interactions).toBe(3);
    expect(loadNights().every((x) => x.selfLabel === "slept")).toBe(true);
  });
  it("withNight keeps the watched copy's guess, timeline and credit when the new copy has none", () => {
    const timeline = [{ t: 0, feedId: "a", episodeId: "a1" }];
    const watched = n({ detector: "watch", sleptAtMs: 300_000, timeToSleepMs: 300_000, inferredAtMs: 600_000, timeline, onsetFeedId: "a", onsetEpisodeId: "a1", onsetAfterMs: 300_000 });
    const [merged] = withNight([watched], n({ detector: "none", sleptAtMs: null, timeToSleepMs: null }));
    expect(merged).toMatchObject({ detector: "watch", sleptAtMs: 300_000, inferredAtMs: 600_000, onsetFeedId: "a", timeline });
  });
});

describe("loadNights and copies of a night", () => {
  beforeEach(() => localStorage.clear());
  const n = (over: Partial<RestNight> = {}): RestNight => ({ startedAt: 21, timerMinutes: 60, endedVia: "faded", sleptAtMs: null, timeToSleepMs: null, interactions: 0, detector: "none", ...over });
  it("reads them as one, so every reader counts the night once", () => {
    localStorage.setItem("sleepcast2.rest", JSON.stringify([n(), n({ startedAt: 22 }), n({ interactions: 2 })]));
    expect(loadNights().map((x) => [x.startedAt, x.interactions])).toEqual([[21, 2], [22, 0]]);
  });
  it("of two watch-timed copies, keeps the later's time", () => {
    const w = (at: number) => n({ detector: "watch", sleptAtMs: at, timeToSleepMs: at, inferredAtMs: null });
    localStorage.setItem("sleepcast2.rest", JSON.stringify([w(20 * 60_000), w(12 * 60_000)]));
    expect(loadNights()[0].sleptAtMs).toBe(12 * 60_000);
  });
});
