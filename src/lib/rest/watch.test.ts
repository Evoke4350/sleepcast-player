import { describe, it, expect, beforeEach } from "vitest";
import {
  parseWatchPayload,
  watchOnset,
  retimed,
  applyWatch,
  importWatch,
  watchPayloadFromHash,
  watchNotice,
  watchAgreement,
  payloadFromPaste,
  MATCH_WINDOW_MS,
  type SleepSample,
} from "./watch";
import { appendNight, loadNights, rollup } from "./ledger";
import type { RestNight } from "./types";

const MIN = 60_000;
const START = Date.parse("2026-10-05T23:00:00-07:00");

function night(over: Partial<RestNight> = {}): RestNight {
  return {
    startedAt: START,
    endedAt: START + 60 * MIN,
    timerMinutes: 60,
    endedVia: "faded",
    sleptAtMs: 30 * MIN,
    timeToSleepMs: 30 * MIN,
    interactions: 2,
    detector: "inference",
    ...over,
  };
}
const asleepAt = (ms: number): SleepSample => ({ start: START + ms, asleep: true });
const awakeAt = (ms: number): SleepSample => ({ start: START + ms, asleep: false });

describe("parseWatchPayload", () => {
  it("reads start~end~stage lines, asleep by stage", () => {
    const { samples, unrecognised } = parseWatchPayload(
      [
        "2026-10-05T23:05:00-07:00~2026-10-05T23:20:00-07:00~In Bed",
        "2026-10-05T23:20:00-07:00~2026-10-05T23:40:00-07:00~Awake",
        "2026-10-05T23:40:00-07:00~2026-10-06T00:10:00-07:00~Core",
        "2026-10-06T00:10:00-07:00~2026-10-06T00:40:00-07:00~Deep",
        "2026-10-06T00:40:00-07:00~2026-10-06T01:00:00-07:00~REM",
        "2026-10-06T01:00:00-07:00~2026-10-06T02:00:00-07:00~Asleep",
      ].join("\n"),
    );
    expect(unrecognised).toBe(0);
    expect(samples.map((s) => s.asleep)).toEqual([false, false, true, true, true, true]);
    expect(samples[2].start).toBe(START + 40 * MIN);
  });

  it("skips malformed lines and counts stages it doesn't know", () => {
    const { samples, unrecognised } = parseWatchPayload(
      [
        "",
        "nonsense",
        "2026-10-05~2026-10-05~Core", // no time of day
        "not-a-date T~x~Core",
        "2026-10-05T23:40:00-07:00~2026-10-06T00:10:00-07:00~Au lit", // localised
        "2026-10-05T23:40:00-07:00~2026-10-06T00:10:00-07:00~Core\r",
      ].join("\n"),
    );
    expect(samples).toEqual([{ start: START + 40 * MIN, asleep: true }]);
    expect(unrecognised).toBe(1);
  });

  it("reads Health's numeric stage codes too", () => {
    const line = (code: string) => `2026-10-05T23:40:00-07:00~2026-10-06T00:10:00-07:00~${code}`;
    const { samples, unrecognised } = parseWatchPayload(["0", "1", "2", "3", "4", "5", "9"].map(line).join("\n"));
    expect(samples.map((s) => s.asleep)).toEqual([false, true, false, true, true, true]);
    expect(unrecognised).toBe(1);
  });
});

describe("watchOnset", () => {
  it("is the first asleep sample inside the night, from its start", () => {
    expect(watchOnset(START, [awakeAt(5 * MIN), asleepAt(25 * MIN), asleepAt(18 * MIN)])).toBe(18 * MIN);
  });
  it("ignores sleep before the night began, past the window, or in the next night", () => {
    expect(watchOnset(START, [asleepAt(-10 * MIN)])).toBeNull();
    expect(watchOnset(START, [asleepAt(MATCH_WINDOW_MS)])).toBeNull();
    expect(watchOnset(START, [asleepAt(90 * MIN)], START + 60 * MIN)).toBeNull();
  });
  it("counts an onset at the very start", () => {
    expect(watchOnset(START, [asleepAt(0)])).toBe(0);
  });
});

describe("retimed", () => {
  const timeline = [
    { t: 0, feedId: "a", episodeId: "a1" },
    { t: 20 * MIN, feedId: "b", episodeId: "b1" },
    { t: 40 * MIN, feedId: "c", episodeId: "c1" },
  ];

  it("takes the watch's onset, keeps the detector's to compare, and re-attributes from the timeline", () => {
    const n = retimed(night({ timeline, onsetFeedId: "b", onsetEpisodeId: "b1", onsetAfterMs: 10 * MIN, sleptThrough: ["c"] }), 12 * MIN);
    expect(n).toMatchObject({ sleptAtMs: 12 * MIN, timeToSleepMs: 12 * MIN, detector: "watch", inferredAtMs: 30 * MIN });
    expect(n.onsetFeedId).toBe("a");
    expect(n.onsetEpisodeId).toBe("a1");
    expect(n.onsetAfterMs).toBe(12 * MIN);
    expect(n.sleptThrough).toEqual(["b", "c"]);
  });

  it("records a night the detector couldn't time", () => {
    const n = retimed(night({ sleptAtMs: null, timeToSleepMs: null, detector: "none", timeline }), 25 * MIN);
    expect(n).toMatchObject({ timeToSleepMs: 25 * MIN, detector: "watch", inferredAtMs: null, onsetFeedId: "b" });
  });

  it("credits nothing when the onset came after the night ended", () => {
    const n = retimed(night({ timeline }), 70 * MIN);
    expect(n.timeToSleepMs).toBe(70 * MIN);
    expect(n).not.toHaveProperty("onsetFeedId");
    expect(n).not.toHaveProperty("sleptThrough");
  });

  it("drops the detector's attribution with no timeline to redo it", () => {
    const n = retimed(night({ onsetFeedId: "b", onsetAfterMs: 5 * MIN, sleptThrough: ["c"] }), 12 * MIN);
    expect(n).not.toHaveProperty("onsetFeedId");
    expect(n).not.toHaveProperty("onsetAfterMs");
    expect(n).not.toHaveProperty("sleptThrough");
  });

  it("is idempotent: a re-import keeps the detector's original onset and the watch's attribution", () => {
    const once = retimed(night({ onsetFeedId: "b", timeline }), 12 * MIN);
    const { timeline: _t, ...pruned } = once;
    const twice = retimed(pruned, 12 * MIN);
    expect(twice.inferredAtMs).toBe(30 * MIN);
    expect(twice.onsetFeedId).toBe("a");
    expect(twice.sleptThrough).toEqual(["b", "c"]);
  });

  it("drops a self-label, which was on the detector's claim", () => {
    expect(retimed(night({ selfLabel: "awake" }), 12 * MIN)).not.toHaveProperty("selfLabel");
  });
});

