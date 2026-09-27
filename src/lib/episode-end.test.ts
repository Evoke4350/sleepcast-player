import { describe, expect, test } from "vitest";
import { decideAfterEnded, type EndedInput } from "./episode-end";

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
