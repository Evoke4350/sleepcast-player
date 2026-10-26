import { describe, it, expect, beforeEach } from "vitest";
import type { RestNight, SleepStage } from "./types";
import {
  parseWatchSamples, watchOnsetMs, withWatchOnset, applyWatchSamples, importWatchSleep,
  watchPayloadFromHash, describeImport, WATCH_WINDOW_MS, NIGHT_SPAN_MS, nightStages, summarizeStages,
} from "./watch";
import { appendNight, loadNights, isSlept, believableOnsetMs } from "./ledger";
import { learnedTimer } from "./learned-timer";
import { currentParams, watchCaughtFalsePositives } from "./calibrate";
import { DEFAULT_PARAMS } from "./detector";

const MIN = 60_000;
const START = Date.parse("2026-10-22T23:00:00-07:00");
const iso = (ms: number) => new Date(ms).toISOString();
const sample = (fromMin: number, toMin: number, value: string) => `${iso(START + fromMin * MIN)}|${iso(START + toMin * MIN)}|${value}`;

function night(over: Partial<RestNight> = {}): RestNight {
  return {
    startedAt: START, timerMinutes: 45, endedVia: "faded", sleptAtMs: 12 * MIN, timeToSleepMs: 12 * MIN,
    interactions: 1, detector: "inference", playedMs: 45 * MIN, ...over,
  };
}

describe("parseWatchSamples", () => {
  it("reads Shortcut text: start|end|value, joined by ; or newlines", () => {
    const s = parseWatchSamples([sample(0, 20, "In Bed"), sample(20, 50, "Core")].join(";") + "\n" + sample(50, 60, "Awake"));
    expect(s.map((x) => x.kind)).toEqual(["inbed", "asleep", "awake"]);
    expect(s[1].start).toBe(START + 20 * MIN);
  });
  it("keeps the stage itself", () => {
    const stages = ["In Bed", "Awake", "Core", "Deep", "REM", "Asleep (Unspecified)", "asleepREM"].map((v) => parseWatchSamples(sample(0, 1, v))[0].stage);
    expect(stages).toEqual(["inbed", "awake", "core", "deep", "rem", "asleep", "rem"]);
  });
  it("reads every asleep stage as asleep", () => {
    const kinds = ["Asleep", "Core", "Deep", "REM", "Asleep (Unspecified)", "asleepCore"].map((v) => parseWatchSamples(sample(0, 1, v))[0].kind);
    expect(new Set(kinds)).toEqual(new Set(["asleep"]));
  });
  it("skips what doesn't parse", () => {
    expect(parseWatchSamples("garbage;|;2026-13-99|x|Core;" + sample(10, 5, "Core"))).toEqual([]);
  });
});

describe("watchOnsetMs", () => {
  const s = (...xs: string[]) => parseWatchSamples(xs.join(";"));
  it("the first asleep sample after the night starts", () => {
    expect(watchOnsetMs(night(), s(sample(-30, 18, "Awake"), sample(18, 60, "Core"), sample(60, 90, "Deep")))).toBe(18 * MIN);
  });
  it("null when the watch watched and saw no sleep in the window", () => {
    expect(watchOnsetMs(night(), s(sample(0, 240, "Awake")))).toBeNull();
  });
  it("says nothing on In Bed alone: the phone's bedtime schedule writes that with no watch", () => {
    expect(watchOnsetMs(night(), s(sample(-10, 480, "In Bed")))).toBeUndefined();
  });
  it("says nothing with no samples in the window, or when already asleep well before play", () => {
    expect(watchOnsetMs(night(), s(sample(-600, -300, "Core")))).toBeUndefined();
    expect(watchOnsetMs(night(), s(sample(-60, 30, "Core")))).toBeUndefined();
  });
  it("an asleep sample just before play counts as asleep at the start", () => {
    expect(watchOnsetMs(night(), s(sample(-2, 30, "Core")))).toBe(0);
  });
  it("ignores sleep past the window", () => {
    expect(watchOnsetMs(night(), s(sample(0, 250, "Awake"), sample(WATCH_WINDOW_MS / MIN + 10, 300, "Core")))).toBeNull();
  });
});