describe("applyWatch", () => {
  it("times each night by its own samples, the rest unchanged, order kept", () => {
    const second = night({ startedAt: START + 3 * 60 * MIN, endedAt: START + 4 * 60 * MIN });
    const other = night({ startedAt: START - 24 * 60 * MIN });
    const { nights, timed } = applyWatch([other, night(), second], [asleepAt(15 * MIN), asleepAt(3 * 60 * MIN + 5 * MIN)]);
    expect(nights[0]).toBe(other);
    expect(nights[1].timeToSleepMs).toBe(15 * MIN);
    expect(nights[2].timeToSleepMs).toBe(5 * MIN);
    expect(timed.map((t) => t.atMs)).toEqual([15 * MIN, 5 * MIN]);
    expect(timed[0].inferredAtMs).toBe(30 * MIN);
  });
});

describe("importWatch", () => {
  beforeEach(() => localStorage.clear());

  it("re-times the stored night, and the headline counts a fast watch onset", () => {
    appendNight(night());
    const r = importWatch("2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core");
    expect(r).toEqual({ timed: [{ startedAt: START, atMs: 4 * MIN, inferredAtMs: 30 * MIN }], samples: 1, unrecognised: 0 });
    expect(loadNights()[0].detector).toBe("watch");
    // 4 min is under the detector's plausibility floor; a watch onset is measured.
    expect(rollup(loadNights()).bestTimeToSleepMs).toBe(4 * MIN);
  });

  it("leaves storage alone when nothing parses", () => {
    appendNight(night());
    expect(importWatch("garbage")).toEqual({ timed: [], samples: 0, unrecognised: 0 });
    expect(loadNights()[0].detector).toBe("inference");
  });
});

describe("watchPayloadFromHash", () => {
  it("decodes a #watch= fragment, and ignores any other", () => {
    expect(watchPayloadFromHash("#watch=a~b~Core%0Ac~d~REM")).toBe("a~b~Core\nc~d~REM");
    expect(watchPayloadFromHash("#other")).toBeNull();
    expect(watchPayloadFromHash("")).toBeNull();
    expect(watchPayloadFromHash("#watch=%E0%A4%A")).toBeNull();
  });
});

describe("payloadFromPaste", () => {
  it("takes the lines, or the payload out of a whole link", () => {
    expect(payloadFromPaste("  a~b~Core\n")).toBe("a~b~Core");
    expect(payloadFromPaste("https://sleepcast.pro/#watch=a~b~Core%0Ac~d~REM")).toBe("a~b~Core\nc~d~REM");
  });
});

describe("watchNotice", () => {
  const t = (atMs: number, inferredAtMs: number | null) => ({ startedAt: START, atMs, inferredAtMs });
  it("says what the import did", () => {
    expect(watchNotice({ timed: [t(12 * MIN, 30 * MIN)], samples: 3, unrecognised: 0 })).toBe(
      "your watch: asleep 12 min in; sleepcast guessed 30 min.",
    );
    expect(watchNotice({ timed: [t(5 * MIN, null), t(12 * MIN, null)], samples: 3, unrecognised: 0 })).toBe(
      "your watch timed 2 nights. the latest: asleep 12 min in.",
    );
    expect(watchNotice({ timed: [], samples: 3, unrecognised: 0 })).toMatch(/didn't start inside/);
    expect(watchNotice({ timed: [], samples: 0, unrecognised: 0 })).toMatch(/sleep tracking/);
    expect(watchNotice({ timed: [], samples: 0, unrecognised: 4 })).toMatch(/english only/);
  });
});

describe("watchAgreement", () => {
  it("is the median gap between the detector's guess and the watch", () => {
    const a = watchAgreement([
      night({ detector: "watch", sleptAtMs: 10 * MIN, inferredAtMs: 20 * MIN }),
      night({ detector: "watch", sleptAtMs: 30 * MIN, inferredAtMs: 26 * MIN }),
      night({ detector: "watch", sleptAtMs: 15 * MIN, inferredAtMs: null }),
      night(),
    ]);
    expect(a).toEqual({ watchNights: 3, compared: 2, medianOffMs: 7 * MIN });
  });
  it("has nothing to compare without watch nights the detector also timed", () => {
    expect(watchAgreement([night()])).toEqual({ watchNights: 0, compared: 0, medianOffMs: null });
  });
});
