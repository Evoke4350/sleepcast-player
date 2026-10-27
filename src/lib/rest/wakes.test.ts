import { describe, it, expect } from "vitest";
import type { RestNight, SleepStretch } from "./types";
import { eventsWhileAsleep, tailProbability, wakeAudit, WAKE_WINDOW_MS } from "./wakes";

const MIN = 60_000;
const st = (from: number, to: number, stage: SleepStretch["stage"]): SleepStretch => ({ from: from * MIN, to: to * MIN, stage });
const ep = (t: number) => ({ t: t * MIN, feedId: "f", episodeId: `e${t}` });

function night(over: Partial<RestNight> = {}): RestNight {
  return {
    startedAt: 0, timerMinutes: 90, endedVia: "faded", sleptAtMs: 20 * MIN, timeToSleepMs: 20 * MIN, interactions: 0, detector: "hr",
    playedMs: 90 * MIN, episodes: [ep(0), ep(40), ep(70)],
    // asleep 20–600, woken 41–45 (after the episode at 40), never at 70 or 90.
    watchSleep: [st(0, 20, "awake"), st(20, 41, "core"), st(41, 45, "awake"), st(45, 600, "core")],
    ...over,
  };
}

describe("eventsWhileAsleep", () => {
  it("episode starts and the stop that came while asleep, and which woke you", () => {
    const evs = eventsWhileAsleep(night());
    expect(evs.map((e) => [e.t / MIN, e.cause, e.woke])).toEqual([[40, "episode", true], [70, "episode", false], [90, "stop", false]]);
    // one waking in 576 asleep minutes, a 3-minute window
    expect(evs[0].chance).toBeCloseTo((1 * WAKE_WINDOW_MS) / (576 * MIN));
  });
  it("leaves out the first episode, anything while awake, and a stop by hand", () => {
    const n = night({ episodes: [ep(0), ep(10)], endedVia: "abandoned" });
    expect(eventsWhileAsleep(n)).toEqual([]);
  });
  it("nothing for a night without stages", () => {
    expect(eventsWhileAsleep(night({ watchSleep: undefined }))).toEqual([]);
  });
  it("a waking more than the window after doesn't count", () => {
    const n = night({ watchSleep: [st(0, 20, "awake"), st(20, 44, "core"), st(44, 50, "awake"), st(50, 600, "core")] });
    expect(eventsWhileAsleep(n)[0]).toMatchObject({ t: 40 * MIN, woke: false });
  });
});

describe("tailProbability", () => {
  it("is the binomial tail when every chance is the same", () => {
    expect(tailProbability([0.5, 0.5], 1)).toBeCloseTo(0.75);
    expect(tailProbability([0.1, 0.1, 0.1], 0)).toBe(1);
    expect(tailProbability([0.1, 0.1, 0.1], 3)).toBeCloseTo(0.001);
  });
});

describe("wakeAudit", () => {
  it("says episode changes wake you when wakings follow them far more than chance", () => {
    const audit = wakeAudit(Array.from({ length: 6 }, (_, d) => night({ startedAt: d * 86_400_000 })));
    const episode = audit.find((a) => a.cause === "episode")!;
    expect(episode).toMatchObject({ events: 12, woke: 6, verdict: "wakes" });
    expect(episode.pValue).toBeLessThan(0.001);
    expect(audit.find((a) => a.cause === "stop")).toMatchObject({ events: 6, woke: 0, verdict: "doesnt" });
  });
  it("unclear on too few", () => {
    expect(wakeAudit([night()]).map((a) => a.verdict)).toEqual(["unclear", "unclear"]);
  });
});
