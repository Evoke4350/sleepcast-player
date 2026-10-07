import { describe, it, expect, beforeEach } from "vitest";
import {
  parseWatchPayload,
  watchOnset,
  applyWatch,
  importWatch,
  watchPayloadFromHash,
  watchNotice,
  watchAgreement,
  payloadFromPaste,
  MATCH_WINDOW_MS,
  MAX_SAMPLES,
  sleepStretches,
  type SleepSample,
} from "./watch";
import { appendNight, loadNights, rollup } from "./ledger";
import { retimed } from "./attribution";
import type { RestNight } from "./types";

const MIN = 60_000;
/** An import's flags, all clear. */
const FLAGS = { unsaved: false, noWindow: false, badWindow: false };
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
const asleepAt = (ms: number, forMs = 5 * MIN): SleepSample => ({ start: START + ms, end: START + ms + forMs, asleep: true });
const awakeAt = (ms: number, forMs = 5 * MIN): SleepSample => ({ start: START + ms, end: START + ms + forMs, asleep: false });
/** Where a payload's window opens, well before the night. */
const WINDOW = START - 12 * 60 * MIN;
const OPENS_LINE = "window~2026-10-05T11:00:00-07:00";

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

  it("skips malformed lines and counts them, and stages it doesn't know", () => {
    const { samples, unrecognised, malformed } = parseWatchPayload(
      [
        "",
        "nonsense",
        "2026-10-05~2026-10-05~Core", // no time of day
        "not-a-date T~x~Core",
        "2026-10-05T23:40:00-07:00~2026-10-06T00:10:00-07:00~Au lit", // localised
        "2026-10-05T23:40:00-07:00~2026-10-06T00:10:00-07:00~Core\r",
      ].join("\n"),
    );
    expect(samples).toEqual([{ start: START + 40 * MIN, end: START + 70 * MIN, asleep: true }]);
    expect(unrecognised).toBe(1);
    expect(malformed).toBe(3);
  });

  it("matches whole stage names, so a localised name isn't half-read", () => {
    const line = (stage: string) => `2026-10-05T23:40:00-07:00~2026-10-06T00:10:00-07:00~${stage}`;
    const english = parseWatchPayload(["Asleep (Core)", "REM Sleep", "In Bed", "asleepUnspecified"].map(line).join("\n"));
    expect(english.samples.map((s) => s.asleep)).toEqual([true, true, false, true]);
    const german = parseWatchPayload(["Kern", "Tief", "REM-Schlaf", "Wach", "Im Bett"].map(line).join("\n"));
    expect(german).toMatchObject({ samples: [], unrecognised: 5 });
    // Accents and other scripts are a language too, not a malformed line.
    expect(parseWatchPayload(["Éveillé", "コア", "Paradoxal", "गहरी नींद", "หลับลึก"].map(line).join("\n"))).toMatchObject({
      samples: [],
      unrecognised: 5,
      malformed: 0,
    });
    // Nor an inherited key, from a link anyone can write.
    expect(parseWatchPayload(["constructor", "__proto__", "toString"].map(line).join("\n"))).toMatchObject({ samples: [], unrecognised: 3 });
  });

  it("counts an empty stage, or a date whose only T is a word's, as malformed, not foreign", () => {
    const r = parseWatchPayload(
      [
        // Lines run together (no url-encode step): a date in the stage.
        "2026-10-05T23:40:00-07:00~2026-10-06T00:10:00-07:00~Core2026-10-06T00:10:00-07:00~2026-10-06T00:40:00-07:00~Deep",
        "2026-10-05T23:40:00-07:00~2026-10-06T00:10:00-07:00~",
        "2026-10-05T23:40:00-07:00~2026-10-06T00:10:00-07:00~ - ",
        "Tuesday, October 5, 2026~Tuesday, October 5, 2026~Core",
      ].join("\n"),
    );
    expect(r).toMatchObject({ samples: [], unrecognised: 0, malformed: 4 });
  });

  it("counts an end that doesn't parse, lacks a time, or comes first as malformed", () => {
    const r = parseWatchPayload(
      [
        "2026-10-05T23:40:00-07:00~nope~Core",
        "2026-10-05T23:40:00-07:00~2026-10-05~Core",
        "2026-10-05T23:40:00-07:00~2026-10-05T23:00:00-07:00~Core",
      ].join("\n"),
    );
    expect(r).toMatchObject({ samples: [], malformed: 3 });
  });

  it("reads the window line first, and flags one whose date doesn't read", () => {
    const body = "2026-10-05T23:40:00-07:00~2026-10-06T00:10:00-07:00~Core";
    expect(parseWatchPayload(`window~2026-10-04T08:00:00-07:00\n${body}`)).toMatchObject({
      windowStart: Date.parse("2026-10-04T08:00:00-07:00"),
      malformed: 0,
    });
    expect(parseWatchPayload(body).windowStart).toBeNull();
    expect(parseWatchPayload(`window~yesterday\n${body}`)).toMatchObject({ windowStart: null, badWindow: true, malformed: 0 });
    // Spaces and case around it don't matter.
    expect(parseWatchPayload(`  Window~2026-10-04T08:00:00-07:00\n${body}`).windowStart).toBe(Date.parse("2026-10-04T08:00:00-07:00"));
  });

  it("opens the window where the kept lines begin when the oldest were dropped", () => {
    const old = (i: number) => `2026-10-04T${String(10 + (i % 10)).padStart(2, "0")}:00:00-07:00~2026-10-04T${String(10 + (i % 10)).padStart(2, "0")}:30:00-07:00~Core`;
    const lines = Array.from({ length: MAX_SAMPLES + 5 }, (_, i) => old(i));
    lines.sort();
    const r = parseWatchPayload(["window~2026-10-04T08:00:00-07:00", ...lines].join("\n"));
    // Where the kept lines begin, or past the end of the dropped sleep (+1 min).
    const droppedEnd = Math.max(...lines.slice(0, 5).map((l) => Date.parse(l.split("~")[1])));
    expect(r.windowStart).toBe(Math.max(Date.parse(lines[5].split("~")[0]), droppedEnd + 60_000 + 1));
  });

  it("counts a would-be code that isn't one as malformed, not a language", () => {
    const line = (code: string) => `2026-10-05T23:40:00-07:00~2026-10-06T00:10:00-07:00~${code}`;
    expect(parseWatchPayload(["-1", "(1)", "1-", "６"].map(line).join("\n"))).toMatchObject({ samples: [], unrecognised: 0, malformed: 4 });
  });

  it("reads Health's numeric stage codes too", () => {
    const line = (code: string) => `2026-10-05T23:40:00-07:00~2026-10-06T00:10:00-07:00~${code}`;
    const { samples, unrecognised } = parseWatchPayload(["0", "1", "2", "3", "4", "5", "9"].map(line).join("\n"));
    expect(samples.map((s) => s.asleep)).toEqual([false, true, false, true, true, true]);
    // A code with no stage is the format, not a language.
    expect(unrecognised).toBe(0);
  });
});

