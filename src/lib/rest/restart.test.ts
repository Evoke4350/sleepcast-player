import { describe, it, expect, beforeEach } from "vitest";
import { overturnOnRestart, noteNightStart, undecided, RESTART_WITHIN_MS } from "./restart";
import { appendNight, loadNights, setSelfLabel, isSlept } from "./ledger";
import type { RestNight } from "./types";

const MIN = 60_000;
const night = (over: Partial<RestNight> = {}): RestNight => ({
  startedAt: 0, timerMinutes: 45, endedVia: "faded",
  sleptAtMs: 20 * MIN, timeToSleepMs: 20 * MIN, interactions: 0, detector: "inference",
  playedMs: 45 * MIN, onsetFeedId: "swm", onsetEpisodeId: "e1", onsetAfterMs: 5 * MIN,
  sleptThrough: ["nsp"], detectorAtMs: 19 * MIN, ...over,
});
const END = 45 * MIN;

describe("overturnOnRestart", () => {
  it("takes back the guess when a night starts within minutes of the stop", () => {
    const out = overturnOnRestart([night({ startedAt: -1 }), night()], END + 2 * MIN);
    expect(out).toHaveLength(2);
    const last = out![1];
    expect(last).toMatchObject({ sleptAtMs: null, timeToSleepMs: null, detector: "none", restartedAfter: true, playedMs: 45 * MIN, restartGuess: { sleptAtMs: 20 * MIN } });
    for (const k of ["onsetFeedId", "onsetEpisodeId", "onsetAfterMs", "sleptThrough", "detectorAtMs"]) expect(last).not.toHaveProperty(k);
    expect(out![0].sleptAtMs).toBe(20 * MIN); // only the last night
  });

  it("leaves it once the window has passed", () => {
    expect(overturnOnRestart([night()], END + RESTART_WITHIN_MS)).not.toBeNull();
    expect(overturnOnRestart([night()], END + RESTART_WITHIN_MS + 1)).toBeNull();
  });

  it("leaves nights it has no business with", () => {
    const soon = END + MIN;
    expect(overturnOnRestart([], soon)).toBeNull();
    expect(overturnOnRestart([night({ endedVia: "ended" })], soon)).toBeNull();
    expect(overturnOnRestart([night({ detector: "hr" })], soon)).toBeNull();
    expect(overturnOnRestart([night({ sleptAtMs: null, timeToSleepMs: null, detector: "none" })], soon)).toBeNull();
    expect(overturnOnRestart([night({ selfLabel: "slept" })], soon)).toBeNull();
    expect(overturnOnRestart([night({ playedMs: undefined })], soon)).toBeNull();
    expect(overturnOnRestart([night()], END - MIN)).toBeNull(); // a clock behind the stop
  });
});

describe("noteNightStart", () => {
  beforeEach(() => localStorage.clear());

  it("rewrites the ledger only when something changes", () => {
    appendNight(night());
    noteNightStart(END + 10 * MIN);
    expect(loadNights()[0].sleptAtMs).toBe(20 * MIN);
    noteNightStart(END + MIN);
    expect(loadNights()[0]).toMatchObject({ sleptAtMs: null, restartedAfter: true });
  });
});

describe("a night set aside, then answered", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the guess, and puts it back when you say you fell asleep", () => {
    appendNight(night());
    noteNightStart(END + MIN);
    const set = loadNights()[0];
    expect(set.restartGuess).toMatchObject({ sleptAtMs: 20 * MIN, detector: "inference", onsetFeedId: "swm", sleptThrough: ["nsp"] });
    expect(undecided(set)).toBe(true);
    const back = setSelfLabel(0, "slept")!;
    expect(back).toMatchObject({ sleptAtMs: 20 * MIN, timeToSleepMs: 20 * MIN, detector: "inference", onsetFeedId: "swm", selfLabel: "slept", restartedAfter: true });
    expect(back).not.toHaveProperty("restartGuess");
    expect(isSlept(back)).toBe(true);
    expect(undecided(back)).toBe(false);
  });

  it("stays not slept when you say you were awake", () => {
    appendNight(night());
    noteNightStart(END + MIN);
    const n = setSelfLabel(0, "awake")!;
    expect(n.sleptAtMs).toBeNull();
    expect(isSlept(n)).toBe(false);
    expect(undecided(n)).toBe(false);
  });
});