describe("withWatchOnset", () => {
  const episodes = [
    { t: 0, feedId: "a", episodeId: "a1" },
    { t: 15 * MIN, feedId: "b", episodeId: "b1" },
    { t: 30 * MIN, feedId: "c", episodeId: "c1" },
  ];
  it("replaces the guess, keeps it, and credits what was playing at the watch's onset", () => {
    const n = withWatchOnset(night({ episodes, onsetFeedId: "a", onsetEpisodeId: "a1", onsetAfterMs: 12 * MIN, sleptThrough: ["b", "c"] }), 20 * MIN);
    expect(n).toMatchObject({ detector: "hr", sleptAtMs: 20 * MIN, timeToSleepMs: 20 * MIN, appSleptAtMs: 12 * MIN, watchSleptAfterMs: 20 * MIN });
    expect(n).toMatchObject({ onsetFeedId: "b", onsetEpisodeId: "b1", onsetAfterMs: 5 * MIN, sleptThrough: ["c"] });
  });
  it("asleep only after the audio stopped: not slept to it, but the time is kept", () => {
    const n = withWatchOnset(night({ episodes, onsetFeedId: "a" }), 70 * MIN);
    expect(n.sleptAtMs).toBeNull();
    expect(n.watchSleptAfterMs).toBe(70 * MIN);
    expect(n.onsetFeedId).toBeUndefined();
    expect(isSlept(n)).toBe(false);
  });
  it("is idempotent: matching twice keeps the detector's first guess", () => {
    const once = withWatchOnset(night(), 20 * MIN);
    expect(withWatchOnset(once, 20 * MIN)).toEqual(once);
  });
  it("an old night with no episode list keeps the detector's credit while slept", () => {
    const n = withWatchOnset(night({ onsetFeedId: "a", onsetEpisodeId: "a1", onsetAfterMs: 12 * MIN }), 20 * MIN);
    expect(n.onsetFeedId).toBe("a");
    expect("sleptThrough" in n).toBe(false);
  });
});

describe("what the watch changes", () => {
  it("time to sleep comes from the watch, with no detector floor", () => {
    const n = withWatchOnset(night(), 2 * MIN);
    expect(believableOnsetMs(n)).toBe(2 * MIN);
  });

  it("the learned timer learns from the watch, even nights that outlasted the timer", () => {
    const nights = [20, 25, 30, 35, 90].map((m, i) => withWatchOnset(night({ startedAt: START + i * 86_400_000 }), m * MIN));
    const t = learnedTimer(nights);
    expect(t).not.toBeNull();
    // 75th percentile of 20,25,30,35,90 = 35, + 10 margin = 45.
    expect(t!.minutes).toBe(45);
    expect(t!.usualMs).toBe(30 * MIN);
  });

  it("grades the detector: each night it called slept that the watch didn't halves alpha", () => {
    const caught = withWatchOnset(night(), null);
    const agreed = withWatchOnset(night(), 14 * MIN);
    expect(watchCaughtFalsePositives([caught, agreed, caught])).toBe(2);
    expect(currentParams(null, [caught, agreed, caught]).alpha).toBeCloseTo(DEFAULT_PARAMS.alpha / 4);
    expect(currentParams(null, [agreed]).alpha).toBe(DEFAULT_PARAMS.alpha);
  });
});

describe("importWatchSleep", () => {
  beforeEach(() => localStorage.clear());

  it("writes matched nights to the ledger and leaves the rest alone", () => {
    appendNight(night({ startedAt: START - 86_400_000 }));
    appendNight(night());
    const r = importWatchSleep([sample(0, 25, "Awake"), sample(25, 80, "Core")].join(";"));
    expect(r.ok && r.matched.length).toBe(1);
    const [older, last] = loadNights();
    expect(older.detector).toBe("inference");
    expect(last).toMatchObject({ detector: "hr", sleptAtMs: 25 * MIN, appSleptAtMs: 12 * MIN });
    expect(describeImport(r)).toBe("Matched your watch's sleep to 1 night. Your watch has you asleep 25 min in. Sleepcast guessed 12 min.");
    expect(describeImport(r, { brief: true })).toBe("Matched your watch's sleep to 1 night.");
  });

  it("says so when nothing came through, or nothing matched", () => {
    expect(importWatchSleep("").ok).toBe(false);
    const r = importWatchSleep(sample(0, 30, "Core"));
    expect(r).toEqual({ ok: true, matched: [] });
    expect(describeImport(r)).toContain("none of it overlaps");
  });

  it("applyWatchSamples is pure", () => {
    const ns = [night()];
    applyWatchSamples(ns, parseWatchSamples(sample(0, 30, "Core")));
    expect(ns[0].detector).toBe("inference");
  });
});

