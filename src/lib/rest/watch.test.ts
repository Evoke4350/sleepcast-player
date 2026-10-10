import { describe, it, expect, beforeEach } from "vitest";
import {
  parseWatchPayload,
  watchOnset,
  AFTER_END_MS,
  applyWatch,
  shortcutWindowOpens,
  importWatch,
  watchPayloadFromHash,
  watchNotice,
  watchAgreement,
  isRefused,
  payloadFromPaste,
  normaliseIso,
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
const FLAGS = { unsaved: false, noWindow: false, badWindow: false, repeat: false, stale: false, slept: 1 };
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
/** applyWatch read when the Shortcut ran: its window's two days on. */
const apply = (n: Parameters<typeof applyWatch>[0], s: Parameters<typeof applyWatch>[1], w: number) => applyWatch(n, s, w, w + 2 * 24 * 60 * MIN);
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
    expect(r.windowStart).toBe(Math.max(Date.parse(lines[5].split("~")[0]), droppedEnd));
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
    expect(watchOnset(START, sleepStretches([asleepAt(-10 * MIN)]))).toBe("pending");
    expect(watchOnset(START, sleepStretches([asleepAt(MATCH_WINDOW_MS)]))).toBeNull();
    expect(watchOnset(START, sleepStretches([asleepAt(90 * MIN)]), START + 60 * MIN)).toBeNull();
  });
  it("takes no zero-length sample for sleep, and sleep running right up to the press as under way at it", () => {
    expect(sleepStretches([{ start: START, end: START, asleep: true }])).toEqual([]);
    expect(watchOnset(START, sleepStretches([asleepAt(-120 * MIN, 120 * MIN), asleepAt(90_000)]))).toBe("asleep");
  });
  it("is pending with no sleep handed over past the start yet, whatever Awake came", () => {
    expect(watchOnset(START, sleepStretches([awakeAt(5 * 60 * MIN)]))).toBe("pending");
    expect(watchOnset(START, [])).toBe("pending");
  });
  it("counts an onset at the very start", () => {
    expect(watchOnset(START, sleepStretches([asleepAt(0)]))).toBe(0);
  });
  it("doesn't take a stage change in sleep that began before the start for falling asleep", () => {
    // Core from 10 min before start to 20 min after, then REM: one stretch.
    expect(watchOnset(START, sleepStretches([asleepAt(-10 * MIN, 30 * MIN), asleepAt(20 * MIN, 30 * MIN)]))).toBe("asleep");
    // Woke, then slept again: still unknown, as the watch had them asleep
    // when they pressed start (a stretch after a later wake, hours in,
    // would pass for falling asleep).
    expect(
      watchOnset(START, sleepStretches([asleepAt(-10 * MIN, 30 * MIN), awakeAt(20 * MIN, 10 * MIN), asleepAt(30 * MIN, 30 * MIN)])),
    ).toBe("asleep");
    // Sleep that ended before the start isn't under way at it.
    expect(watchOnset(START, sleepStretches([asleepAt(-40 * MIN, 30 * MIN), asleepAt(20 * MIN, 30 * MIN)]))).toBe(20 * MIN);
  });
  it("leaves a night the watch had the listener asleep at the start of as it was, and says so", () => {
    const r = apply([night()], [asleepAt(-5 * MIN, 150 * MIN), awakeAt(145 * MIN, 15 * MIN), asleepAt(160 * MIN, 60 * MIN)], START - 60 * MIN);
    expect([r.timed, r.asleepAtStart, r.nights]).toEqual([[], [START], [night()]]);
    const asleep = { startedAt: START, why: "asleep" as const };
    const base = { timed: [], unchanged: 0, unsaved: false, noWindow: false, badWindow: false, repeat: false, stale: false, slept: 2, untimed: [asleep], unrecognised: 0, malformed: 0 };
    expect(watchNotice(base)).toMatch(/^\w+ \w+ has no watch time: your watch had you asleep before sleepcast started\.$/);
    // ...beside a night already timed, or an older one timed,
    expect(watchNotice({ ...base, unchanged: 1 })).toMatch(/^\w+ \w+ has no watch time: .*started\. nothing else new from your watch since it last ran\.$/);
    expect(watchNotice({ ...base, timed: [{ startedAt: START - 24 * 60 * MIN, atMs: 10 * MIN, inferredAtMs: null }], latestIsOlder: true })).toMatch(/asleep before sleepcast started\.$/);
    // ...and each night with its own reason, a killed tab's among them.
    const two = watchNotice({ ...base, untimed: [{ startedAt: START - 24 * 60 * MIN, why: "recorded" }, asleep] });
    expect(two).toMatch(/^\w+ \w+ is recorded without the watch's time\. \w+ \w+ has no watch time: your watch had you asleep/);
  });
  it("keeps a time it gave before (a timed night stays timed), unsaid", () => {
    const timed = night({ detector: "watch", sleptAtMs: 10 * MIN, timeToSleepMs: 10 * MIN, inferredAtMs: 20 * MIN });
    const r = apply([timed], [asleepAt(-5 * MIN, 60 * MIN)], START - 60 * MIN);
    expect([r.asleepAtStart, r.nights, r.unchanged]).toEqual([[], [timed], 1]);
  });
  it("doesn't time a night by sleep long after it ended", () => {
    const stopped = night({ endedAt: START + 3 * MIN, endedVia: "ended" });
    expect(apply([stopped], [asleepAt(200 * MIN)], START - 60 * MIN).timed).toEqual([]);
    // ...but does in the quiet just after it.
    expect(apply([stopped], [asleepAt(3 * MIN + AFTER_END_MS - 1)], START - 60 * MIN).timed).toHaveLength(1);
  });
  it("adds a time where an untimed night shares last night's name, and only then", () => {
    const base = { unchanged: 0, unsaved: false, noWindow: false, badWindow: false, repeat: false, stale: false, slept: 1, unrecognised: 0, malformed: 0 };
    // Asleep at the evening's first start; the restart after, timed: the newest.
    const same = watchNotice({ ...base, timed: [{ startedAt: START + 40 * MIN, atMs: 12 * MIN, inferredAtMs: null }], untimed: [{ startedAt: START, why: "asleep" }] });
    expect(same).toMatch(/\(from \d+:\d{2}[ap]m\) has no watch time/);
    const apart = watchNotice({ ...base, timed: [{ startedAt: START, atMs: 12 * MIN, inferredAtMs: null }], untimed: [{ startedAt: START - 24 * 60 * MIN, why: "asleep" }] });
    expect(apart).not.toMatch(/\(from/);
  });
  it("names an untimed night apart from any timed night sharing its name", () => {
    const notice = watchNotice({
      timed: [{ startedAt: START, atMs: 12 * MIN, inferredAtMs: null }, { startedAt: START + 24 * 60 * MIN, atMs: 9 * MIN, inferredAtMs: null }],
      untimed: [{ startedAt: START + 40 * MIN, why: "asleep" }],
      unchanged: 0, unsaved: false, noWindow: false, badWindow: false, repeat: false, stale: false, slept: 2, unrecognised: 0, malformed: 0,
    });
    expect(notice).toMatch(/\(from \d+:\d{2}[ap]m\) has no watch time/);
  });
  it("keeps no guess the listener said was wrong", () => {
    const disowned = night({ selfLabel: "awake", sleptAtMs: 8 * MIN, timeToSleepMs: 8 * MIN });
    expect(apply([disowned], [asleepAt(45 * MIN)], START - 60 * MIN).nights[0]).toMatchObject({ detector: "watch", sleptAtMs: 45 * MIN, inferredAtMs: null });
  });
  it("still counts an end before the start as the start, for a night stored before finish clamped it", () => {
    expect(apply([night({ endedAt: START - 60 * MIN })], [asleepAt(10 * MIN)], START - 60 * MIN).timed).toHaveLength(1);
  });
  it("says to check sleep tracking when no sleep came, even beside a kept time", () => {
    const r = { timed: [], unchanged: 1, unsaved: false, noWindow: false, badWindow: false, repeat: false, stale: false, slept: 0, unrecognised: 0, malformed: 0 };
    expect(watchNotice(r)).toMatch(/check sleep tracking/);
  });
  it("counts a night the watch timed before, and this run doesn't, as unchanged", () => {
    const timed = night({ detector: "watch", sleptAtMs: 10 * MIN, timeToSleepMs: 10 * MIN, inferredAtMs: 20 * MIN });
    expect(apply([timed], [asleepAt(-5 * MIN, 60 * MIN)], START - 60 * MIN).unchanged).toBe(1);
    expect(apply([timed], [], START - 60 * MIN).unchanged).toBe(1);
  });
  it("tells two nights with one name apart by their start", () => {
    const later = START + 30 * MIN;
    const notice = watchNotice({
      timed: [{ startedAt: START, atMs: 10 * MIN, inferredAtMs: null }],
      latestIsOlder: true,
      untimed: [{ startedAt: later, why: "asleep" }],
      unchanged: 0, unsaved: false, noWindow: false, badWindow: false, repeat: false, stale: false, slept: 1, unrecognised: 0, malformed: 0,
    });
    const [a, b] = [...notice.matchAll(/\(from (\d+:\d{2}[ap]m)\)/g)].map((m) => m[1]);
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
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
    const r = apply([night()], [asleepAt(20 * MIN)], START - 60 * MIN);
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
    const { nights, timed } = apply([other, night(), second], [asleepAt(15 * MIN), asleepAt(3 * 60 * MIN + 5 * MIN)], WINDOW);
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
    const r = apply([timed], [asleepAt(60 * MIN, 10 * MIN), awakeAt(70 * MIN), asleepAt(75 * MIN, 60 * MIN)], START + 60 * MIN);
    expect(r.nights[0]).toBe(timed);
    expect(r.timed).toEqual([]);
  });

  it("counts a night the watch had already timed the same as unchanged, not timed", () => {
    const first = apply([night()], [asleepAt(15 * MIN)], WINDOW);
    const again = apply(first.nights, [asleepAt(15 * MIN)], WINDOW);
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
    expect(r).toMatchObject({ timed: [{ startedAt: START, atMs: 4 * MIN, inferredAtMs: 30 * MIN }], unchanged: 0, unrecognised: 0, malformed: 0, ...FLAGS });
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
    expect(r).toMatchObject({ timed: [], unrecognised: 1, noWindow: false });
    expect(loadNights()[0].detector).toBe("inference");
    expect(watchNotice(r)).toMatch(/english only/);
  });

  it("reads the newest lines when there are too many", () => {
    appendNight(night(), Date.now());
    const old = Array.from({ length: MAX_SAMPLES }, () => "2026-10-01T23:05:00-07:00~2026-10-01T23:50:00-07:00~Core");
    const r = importWatch([OPENS_LINE, ...old, "2026-10-05T23:06:00-07:00~2026-10-05T23:50:00-07:00~Core"].join("\n"));
    expect(r.slept).toBe(MAX_SAMPLES);
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
    // Up to where the kept lines begin; timeableFrom adds the joining margin.
    expect(r.windowStart).toBe(Date.parse("2026-10-05T23:10:30-07:00"));
    // A night at 23:10:45 is inside that margin: not timed.
    const at = Date.parse("2026-10-05T23:10:45-07:00");
    expect(apply([night({ startedAt: at })], r.samples, r.windowStart!).timed).toEqual([]);
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
      if (k !== "sleepcast2.watch-read") writes++; // (the run read is remembered)
      return setItem.call(this, k, v);
    };
    try {
      // The next run: a later window, the same samples.
      expect(importWatch(line.replace("11:00:00", "12:00:00"))).toMatchObject({ timed: [], unchanged: 1 });
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
    expect(importWatch("garbage")).toEqual({ timed: [], unchanged: 0, unrecognised: 0, malformed: 1, ...FLAGS, noWindow: true, slept: 0 });
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
    expect(watchNotice({ ...FLAGS, timed: [t(12 * MIN, 30 * MIN)], unchanged: 0, unrecognised: 0, malformed: 0 })).toBe(
      "your watch: asleep 12 min in; sleepcast guessed 30 min.",
    );
    expect(watchNotice({ ...FLAGS, timed: [t(5 * MIN, null), t(12 * MIN, null)], unchanged: 0, unrecognised: 0, malformed: 0 })).toBe(
      "your watch timed 2 nights. the latest: asleep 12 min in.",
    );
    expect(watchNotice({ ...FLAGS, timed: [], unchanged: 0, unrecognised: 0, malformed: 0 })).toMatch(/didn't start inside/);
    expect(watchNotice({ ...FLAGS, timed: [], unchanged: 0, unrecognised: 0, malformed: 0, slept: 0 })).toMatch(/sleep tracking/);
    expect(watchNotice({ ...FLAGS, timed: [], unchanged: 0, unrecognised: 4, malformed: 0, slept: 0 })).toMatch(/english only/);
    expect(watchNotice({ ...FLAGS, timed: [], unchanged: 0, unrecognised: 0, malformed: 3, slept: 0 })).toMatch(/start date~end date~value/);
    expect(watchNotice({ ...FLAGS, timed: [], unchanged: 1, unrecognised: 0, malformed: 0 })).toMatch(/nothing new/);
    expect(watchNotice({ ...FLAGS, timed: [], unchanged: 0, unrecognised: 0, malformed: 2 })).toMatch(
      /^2 lines of the watch data didn't read, so nothing was changed/,
    );
    expect(watchNotice({ ...FLAGS, timed: [t(20_000, null)], unchanged: 0, unrecognised: 0, malformed: 0 })).toBe(
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
    expect(isRefused(r)).toBe(true);
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
      unchanged: 0, unrecognised: 0, malformed: 0,
    });
  it("names the night, in english", () => {
    expect(older(new Date(2026, 9, 2, 23, 0).getTime())).toBe("your watch for friday night: asleep 12 min in.");
  });
  it("names a night started in the small hours as their own, not the evening's", () => {
    // Sunday 00:30: a night of its own, beside saturday night's.
    expect(older(new Date(2026, 9, 4, 0, 30).getTime())).toBe("your watch for the early hours of sunday: asleep 12 min in.");
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
    expect(r).toMatchObject({ unsaved: true });
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
    expect(isRefused(r)).toBe(false);
    expect(watchNotice(r)).toMatch(/^nothing from your watch yet \(check sleep tracking is on\)\. \w+ \w+ is recorded without the watch's time: run it again later\.$/);
    expect(localStorage.getItem("sleepcast2.live")).toBeNull();
    expect(loadNights()).toHaveLength(1);
  });
});

describe("nightName across a DST change", () => {
  it("goes by the local hour", () => {
    const t = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m, d, h, min).getTime();
    const name = (startedAt: number) =>
      watchNotice({ ...FLAGS, timed: [{ startedAt, atMs: 12 * MIN, inferredAtMs: null }], latestIsOlder: true, unchanged: 0, unrecognised: 0, malformed: 0 });
    // Sunday 05:30 local is the early hours of sunday, whatever the clocks did.
    expect(name(t(2026, 10, 1, 5, 30))).toContain("for the early hours of sunday");
    // Sunday 06:30 local is a morning session, sunday's.
    expect(name(t(2026, 10, 1, 6, 30))).toContain("for sunday morning");
  });
});

describe("a Shortcut from before the window line, with nothing to send", () => {
  beforeEach(() => localStorage.clear());
  it("is refused, and told to update", () => {
    const r = importWatch("");
    expect(r).toMatchObject({ noWindow: true });
    expect(watchNotice(r)).toMatch(/window line/);
  });
});

describe("a window line dated in the future", () => {
  beforeEach(() => localStorage.clear());
  it("is a bad window (an adjust-date step adding, not subtracting), refused", () => {
    appendNight(night(), Date.now());
    const r = importWatch(`window~2026-10-08T07:00:00-07:00\n2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core`, START + 10 * 60 * MIN);
    expect(r).toMatchObject({ badWindow: true, timed: [] });
    expect(watchNotice(r)).toMatch(/subtract 2 days/);
  });
});

describe("watchNotice, nothing timed yet but a killed night recorded", () => {
  it("says the night is recorded and to run it again", () => {
    const r = { ...FLAGS, timed: [], unchanged: 0, unrecognised: 0, malformed: 0, untimed: [{ startedAt: new Date(2026, 9, 5, 23).getTime(), why: "later" as const }] };
    expect(watchNotice(r)).toBe(
      "no sleep from your watch inside a sleepcast night yet. monday night is recorded without the watch's time: run it again later.",
    );
    // Also beside "nothing new", the daily case, and beside a timed older night.
    expect(watchNotice({ ...r, unchanged: 1 })).toMatch(/^nothing new from your watch since it last ran\. monday night is recorded without the watch's time: run it again later\.$/);
    expect(
      watchNotice({ ...r, timed: [{ startedAt: new Date(2026, 9, 5, 23).getTime(), atMs: 12 * MIN, inferredAtMs: null }], latestIsOlder: true }),
    ).toBe("your watch for monday night: asleep 12 min in. monday night is recorded without the watch's time: run it again later.");
  });
  it("puts a missing window line first, ahead of the lines it makes malformed", () => {
    expect(watchNotice({ ...FLAGS, noWindow: true, timed: [], unchanged: 0, unrecognised: 0, malformed: 1 })).toMatch(/window line first/);
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

describe("the notice before the watch has handed the night over", () => {
  beforeEach(() => localStorage.clear());
  it("treats only In Bed or Awake samples as nothing yet", () => {
    appendNight(night(), Date.now());
    const r = importWatch(`${OPENS_LINE}\n2026-10-05T22:55:00-07:00~2026-10-05T23:10:00-07:00~In Bed`, START + 10 * 60 * MIN);
    expect(r).toMatchObject({ slept: 0 });
    expect(watchNotice(r)).toMatch(/^nothing from your watch yet/);
  });
});

describe("a killed night to run again for", () => {
  beforeEach(() => localStorage.clear());
  const snap = (startedAt: number) => ({ savedAt: startedAt + 10 * MIN, remainingMs: 0, totalSeconds: 0, position: 0, current: { id: "e1", title: "", url: "", feedId: "f", date: "" }, playedIds: [], pool: [], skipIntroByFeedId: {}, feedTitles: {}, artworkByFeedId: {}, nightStartedAt: startedAt, modeKind: "all-night" });
  it("isn't said for a killed night merged into one the watch already timed", () => {
    appendNight(night({ detector: "watch", sleptAtMs: 4 * MIN, timeToSleepMs: 4 * MIN, inferredAtMs: null }), Date.now());
    localStorage.setItem("sleepcast2.live", JSON.stringify(snap(START)));
    const r = importWatch(`${OPENS_LINE}\n2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core`, START + 10 * 60 * MIN);
    expect(r.untimed).toBeUndefined();
    expect(watchNotice(r)).not.toMatch(/run it again/);
  });
  it("isn't said for a killed night from before the window, which a later run can't time", () => {
    localStorage.setItem("sleepcast2.live", JSON.stringify(snap(START - 3 * 24 * 60 * MIN)));
    const r = importWatch(`${OPENS_LINE}\n2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core`, START + 10 * 60 * MIN);
    expect(r.nights).toHaveLength(1);
    expect(r.untimed).toEqual([{ startedAt: START - 3 * 24 * 60 * MIN, why: "recorded" }]);
  });
});

describe("payloadFromPaste and the window line, loosely written", () => {
  it("cuts a pasted link at the first whitespace, so a message's own words aren't read", () => {
    expect(payloadFromPaste("open https://sleepcast.pro/#watch=a~b~Core%0Ac~d~REM in safari")).toBe("a~b~Core\nc~d~REM");
    expect(payloadFromPaste("here it is: \"https://sleepcast.pro/#watch=a~b~Core%0Ac~d~REM\".")).toBe("a~b~Core\nc~d~REM");
    expect(payloadFromPaste("<https://sleepcast.pro/#watch=a~b~Core%0Ac~d~REM>")).toBe("a~b~Core\nc~d~REM");
    expect(payloadFromPaste("**https://sleepcast.pro/#watch=a~b~Core%0Ac~d~REM**")).toBe("a~b~Core\nc~d~REM");
  });
  it("reads a window line with spaces around its ~", () => {
    expect(parseWatchPayload("Window ~ 2026-10-04T08:00:00-07:00\n").windowStart).toBe(Date.parse("2026-10-04T08:00:00-07:00"));
  });
});

describe("payloadFromPaste and an ellipsis", () => {
  it("drops trailing punctuation of any kind", () => {
    expect(payloadFromPaste("https://sleepcast.pro/#watch=a~b~Core%0Ac~d~REM…")).toBe("a~b~Core\nc~d~REM");
    expect(payloadFromPaste("«https://sleepcast.pro/#watch=a~b~Core»")).toBe("a~b~Core");
  });
});

describe("watchAgreement's median", () => {
  it("isn't rounded to the second (under a minute stays under a minute)", () => {
    const a = watchAgreement([night({ detector: "watch", sleptAtMs: 10 * MIN, inferredAtMs: 10 * MIN + 29_600 })]);
    expect(a.medianOffMs).toBe(29_600);
  });
});

describe("a killed night the cap drops", () => {
  beforeEach(() => localStorage.clear());
  it("is recorded and its snapshot goes, like any night past the cap (none retried for ever)", () => {
    for (let i = 0; i < 90; i++) appendNight(night({ startedAt: START - (89 - i) * 24 * 60 * MIN + 60 * MIN, timeline: undefined }), START);
    // A stale snapshot older than every kept night.
    const live = { savedAt: START - 200 * 24 * 60 * MIN, remainingMs: 0, totalSeconds: 0, position: 0, current: { id: "e1", title: "", url: "", feedId: "f", date: "" }, playedIds: [], pool: [], skipIntroByFeedId: {}, feedTitles: {}, artworkByFeedId: {}, nightStartedAt: START - 200 * 24 * 60 * MIN, modeKind: "all-night" };
    localStorage.setItem("sleepcast2.live", JSON.stringify(live));
    importWatch(OPENS_LINE, START + 10 * 60 * MIN);
    expect(localStorage.getItem("sleepcast2.live")).toBeNull();
    expect(loadNights()).toHaveLength(90);
  });
});

describe("the window's own edge", () => {
  it("leaves a night started within a minute of the window opening as it was", () => {
    // Sleep the Shortcut left out (ended just before the window) could have
    // joined the first kept sample: the night may have begun asleep.
    const r = apply([night()], [asleepAt(30_000)], START - 10_000);
    expect(r.timed).toEqual([]);
  });
  it("reads a lowercase t", () => {
    expect(parseWatchPayload("window~2026-10-05t08:00:00Z").windowStart).toBe(Date.parse("2026-10-05T08:00:00Z"));
  });
});

describe("an older ledger with a night recorded twice", () => {
  beforeEach(() => localStorage.clear());
  it("is timed and counted once: the import collapses the copies", () => {
    localStorage.setItem("sleepcast2.rest", JSON.stringify([night(), night({ interactions: 4 })]));
    const r = importWatch(`${OPENS_LINE}\n2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core`, START + 10 * 60 * MIN);
    expect(r.timed).toHaveLength(1);
    expect(loadNights()).toHaveLength(1);
    expect(watchAgreement(loadNights()).watchNights).toBe(1);
  });
});

describe("a killed night to run again for, when the watch's sleep has synced", () => {
  beforeEach(() => localStorage.clear());
  it("isn't said when the watch had sleep past the night's start but didn't time it (a later run won't)", () => {
    const live = { savedAt: START + 10 * MIN, remainingMs: 0, totalSeconds: 0, position: 0, current: { id: "e1", title: "", url: "", feedId: "f", date: "" }, playedIds: [], pool: [], skipIntroByFeedId: {}, feedTitles: {}, artworkByFeedId: {}, nightStartedAt: START, modeKind: "all-night" };
    localStorage.setItem("sleepcast2.live", JSON.stringify(live));
    // Asleep from before the start, through it: never this night's onset.
    const r = importWatch(`${OPENS_LINE}\n2026-10-05T22:50:00-07:00~2026-10-06T02:00:00-07:00~Core`, START + 10 * 60 * MIN);
    expect(r.nights).toHaveLength(1);
    expect(r.untimed).toEqual([{ startedAt: START, why: "asleep" }]);
  });
});

describe("the newest night, before the watch has handed it over", () => {
  beforeEach(() => localStorage.clear());
  it("says to run it again later, beside an older night already timed", () => {
    appendNight(night({ detector: "watch", sleptAtMs: 10 * MIN, timeToSleepMs: 10 * MIN, inferredAtMs: null }), Date.now());
    appendNight(night({ startedAt: START + 24 * 60 * MIN }), Date.now());
    const r = importWatch(`${OPENS_LINE}\n2026-10-05T23:10:00-07:00~2026-10-05T23:40:00-07:00~Core`, START + 34 * 60 * MIN);
    expect(r.untimed).toEqual([{ startedAt: START + 24 * 60 * MIN, why: "later" }]);
    expect(watchNotice(r)).toMatch(/^nothing new from your watch since it last ran\. \w+ \w+ is recorded without the watch's time: run it again later\.$/);
  });
});

describe("run it again later, only within reach", () => {
  beforeEach(() => localStorage.clear());
  it("measures reach from when it's read, not from the payload's window (a held link read late)", () => {
    const opens = Date.parse("2026-10-05T11:00:00-07:00");
    appendNight(night({ startedAt: opens + 12 * 60 * MIN }), Date.now());
    // Read 12 h after the run: a run 6 h on opens its window past the night.
    expect(importWatch(OPENS_LINE, opens + (48 + 12 + 1) * 60 * MIN).untimed).toBeUndefined();
    localStorage.removeItem("sleepcast2.watch-read"); // (the same data, read afresh)
    expect(importWatch(OPENS_LINE, opens + 49 * 60 * MIN).untimed).toEqual([{ startedAt: opens + 12 * 60 * MIN, why: "later" }]);
  });
  it("isn't said of a night at the window's edge, which no later run can time", () => {
    const edge = Date.parse("2026-10-05T11:00:00-07:00") + 60 * MIN;
    appendNight(night({ startedAt: edge }), Date.now());
    const r = importWatch(OPENS_LINE, edge - 60 * MIN + 48 * 60 * MIN);
    expect(r.untimed).toBeUndefined();
  });
});

describe("shortcutWindowOpens", () => {
  it("goes back two calendar days, at the same local time (47 or 49 h across DST)", () => {
    // (npm test pins TZ to America/Los_Angeles: DST began 2027-03-14.)
    const run = Date.parse("2027-03-15T08:00:00-07:00");
    expect(shortcutWindowOpens(run)).toBe(Date.parse("2027-03-13T08:00:00-08:00"));
    expect(run - shortcutWindowOpens(run)).toBe(47 * 60 * 60_000);
  });
});

describe("data already read, or from days ago", () => {
  beforeEach(() => localStorage.clear());
  const payload = `${OPENS_LINE}\n2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core`;
  it("is refused once read, so a link reopened from history changes nothing", () => {
    appendNight(night(), Date.now());
    expect(importWatch(payload, START + 10 * 60 * MIN).timed).toHaveLength(1);
    const r = importWatch(payload, START + 11 * 60 * MIN);
    expect(r).toMatchObject({ repeat: true, timed: [] });
    expect(isRefused(r)).toBe(true);
    expect(watchNotice(r)).toMatch(/read before/);
  });
  it("lets any fresh run through, however far back it reads", () => {
    appendNight(night(), Date.now());
    importWatch(payload, START + 10 * 60 * MIN);
    const wide = `window~2026-10-02T11:00:00-07:00\n2026-10-05T23:04:00-07:00~2026-10-05T23:30:00-07:00~Core`;
    expect(importWatch(wide, START + 11 * 60 * MIN)).toMatchObject({ repeat: false, stale: false, unchanged: 1 });
  });
  it("is refused when its newest sample is from days ago (a link read before this was kept)", () => {
    appendNight(night(), Date.now());
    const r = importWatch(payload, START + 7 * 24 * 60 * MIN);
    expect(r).toMatchObject({ stale: true, timed: [] });
    expect(watchNotice(r)).toMatch(/from days ago/);
  });
  it("isn't remembered from an import whose nights couldn't be saved", () => {
    appendNight(night(), Date.now());
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
      if (k === "sleepcast2.rest") throw new Error("QuotaExceededError");
      return setItem.call(this, k, v);
    };
    try {
      expect(importWatch(payload, START + 10 * 60 * MIN).unsaved).toBe(true);
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(importWatch(payload, START + 10 * 60 * MIN)).toMatchObject({ repeat: false, timed: [{ startedAt: START }] });
  });
  it("doesn't throw with storage blocked", () => {
    const get = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new Error("SecurityError"); } });
    try {
      expect(() => importWatch(payload, START + 10 * 60 * MIN)).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", get);
    }
  });
  it("isn't remembered from an import that was refused", () => {
    appendNight(night(), Date.now());
    importWatch(`${OPENS_LINE}\nnot a line`, START + 10 * 60 * MIN);
    expect(importWatch(payload, START + 10 * 60 * MIN).repeat).toBe(false);
  });
});

describe("no night in the window and no sleep", () => {
  beforeEach(() => localStorage.clear());
  it("doesn't ask for a run that can't time a night", () => {
    appendNight(night({ startedAt: START - 4 * 24 * 60 * MIN }), Date.now());
    const r = importWatch(OPENS_LINE, START + 10 * 60 * MIN);
    expect(watchNotice(r)).toBe("nothing from your watch yet: run it after a sleepcast night (and check sleep tracking is on).");
  });
});

describe("a night asleep at its start, read again the next morning", () => {
  beforeEach(() => localStorage.clear());
  it("is said on each run that finds it, newest night or not", () => {
    appendNight(night(), Date.now());
    const payload = `${OPENS_LINE}\n2026-10-05T22:50:00-07:00~2026-10-06T02:00:00-07:00~Core`;
    expect(importWatch(payload, START + 10 * 60 * MIN).untimed).toEqual([{ startedAt: START, why: "asleep" }]);
    appendNight(night({ startedAt: START + 24 * 60 * MIN }), Date.now());
    // The next morning's run (a later window). (The newer night, its sleep
    // not handed over yet, is said too.)
    expect(importWatch(payload.replace("11:00:00", "12:00:00"), START + 34 * 60 * MIN).untimed).toEqual([
      { startedAt: START, why: "asleep" },
      { startedAt: START + 24 * 60 * MIN, why: "later" },
    ]);
  });
});

describe("a killed night recorded without a time a later run could give", () => {
  beforeEach(() => localStorage.clear());
  it("is still said, with why it has no time", () => {
    const live = { savedAt: START + 10 * MIN, remainingMs: 0, totalSeconds: 0, position: 0, current: { id: "e1", title: "", url: "", feedId: "f", date: "" }, playedIds: [], pool: [], skipIntroByFeedId: {}, feedTitles: {}, artworkByFeedId: {}, nightStartedAt: START, modeKind: "all-night" };
    localStorage.setItem("sleepcast2.live", JSON.stringify(live));
    const r = importWatch(`${OPENS_LINE}\n2026-10-05T22:50:00-07:00~2026-10-06T02:00:00-07:00~Core`, START + 10 * 60 * MIN);
    expect(r.untimed).toEqual([{ startedAt: START, why: "asleep" }]);
    // Asleep through its start: said as the reason it has no time.
    expect(watchNotice(r)).toMatch(/^\w+ \w+ has no watch time: your watch had you asleep before sleepcast started\.$/);
  });
});

describe("pasting a link without its url-encode step, and looser dates", () => {
  it("takes the rest of the paste after the link, blank lines and all", () => {
    const pasted = "look: https://sleepcast.pro/#watch=window~2026-10-04T09:00:00+01:00\n\n2026-10-05T23:20:00+01:00~2026-10-05T23:50:00+01:00~Core.";
    expect(payloadFromPaste(pasted)).toBe("window~2026-10-04T09:00:00+01:00\n\n2026-10-05T23:20:00+01:00~2026-10-05T23:50:00+01:00~Core");
    expect(parseWatchPayload(payloadFromPaste(pasted)).samples).toHaveLength(1);
  });
  it("reads a space before the time, and normalises a lowercase z (for Safari)", () => {
    expect(parseWatchPayload("window~2026-10-04 09:00:00Z").windowStart).toBe(Date.parse("2026-10-04T09:00:00Z"));
    expect(normaliseIso("2026-10-04 09:00:00z")).toBe("2026-10-04T09:00:00Z");
    expect(normaliseIso("2026-10-04t09:00:00+01:00")).toBe("2026-10-04T09:00:00+01:00");
  });
  it("refuses, rather than guesses away, what else comes with an unencoded link", () => {
    const w = "window~2026-10-04T09:00:00+01:00";
    const s = "2026-10-05T23:20:00+01:00~2026-10-05T23:50:00+01:00~Core";
    expect(parseWatchPayload(payloadFromPaste(`https://sleepcast.pro/#watch=${w}\n${s}\nsent from my iphone`)).malformed).toBe(1);
    expect(parseWatchPayload(payloadFromPaste(`https://sleepcast.pro/#watch=${w} ${s}`)).badWindow).toBe(true);
    expect(parseWatchPayload(payloadFromPaste(`> https://sleepcast.pro/#watch=${w}\n> ${s}`)).malformed).toBe(1);
    expect(parseWatchPayload(payloadFromPaste(`https://sleepcast.pro/#watch=${w}\n${s}~iPhone`)).malformed).toBe(1);
  });
  it("reads a percent-encoded link as one token, with words after it", () => {
    const link = "https://sleepcast.pro/#watch=" + encodeURIComponent("window~2026-10-04T09:00:00+01:00\n2026-10-05T23:20:00+01:00~2026-10-05T23:50:00+01:00~Core");
    expect(payloadFromPaste(`see ${encodeURIComponent(link)} thanks`)).toBe("window~2026-10-04T09:00:00+01:00\n2026-10-05T23:20:00+01:00~2026-10-05T23:50:00+01:00~Core");
  });
  it("reads a link encoded in part, or wrapped, whole, so it refuses rather than imports a prefix", () => {
    const s = "2026-10-05T23:20:00+01:00~2026-10-05T23:50:00+01:00~Core";
    const partly = parseWatchPayload(payloadFromPaste(`https://sleepcast.pro/#watch=window~2026-10-04T09:00:00%2B01:00\n${s}`));
    expect(partly.samples).toHaveLength(1);
    const enc = encodeURIComponent(`window~2026-10-04T09:00:00+01:00\n${s}\n${s.replaceAll("23:", "22:")}`);
    const cut = enc.indexOf("%0A", enc.indexOf("%0A") + 1) + 3;
    const wrapped = parseWatchPayload(payloadFromPaste(`https://sleepcast.pro/#watch=${enc.slice(0, cut)}\n${enc.slice(cut)}`));
    expect(wrapped.malformed + wrapped.samples.length).toBeGreaterThan(1);
  });
  it("decodes an unencoded link's escapes as the link would, and keeps a last ~ or )", () => {
    const w = "window~2026-10-04T09:00:00+01:00";
    expect(payloadFromPaste(`https://sleepcast.pro/#watch=${w}\na~b~In%20Bed`)).toBe(`${w}\na~b~In Bed`);
    expect(parseWatchPayload(payloadFromPaste(`https://sleepcast.pro/#watch=${w}\n2026-10-05T23:20:00+01:00~2026-10-05T23:50:00+01:00~Core~`)).malformed).toBe(1);
    expect(payloadFromPaste(`https://sleepcast.pro/#watch=${w}\na~b~Asleep (Core)`)).toBe(`${w}\na~b~Asleep (Core)`);
  });
  it("can't tell a known stage with words after it from another language's, so refuses either", () => {
    const r = parseWatchPayload("window~2026-10-04T09:00:00+01:00\n2026-10-05T23:20:00+01:00~2026-10-05T23:50:00+01:00~Core thanks");
    expect([r.malformed, r.unrecognised]).toEqual([0, 1]);
    expect(parseWatchPayload("window~2026-10-04T09:00:00+01:00\n2026-10-05T23:20:00+01:00~2026-10-05T23:50:00+01:00~REM Uykusu").unrecognised).toBe(1);
    expect(parseWatchPayload("window~2026-10-04T09:00:00+01:00\n2026-10-05T23:20:00+01:00~2026-10-05T23:50:00+01:00~REM Sleep").samples).toHaveLength(1);
  });
  it("reads a link pasted fully percent-encoded", () => {
    const link = "https://sleepcast.pro/#watch=" + encodeURIComponent("window~2026-10-04T09:00:00+01:00\n2026-10-05T23:20:00+01:00~2026-10-05T23:50:00+01:00~Core");
    expect(payloadFromPaste(encodeURIComponent(link))).toBe("window~2026-10-04T09:00:00+01:00\n2026-10-05T23:20:00+01:00~2026-10-05T23:50:00+01:00~Core");
  });
  it("keeps a malformed line, and a window line run into a sample, so they refuse", () => {
    const w = "window~2026-10-04T09:00:00+01:00";
    const pasted = payloadFromPaste(`https://sleepcast.pro/#watch=${w}\n2026-10-05~2026-10-05T23:50:00+01:00~Core`);
    expect(parseWatchPayload(pasted).malformed).toBe(1);
    const runIn = payloadFromPaste(`https://sleepcast.pro/#watch=${w}2026-10-05T23:20:00+01:00~2026-10-05T23:50:00+01:00~Core`);
    expect(parseWatchPayload(runIn).badWindow).toBe(true);
  });
  it("keeps a space-separated window date whole, and an encoded window-only link with a ~ after it", () => {
    expect(payloadFromPaste("https://sleepcast.pro/#watch=window~2026-10-04 09:00:00+01:00.")).toBe("window~2026-10-04 09:00:00+01:00");
    expect(payloadFromPaste("https://sleepcast.pro/#watch=window~2026-10-04T09%3A00%3A00%2B01%3A00\napprox ~7h")).toBe("window~2026-10-04T09:00:00+01:00");
  });
});
