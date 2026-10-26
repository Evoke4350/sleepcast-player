import { describe, it, expect } from "vitest";
import type { RestNight, SleepStretch } from "./types";
import { byShow, minutesAfterNoon, sleepRecords, typical } from "./trends";

const MIN = 60_000;
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();
const st = (from: number, to: number, stage: SleepStretch["stage"]): SleepStretch => ({ from: from * MIN, to: to * MIN, stage });

function night(startedAt: number, over: Partial<RestNight> = {}): RestNight {
  return {
    startedAt, timerMinutes: 45, endedVia: "faded", sleptAtMs: 20 * MIN, timeToSleepMs: 20 * MIN, interactions: 0,
    detector: "hr", watchSleptAfterMs: 20 * MIN, playedMs: 45 * MIN, onsetFeedId: "swm",
    watchSleep: [st(0, 20, "awake"), st(20, 200, "core"), st(200, 260, "deep"), st(260, 420, "rem")],
    ...over,
  };
}

describe("minutesAfterNoon", () => {
  it("runs on past midnight, so a night's times sort and average", () => {
    expect(minutesAfterNoon(at(20, 12))).toBe(0);
    expect(minutesAfterNoon(at(20, 23))).toBe(660);
    expect(minutesAfterNoon(at(21, 1, 30))).toBe(810);
  });
});

describe("sleepRecords", () => {
  it("one per watched night, with its figures", () => {
    const [r] = sleepRecords([night(at(20, 23))]);
    expect(r).toMatchObject({
      fellAsleepAt: at(20, 23, 20), wokeAt: at(20, 23) + 420 * MIN, asleepMs: 400 * MIN,
      deepMs: 60 * MIN, remMs: 160 * MIN, toSleepMs: 20 * MIN, onsetFeedId: "swm", playedMs: 45 * MIN,
    });
  });
  it("skips nights without stages", () => {
    expect(sleepRecords([night(at(20, 23), { watchSleep: undefined })])).toEqual([]);
  });
  it("joins a 3am re-anchor to the sleep it continues", () => {
    const first = night(at(20, 23), { watchSleep: [st(0, 20, "awake"), st(20, 240, "core")] });
    const second = night(at(21, 3), { watchSleep: [st(0, 10, "awake"), st(10, 200, "core")], onsetFeedId: "nmh" });
    const rs = sleepRecords([first, second]);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ asleepMs: 410 * MIN, wakings: 1, awakeMs: 10 * MIN, wokeAt: at(21, 3) + 200 * MIN, onsetFeedId: "swm" });
  });
});

describe("typical", () => {
  it("the middle night, across midnight", () => {
    const t = typical(sleepRecords([night(at(20, 23)), night(at(21, 23, 30)), night(at(23, 0, 30))]))!;
    expect(t.bedtime).toBe(690); // 11:30pm, not a noon average of 11pm and 12:30am
    expect(t.toSleepMs).toBe(20 * MIN);
    expect(t.nights).toBe(3);
  });
  it("null with no nights", () => {
    expect(typical([])).toBeNull();
  });
});

describe("byShow", () => {
  it("shows with 2 or more sleeps, quickest to sleep first", () => {
    const rs = sleepRecords([
      night(at(18, 23), { onsetFeedId: "a", watchSleptAfterMs: 30 * MIN }),
      night(at(19, 23), { onsetFeedId: "a", watchSleptAfterMs: 40 * MIN }),
      night(at(20, 23), { onsetFeedId: "b", watchSleptAfterMs: 10 * MIN }),
      night(at(21, 23), { onsetFeedId: "b", watchSleptAfterMs: 20 * MIN }),
      night(at(22, 23), { onsetFeedId: "c" }),
      night(at(23, 23), { onsetFeedId: undefined }),
    ]);
    expect(byShow(rs).map((s) => [s.feedId, s.nights, s.toSleepMs / MIN])).toEqual([["b", 2, 15], ["a", 2, 35]]);
  });
});