describe("watchOnset", () => {
  it("is the first asleep sample inside the night, from its start", () => {
    expect(watchOnset(START, sleepStretches([awakeAt(5 * MIN), asleepAt(25 * MIN), asleepAt(18 * MIN)]))).toBe(18 * MIN);
  });
  it("ignores sleep before the night began, past the window, or in the next night", () => {
    expect(watchOnset(START, sleepStretches([asleepAt(-10 * MIN)]))).toBeNull();
    expect(watchOnset(START, sleepStretches([asleepAt(MATCH_WINDOW_MS)]))).toBeNull();
    expect(watchOnset(START, sleepStretches([asleepAt(90 * MIN)]), START + 60 * MIN)).toBeNull();
  });
  it("counts an onset at the very start", () => {
    expect(watchOnset(START, sleepStretches([asleepAt(0)]))).toBe(0);
  });
  it("doesn't take a stage change in sleep that began before the start for falling asleep", () => {
    // Core from 10 min before start to 20 min after, then REM: one stretch.
    expect(watchOnset(START, sleepStretches([asleepAt(-10 * MIN, 30 * MIN), asleepAt(20 * MIN, 30 * MIN)]))).toBeNull();
    // Woke, then slept again: the new stretch is the onset.
    expect(
      watchOnset(START, sleepStretches([asleepAt(-10 * MIN, 30 * MIN), awakeAt(20 * MIN, 10 * MIN), asleepAt(30 * MIN, 30 * MIN)])),
    ).toBe(30 * MIN);
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

  it("keeps the detector's original onset when re-timed again", () => {
    const once = retimed(night({ timeline }), 12 * MIN);
    expect(retimed(once, 25 * MIN).inferredAtMs).toBe(30 * MIN);
  });

  it("drops a previous watch onset's attribution once the timeline is gone", () => {
    const once = retimed(night({ timeline }), 12 * MIN);
    const { timeline: _t, ...pruned } = once;
    const again = retimed(pruned, 25 * MIN);
    expect(again).not.toHaveProperty("onsetFeedId");
    expect(again).not.toHaveProperty("sleptThrough");
  });

  it("drops a self-label, which was on the detector's claim", () => {
    expect(retimed(night({ selfLabel: "awake" }), 12 * MIN)).not.toHaveProperty("selfLabel");
  });
});

describe("applyWatch and the window", () => {
  it("times a night that began after the window opened, its first-ever one included", () => {
    // A new watch: nothing before this night's sleep in the payload.
    const r = applyWatch([night()], [asleepAt(20 * MIN)], START - 60 * MIN);
    expect(r.timed.map((x) => x.atMs)).toEqual([20 * MIN]);
  });
});

describe("retimed, on a night revived after a reload", () => {
  it("credits nothing when the timeline begins after the onset", () => {
    // Revived at 4 h: the timeline holds only what played since.
    const n = retimed(night({ endedAt: START + 6 * 60 * MIN, timeline: [{ t: 4 * 60 * MIN, feedId: "x", episodeId: "x1" }] }), 30 * MIN);
    expect(n.timeToSleepMs).toBe(30 * MIN);
    expect(n).not.toHaveProperty("onsetFeedId");
    expect(n).not.toHaveProperty("sleptThrough");
  });
});

describe("applyWatch", () => {
  it("times each night by its own samples, the rest unchanged, order kept", () => {
    const second = night({ startedAt: START + 3 * 60 * MIN, endedAt: START + 4 * 60 * MIN });
    const other = night({ startedAt: START - 24 * 60 * MIN });
    const { nights, timed } = applyWatch([other, night(), second], [asleepAt(15 * MIN), asleepAt(3 * 60 * MIN + 5 * MIN)], WINDOW);
    expect(nights[0]).toBe(other);
    expect(nights[1].timeToSleepMs).toBe(15 * MIN);
    expect(nights[2].timeToSleepMs).toBe(5 * MIN);
    expect(timed.map((t) => t.atMs)).toEqual([15 * MIN, 5 * MIN]);
    expect(timed[0].inferredAtMs).toBe(30 * MIN);
  });

  it("leaves a night that began before the payload's window as it was", () => {
    // Timed whole the morning after; two mornings on, the window opens
    // mid-sleep, and a stretch after a brief wake would pass for its onset.
    const timed = night({ detector: "watch", sleptAtMs: 20 * MIN, timeToSleepMs: 20 * MIN, inferredAtMs: 30 * MIN });
    // The window opened an hour into it.
    const r = applyWatch([timed], [asleepAt(60 * MIN, 10 * MIN), awakeAt(70 * MIN), asleepAt(75 * MIN, 60 * MIN)], START + 60 * MIN);
    expect(r.nights[0]).toBe(timed);
    expect(r.timed).toEqual([]);
  });

  it("counts a night the watch had already timed the same as unchanged, not timed", () => {
    const first = applyWatch([night()], [asleepAt(15 * MIN)], WINDOW);
    const again = applyWatch(first.nights, [asleepAt(15 * MIN)], WINDOW);
    expect(again.timed).toEqual([]);
    expect(again.unchanged).toBe(1);
    expect(again.nights[0]).toBe(first.nights[0]);
  });
});

describe("importWatch", () => {
  beforeEach(() => localStorage.clear());

  it("re-times the stored night, and the headline counts a fast watch onset", () => {
    appendNight(night(), Date.now());
    const r = importWatch(`${OPENS_LINE}\n2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core`);
    expect(r.nights).toHaveLength(1);
    expect(r).toMatchObject({ timed: [{ startedAt: START, atMs: 4 * MIN, inferredAtMs: 30 * MIN }], unchanged: 0, samples: 1, unrecognised: 0, malformed: 0, refused: false, ...FLAGS });
    expect(loadNights()[0].detector).toBe("watch");
    // 4 min is under the detector's plausibility floor; a watch onset is measured.
    expect(rollup(loadNights()).bestTimeToSleepMs).toBe(4 * MIN);
  });

  it("changes nothing when any line is malformed: a gap would split a stretch of sleep", () => {
    appendNight(night(), Date.now());
    const lines = [
      OPENS_LINE,
      "2026-10-05T23:20:00-07:00~2026-10-05T23:00:00-07:00~Core", // end before start
      "2026-10-05T23:50:00-07:00~2026-10-06T00:30:00-07:00~Deep",
    ];
    expect(importWatch(lines.join("\n"))).toMatchObject({ timed: [], malformed: 1 });
    expect(loadNights()[0].detector).toBe("inference");
  });

  it("changes nothing when any stage is unrecognised, as when only REM is in english", () => {
    appendNight(night(), Date.now());
    const lines = ["2026-10-05T23:05:00-07:00~2026-10-05T23:50:00-07:00~Kern", "2026-10-06T00:20:00-07:00~2026-10-06T00:40:00-07:00~REM"];
    // With its window line: refused for the stage alone.
    const r = importWatch([OPENS_LINE, ...lines].join("\n"));
    expect(r).toMatchObject({ timed: [], samples: 1, unrecognised: 1, noWindow: false });
    expect(loadNights()[0].detector).toBe("inference");
    expect(watchNotice(r)).toMatch(/english only/);
  });

  it("reads the newest lines when there are too many", () => {
    appendNight(night(), Date.now());
    const old = Array.from({ length: MAX_SAMPLES }, () => "2026-10-01T23:05:00-07:00~2026-10-01T23:50:00-07:00~Core");
    const r = importWatch([OPENS_LINE, ...old, "2026-10-05T23:06:00-07:00~2026-10-05T23:50:00-07:00~Core"].join("\n"));
    expect(r.samples).toBe(MAX_SAMPLES);
    expect(r.timed.map((x) => x.atMs)).toEqual([6 * MIN]);
  });

  it("counts a dropped line that doesn't read: it still refuses", () => {
    const kept = Array.from({ length: MAX_SAMPLES }, () => "2026-10-05T23:30:00-07:00~2026-10-05T23:40:00-07:00~Deep");
    const r = parseWatchPayload([OPENS_LINE, "2026-10-05T22:00:00-07:00~2026-10-06T02:00:00-07:00~Schlaf", ...kept].join("\n"));
    expect(r.unrecognised).toBe(1);
  });

  it("doesn't move the window past a dropped Awake or In Bed sample", () => {
    const dropped = "2026-10-05T22:00:00-07:00~2026-10-06T07:00:00-07:00~In Bed";
    const kept = Array.from({ length: MAX_SAMPLES }, () => "2026-10-05T23:10:30-07:00~2026-10-05T23:40:00-07:00~Deep");
    const r = parseWatchPayload([OPENS_LINE, dropped, ...kept].join("\n"));
    expect(r.windowStart).toBe(Date.parse("2026-10-05T23:10:30-07:00"));
  });

  it("moves the window past dropped sleep a kept sample could have joined", () => {
    // The last dropped line is sleep ending 23:10; the first kept one starts
    // 23:10:30, within a minute: one stretch, begun before the 23:00 night.
    const dropped = "2026-10-05T22:30:00-07:00~2026-10-05T23:10:00-07:00~Core";
    const kept = Array.from({ length: MAX_SAMPLES }, (_, i) =>
      i === 0 ? "2026-10-05T23:10:30-07:00~2026-10-05T23:40:00-07:00~Deep" : "2026-10-06T06:00:00-07:00~2026-10-06T06:01:00-07:00~Awake",
    );
    const r = parseWatchPayload([OPENS_LINE, dropped, ...kept].join("\n"));
    expect(r.windowStart).toBe(Date.parse("2026-10-05T23:10:00-07:00") + 60_000 + 1);
  });

  it("says so, and claims nothing, when the re-timed nights can't be stored", () => {
    appendNight(night(), Date.now());
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      const r = importWatch(`${OPENS_LINE}\n2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core`);
      expect(r).toMatchObject({ timed: [], unsaved: true });
      expect(watchNotice(r)).toMatch(/nothing could be saved/);
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(loadNights()[0].detector).toBe("inference");
  });

  it("writes nothing when nothing is re-timed", () => {
    appendNight(night(), Date.now());
    const line = `${OPENS_LINE}\n2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core`;
    importWatch(line);
    const setItem = Storage.prototype.setItem;
    let writes = 0;
    Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
      writes++;
      return setItem.call(this, k, v);
    };
    try {
      expect(importWatch(line)).toMatchObject({ timed: [], unchanged: 1 });
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(writes).toBe(0);
  });

  it("refuses a window line whose date doesn't read, and says so", () => {
    appendNight(night(), Date.now());
    const r = importWatch("window~Oct 4, 2026 at 8:00 AM\n2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core");
    expect(r).toMatchObject({ timed: [], badWindow: true });
    expect(r.noWindow).toBe(false);
    expect(watchNotice(r)).toMatch(/window line didn't read/);
  });

  it("refuses a payload without its window line, and says the shortcut needs it", () => {
    appendNight(night(), Date.now());
    const r = importWatch("2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core");
    expect(r).toMatchObject({ timed: [], noWindow: true });
    expect(watchNotice(r)).toMatch(/window line/);
    expect(loadNights()[0].detector).toBe("inference");
  });

  it("leaves storage alone when nothing parses", () => {
    appendNight(night(), Date.now());
    expect(importWatch("garbage")).toEqual({ timed: [], unchanged: 0, samples: 0, unrecognised: 0, malformed: 1, refused: true, ...FLAGS, noWindow: true });
    expect(loadNights()[0].detector).toBe("inference");
  });
});

describe("watchPayloadFromHash", () => {
  it("decodes a #watch= fragment, and ignores any other", () => {
    expect(watchPayloadFromHash("#watch=a~b~Core%0Ac~d~REM")).toBe("a~b~Core\nc~d~REM");
    expect(watchPayloadFromHash("#other")).toBeNull();
    expect(watchPayloadFromHash("")).toBeNull();
    // A bad byte spoils only itself: the good %0A beside it still breaks the line.
    expect(watchPayloadFromHash("#watch=a~b~Core%E2%0Ac~d~REM")).toBe("a~b~Core%E2\nc~d~REM");
    // A bare % (no url-encode step) spoils only its own escape.
    expect(watchPayloadFromHash("#watch=a~b~Core%0A100%~x")).toBe("a~b~Core\n100%~x");
  });
});

describe("payloadFromPaste", () => {
  it("takes the lines, still url-encoded or not, or the payload out of a whole link", () => {
    expect(payloadFromPaste("  a~b~Core\n")).toBe("a~b~Core");
    expect(payloadFromPaste("a~b~Core%0Ac~d~REM")).toBe("a~b~Core\nc~d~REM");
    expect(payloadFromPaste("2026-10-06T23%3A15%3A00%2B02%3A00~x~Core")).toBe("2026-10-06T23:15:00+02:00~x~Core");
    expect(payloadFromPaste("https://sleepcast.pro/#watch=a~b~Core%0Ac~d~REM")).toBe("a~b~Core\nc~d~REM");
  });
});

describe("watchNotice", () => {
  const t = (atMs: number, inferredAtMs: number | null) => ({ startedAt: START, atMs, inferredAtMs });
  it("says what the import did", () => {
    expect(watchNotice({ ...FLAGS, timed: [t(12 * MIN, 30 * MIN)], unchanged: 0, samples: 3, unrecognised: 0, malformed: 0, refused: false })).toBe(
      "your watch: asleep 12 min in; sleepcast guessed 30 min.",
    );
    expect(watchNotice({ ...FLAGS, timed: [t(5 * MIN, null), t(12 * MIN, null)], unchanged: 0, samples: 3, unrecognised: 0, malformed: 0, refused: false })).toBe(
      "your watch timed 2 nights. the latest: asleep 12 min in.",
    );
    expect(watchNotice({ ...FLAGS, timed: [], unchanged: 0, samples: 3, unrecognised: 0, malformed: 0, refused: false })).toMatch(/didn't start inside/);
    expect(watchNotice({ ...FLAGS, timed: [], unchanged: 0, samples: 0, unrecognised: 0, malformed: 0, refused: false })).toMatch(/sleep tracking/);
    expect(watchNotice({ ...FLAGS, timed: [], unchanged: 0, samples: 0, unrecognised: 4, malformed: 0, refused: false })).toMatch(/english only/);
    expect(watchNotice({ ...FLAGS, timed: [], unchanged: 0, samples: 0, unrecognised: 0, malformed: 3, refused: false })).toMatch(/start date~end date~value/);
    expect(watchNotice({ ...FLAGS, timed: [], unchanged: 1, samples: 3, unrecognised: 0, malformed: 0, refused: false })).toMatch(/nothing new/);
    expect(watchNotice({ ...FLAGS, timed: [], unchanged: 0, samples: 3, unrecognised: 0, malformed: 2, refused: false })).toMatch(
      /^2 lines of the watch data didn't read, so nothing was changed/,
    );
    expect(watchNotice({ ...FLAGS, timed: [t(20_000, null)], unchanged: 0, samples: 3, unrecognised: 0, malformed: 0, refused: false })).toBe(
      "your watch: asleep within a minute.",
    );
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

describe("appendNight, the same night twice", () => {
  beforeEach(() => localStorage.clear());
  it("appends a new night", () => {
    appendNight(night(), Date.now());
    expect(loadNights()).toHaveLength(1);
  });
  it("replaces a night a watch import recorded from a suspended tab, keeping the watch's time", () => {
    // The import recorded the snapshot (detector none), then the watch timed it.
    appendNight(night({ detector: "watch", sleptAtMs: 12 * MIN, timeToSleepMs: 12 * MIN, inferredAtMs: null }), Date.now());
    const timeline = [{ t: 0, feedId: "a", episodeId: "a1" }];
    // The tab wakes and ends its night as it really was.
    appendNight(night({ interactions: 7, timeline }), Date.now());
    const [n] = loadNights();
    expect(loadNights()).toHaveLength(1);
    expect(n).toMatchObject({ interactions: 7, detector: "watch", sleptAtMs: 12 * MIN, inferredAtMs: 30 * MIN, onsetFeedId: "a" });
  });
});

describe("importWatch and a killed tab's snapshot", () => {
  beforeEach(() => localStorage.clear());
  it("leaves it alone when the import is refused: nothing changed, as the notice says", () => {
    localStorage.setItem("sleepcast2.live", JSON.stringify({ savedAt: 1, remainingMs: 0, totalSeconds: 0, position: 0, current: { id: "e1", title: "", url: "", feedId: "f", date: "" }, playedIds: [], pool: [], skipIntroByFeedId: {}, feedTitles: {}, artworkByFeedId: {}, modeKind: "all-night" }));
    const r = importWatch("not the shortcut's text at all");
    expect(r.refused).toBe(true);
    expect(localStorage.getItem("sleepcast2.live")).not.toBeNull();
    expect(loadNights()).toHaveLength(0);
  });
});

describe("watchNotice, for a night other than last night", () => {
  const older = (startedAt: number) =>
    watchNotice({
      ...FLAGS,
      timed: [{ startedAt, atMs: 12 * MIN, inferredAtMs: null }],
      latestIsOlder: true,
      unchanged: 0, samples: 3, unrecognised: 0, malformed: 0, refused: false,
    });
  it("names the night, in english", () => {
    expect(older(new Date(2026, 9, 2, 23, 0).getTime())).toBe("your watch for friday night: asleep 12 min in.");
  });
  it("names a night started in the small hours by the evening before", () => {
    // Sunday 00:30 is saturday night.
    expect(older(new Date(2026, 9, 4, 0, 30).getTime())).toBe("your watch for saturday night: asleep 12 min in.");
  });
});

describe("importWatch with a killed tab's night, and full storage", () => {
  beforeEach(() => localStorage.clear());
  it("changes nothing at all: the snapshot stays, nothing is recorded", () => {
    const live = { savedAt: START + 10 * MIN, remainingMs: 0, totalSeconds: 0, position: 0, current: { id: "e1", title: "", url: "", feedId: "f", date: "" }, playedIds: [], pool: [], skipIntroByFeedId: {}, feedTitles: {}, artworkByFeedId: {}, nightStartedAt: START, modeKind: "all-night" };
    localStorage.setItem("sleepcast2.live", JSON.stringify(live));
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    let r;
    try {
      r = importWatch(`${OPENS_LINE}\n2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core`, START + 10 * 60 * MIN);
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(r).toMatchObject({ unsaved: true, refused: true });
    expect(r).not.toHaveProperty("nights");
    expect(localStorage.getItem("sleepcast2.live")).not.toBeNull();
    expect(loadNights()).toHaveLength(0);
  });

  it("records it with the watch's time in one go", () => {
    const live = { savedAt: START + 10 * MIN, remainingMs: 0, totalSeconds: 0, position: 0, current: { id: "e1", title: "", url: "", feedId: "f", date: "" }, playedIds: [], pool: [], skipIntroByFeedId: {}, feedTitles: {}, artworkByFeedId: {}, nightStartedAt: START, modeKind: "all-night" };
    localStorage.setItem("sleepcast2.live", JSON.stringify(live));
    const r = importWatch(`${OPENS_LINE}\n2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core`, START + 10 * 60 * MIN);
    expect(r).toMatchObject({ timed: [{ startedAt: START, atMs: 4 * MIN }] });
    expect(r.nights).toHaveLength(1);
    expect(localStorage.getItem("sleepcast2.live")).toBeNull();
    expect(loadNights()[0]).toMatchObject({ detector: "watch", timeToSleepMs: 4 * MIN });
  });
});

describe("an import with nothing to read yet", () => {
  beforeEach(() => localStorage.clear());
  it("still records a killed tab's night: the night is over", () => {
    const live = { savedAt: START + 10 * MIN, remainingMs: 0, totalSeconds: 0, position: 0, current: { id: "e1", title: "", url: "", feedId: "f", date: "" }, playedIds: [], pool: [], skipIntroByFeedId: {}, feedTitles: {}, artworkByFeedId: {}, nightStartedAt: START, modeKind: "all-night" };
    localStorage.setItem("sleepcast2.live", JSON.stringify(live));
    const r = importWatch(OPENS_LINE, START + 10 * 60 * MIN);
    expect(r).toMatchObject({ samples: 0, refused: false });
    expect(watchNotice(r)).toBe("nothing from your watch yet. last night is recorded without the watch's time: run it again later.");
    expect(localStorage.getItem("sleepcast2.live")).toBeNull();
    expect(loadNights()).toHaveLength(1);
  });
});

describe("nightName across a DST change", () => {
  it("goes by the local hour", () => {
    const t = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m, d, h, min).getTime();
    const name = (startedAt: number) =>
      watchNotice({ ...FLAGS, timed: [{ startedAt, atMs: 12 * MIN, inferredAtMs: null }], latestIsOlder: true, unchanged: 0, samples: 1, unrecognised: 0, malformed: 0, refused: false });
    // Sunday 05:30 local is saturday night, whatever the clocks did that night.
    expect(name(t(2026, 10, 1, 5, 30))).toContain("for saturday night");
    // Sunday 06:30 local is a morning session, sunday's.
    expect(name(t(2026, 10, 1, 6, 30))).toContain("for sunday morning");
  });
});

describe("a Shortcut from before the window line, with nothing to send", () => {
  beforeEach(() => localStorage.clear());
  it("is refused, and told to update", () => {
    const r = importWatch("");
    expect(r).toMatchObject({ noWindow: true, refused: true });
    expect(watchNotice(r)).toMatch(/window line/);
  });
});

describe("a window line dated in the future", () => {
  beforeEach(() => localStorage.clear());
  it("is a bad window (an adjust-date step adding, not subtracting), refused", () => {
    appendNight(night(), Date.now());
    const r = importWatch(`window~2026-10-08T07:00:00-07:00\n2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core`, START + 10 * 60 * MIN);
    expect(r).toMatchObject({ badWindow: true, refused: true, timed: [] });
    expect(watchNotice(r)).toMatch(/subtract 2 days/);
  });
});

describe("watchNotice, nothing timed yet but a killed night recorded", () => {
  it("says the night is recorded and to run it again", () => {
    const r = { ...FLAGS, timed: [], unchanged: 0, samples: 2, unrecognised: 0, malformed: 0, refused: false, recordedUntimed: true };
    expect(watchNotice(r)).toBe(
      "no sleep from your watch inside a sleepcast night yet. last night is recorded without the watch's time: run it again later.",
    );
    // Also beside "nothing new", the daily case, and beside a timed older night.
    expect(watchNotice({ ...r, unchanged: 1 })).toMatch(/^nothing new: .* last night is recorded without the watch's time: run it again later\.$/);
    expect(
      watchNotice({ ...r, timed: [{ startedAt: new Date(2026, 9, 5, 23).getTime(), atMs: 12 * MIN, inferredAtMs: null }], latestIsOlder: true }),
    ).toBe("your watch for monday night: asleep 12 min in. last night is recorded without the watch's time: run it again later.");
  });
  it("puts a missing window line first, ahead of the lines it makes malformed", () => {
    expect(watchNotice({ ...FLAGS, noWindow: true, timed: [], unchanged: 0, samples: 3, unrecognised: 0, malformed: 1, refused: true })).toMatch(/window line first/);
  });
});

describe("a future window line, even in a truncated payload", () => {
  it("blames the window line only when it is the window line that's in the future", () => {
    const now = Date.parse("2026-10-06T09:00:00-07:00");
    const future = Array.from({ length: MAX_SAMPLES + 1 }, () => "2026-10-07T01:00:00-07:00~2026-10-07T01:30:00-07:00~Core");
    const r = parseWatchPayload([OPENS_LINE, ...future].join("\n"), now);
    expect(r.badWindow).toBe(false);
    expect(parseWatchPayload("window~2026-10-08T07:00:00-07:00", now).badWindow).toBe(true);
  });
});
