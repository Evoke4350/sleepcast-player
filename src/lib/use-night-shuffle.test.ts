import { describe, expect, it } from "vitest";
import { shuffleFor } from "./use-night-shuffle";
import { lineupLean } from "./rest/sleepscore";

describe("shuffleFor", () => {
  it("no lean: a plain shuffle, recorded plain", () => {
    expect(shuffleFor(undefined)).toEqual({ lean: undefined, weightOf: undefined });
  });
  it("a lean: its weights, 1 for feeds it doesn't name (inherited keys included)", () => {
    const s = shuffleFor(lineupLean((f) => (f === "good" ? 1.5 : 1), [{ feedId: "good" }, { feedId: "x" }]));
    expect(s.lean).toEqual({ good: 1.5 });
    expect(s.weightOf?.("good")).toBe(1.5);
    expect(s.weightOf?.("x")).toBe(1);
    expect(s.weightOf?.("constructor")).toBe(1);
  });
});
