import { describe, expect, test } from "vitest";
import { applyEndedDecision, decideAfterEnded, shouldPlayWhole, type EndedInput } from "./episode-end";
import { PlaybackWitness } from "./witness";

const base: EndedInput = { stopping: false, active: true, playedThisEpisode: true, replayedFromStart: false, mode: "minutes" };

describe("decideAfterEnded", () => {
  test("a heard episode that ends moves to the next", () => {
    expect(decideAfterEnded(base)).toEqual({ action: "next" });
  });

  test("one-episode mode ends the night", () => {
    expect(decideAfterEnded({ ...base, mode: "one-episode" })).toEqual({ action: "end-night", reason: "faded" });
  });

  test("ending under the courtesy fade ends the night, whatever else is true", () => {
    expect(decideAfterEnded({ ...base, stopping: true, playedThisEpisode: false })).toEqual({ action: "end-night", reason: "ended" });
  });

  test("a stale event after the night stopped is ignored", () => {
    expect(decideAfterEnded({ ...base, active: false })).toEqual({ action: "ignore" });
  });

  // A Short past a long skip-intro loads past its end. Written off at once,
  // a Shorts feed played nothing; treated as a finish, it looped in silence.
  test("an episode that ends unheard is replayed from the start once", () => {
    expect(decideAfterEnded({ ...base, playedThisEpisode: false })).toEqual({ action: "replay-from-start" });
  });

  test("and skipped for the night if it ends unheard again", () => {
    expect(decideAfterEnded({ ...base, playedThisEpisode: false, replayedFromStart: true })).toEqual({ action: "skip-dead" });
  });

  test("the unheard rule applies in one-episode mode too, before ending the night", () => {
    expect(decideAfterEnded({ ...base, mode: "one-episode", playedThisEpisode: false })).toEqual({ action: "replay-from-start" });
  });
});

describe("shouldPlayWhole", () => {
  const started = (start: number, heardBefore = false) => {
    const w = new PlaybackWitness();
    w.newEpisode(start, 1_000, heardBefore);
    return w;
  };

  test("a start within 30 s of the end plays the episode whole", () => {
    expect(shouldPlayWhole(started(600), 620)).toBe(true);
  });

  // The duration usually arrives after the load's first second has counted.
  test("still true once this load's own playback has been heard", () => {
    const w = started(600);
    w.observe(601, 2_000, true);
    expect(w.heard).toBe(true);
    expect(shouldPlayWhole(w, 620)).toBe(true);
  });

  test("not for an episode heard before this load (revived, or retried near its end)", () => {
    expect(shouldPlayWhole(started(600, true), 620)).toBe(false);
    const w = started(0);
    w.observe(1, 2_000, true);
    w.reset(3590, 3_000);
    expect(shouldPlayWhole(w, 3600)).toBe(false);
  });

  test("not twice, not from 0, not without a duration, not far from the end", () => {
    const w = started(600);
    w.markReplayed();
    expect(shouldPlayWhole(w, 620)).toBe(false);
    expect(shouldPlayWhole(started(0), 20)).toBe(false);
    expect(shouldPlayWhole(started(600), 0)).toBe(false);
    expect(shouldPlayWhole(started(60), 3600)).toBe(false);
  });
});

describe("applyEndedDecision", () => {
  const hooks = () => {
    const calls: string[] = [];
    return {
      calls,
      h: {
        replay: () => calls.push("replay"),
        endNight: (r: string) => calls.push(`end:${r}`),
        skipDead: () => calls.push("skip"),
        next: () => calls.push("next"),
        forgetPosition: () => calls.push("forget"),
      },
    };
  };

  test("each outcome runs its hook; the position is kept only for ignore and replay", () => {
    const cases: Array<[Parameters<typeof applyEndedDecision>[0], string[]]> = [
      [{ action: "ignore" }, []],
      [{ action: "replay-from-start" }, ["replay"]],
      [{ action: "end-night", reason: "faded" }, ["forget", "end:faded"]],
      [{ action: "skip-dead" }, ["forget", "skip"]],
      [{ action: "next" }, ["forget", "next"]],
    ];
    for (const [d, want] of cases) {
      const { calls, h } = hooks();
      applyEndedDecision(d, h);
      expect(calls).toEqual(want);
    }
  });
});