describe("watchPayloadFromHash", () => {
  it("reads #watch=, URL-encoded or not", () => {
    expect(watchPayloadFromHash("#watch=" + encodeURIComponent("a|b|Core;c|d|REM"))).toBe("a|b|Core;c|d|REM");
    expect(watchPayloadFromHash("#watch=a|b|Core")).toBe("a|b|Core");
    expect(watchPayloadFromHash("#other")).toBeNull();
    expect(watchPayloadFromHash("")).toBeNull();
  });
});

describe("nightStages", () => {
  const s = (...xs: string[]) => parseWatchSamples(xs.join(";"));
  it("keeps the stages, from night start, and leaves In Bed out", () => {
    expect(nightStages(night(), s(sample(-10, 480, "In Bed"), sample(5, 20, "Awake"), sample(20, 60, "Core"), sample(60, 90, "Deep"), sample(90, 110, "REM")))).toEqual([
      { from: 5 * MIN, to: 20 * MIN, stage: "awake" },
      { from: 20 * MIN, to: 60 * MIN, stage: "core" },
      { from: 60 * MIN, to: 90 * MIN, stage: "deep" },
      { from: 90 * MIN, to: 110 * MIN, stage: "rem" },
    ]);
  });
  it("clips to the night, and stops at the next night's start", () => {
    expect(nightStages(night(), s(sample(-30, 30, "Core"), sample(30, 200, "Core")), START + 100 * MIN)).toEqual([
      { from: 0, to: 100 * MIN, stage: "core" },
    ]);
    expect(nightStages(night(), s(sample(NIGHT_SPAN_MS / MIN + 10, NIGHT_SPAN_MS / MIN + 60, "Core")))).toEqual([]);
  });
  it("where sources overlap, the more specific stage shows", () => {
    expect(nightStages(night(), s(sample(0, 120, "Asleep"), sample(30, 60, "Deep"), sample(40, 45, "Awake")))).toEqual([
      { from: 0, to: 30 * MIN, stage: "asleep" },
      { from: 30 * MIN, to: 40 * MIN, stage: "deep" },
      { from: 40 * MIN, to: 45 * MIN, stage: "awake" },
      { from: 45 * MIN, to: 60 * MIN, stage: "deep" },
      { from: 60 * MIN, to: 120 * MIN, stage: "asleep" },
    ]);
  });
});

describe("summarizeStages", () => {
  const st = (from: number, to: number, stage: SleepStage) => ({ from: from * MIN, to: to * MIN, stage });
  it("asleep time by stage, and the wakings between falling asleep and waking", () => {
    const sum = summarizeStages([st(0, 15, "awake"), st(15, 60, "core"), st(60, 70, "awake"), st(70, 100, "deep"), st(100, 105, "awake"), st(105, 140, "rem"), st(140, 150, "awake")]);
    expect(sum).toEqual({
      asleepMs: 110 * MIN,
      byStage: { core: 45 * MIN, deep: 30 * MIN, rem: 35 * MIN },
      fellAsleepMs: 15 * MIN,
      wokeMs: 140 * MIN,
      awakeMs: 15 * MIN,
      wakings: 2,
      staged: true,
    });
  });
  it("unstaged from an older watch; null with no sleep", () => {
    expect(summarizeStages([st(0, 60, "asleep")])?.staged).toBe(false);
    expect(summarizeStages([st(0, 60, "awake")])).toBeNull();
  });
});

describe("applyWatchSamples keeps the night's stages", () => {
  it("stores them, and a second import replaces them", () => {
    const text = [sample(0, 20, "Awake"), sample(20, 300, "Core")].join(";");
    const once = applyWatchSamples([night()], parseWatchSamples(text)).nights;
    expect(once[0].watchSleep).toEqual([{ from: 0, to: 20 * MIN, stage: "awake" }, { from: 20 * MIN, to: 300 * MIN, stage: "core" }]);
    const twice = applyWatchSamples(once, parseWatchSamples(sample(0, 30, "Deep"))).nights;
    expect(twice[0].watchSleep).toEqual([{ from: 0, to: 30 * MIN, stage: "deep" }]);
  });
  it("a re-anchored night takes what's after its start; the one before stops there", () => {
    const later = night({ startedAt: START + 240 * MIN });
    const out = applyWatchSamples([night(), later], parseWatchSamples([sample(10, 230, "Core"), sample(235, 260, "Awake"), sample(260, 400, "Core")].join(";"))).nights;
    expect(out[0].watchSleep?.at(-1)).toEqual({ from: 235 * MIN, to: 240 * MIN, stage: "awake" });
    expect(out[1].watchSleep?.[0]).toEqual({ from: 0, to: 20 * MIN, stage: "awake" });
  });
});
