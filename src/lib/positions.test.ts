import { describe, expect, it } from "vitest";
import {
  shouldRemember,
  putPosition,
  MIN_POSITION_SEC,
  END_MARGIN_SEC,
  POSITIONS_CAP,
  type Positions,
} from "./positions";

describe("shouldRemember", () => {
  it("remembers a position well inside a long episode", () => {
    expect(shouldRemember(1200, 5400)).toBe(true);
  });

  it("ignores the first minute — that is not a place you drifted off", () => {
    expect(shouldRemember(MIN_POSITION_SEC - 1, 5400)).toBe(false);
    expect(shouldRemember(MIN_POSITION_SEC, 5400)).toBe(true);
  });

  it("ignores a position near the end, which would resume into the outro", () => {
    expect(shouldRemember(5400 - END_MARGIN_SEC + 1, 5400)).toBe(false);
    expect(shouldRemember(5400 - END_MARGIN_SEC - 1, 5400)).toBe(true);
  });

  it("remembers when the duration is unknown, as long as we are past the floor", () => {
    // A stream with no metadata still deserves a resume point.
    expect(shouldRemember(600, NaN)).toBe(true);
    expect(shouldRemember(600, 0)).toBe(true);
    expect(shouldRemember(10, 0)).toBe(false);
  });

  it("rejects nonsense input rather than storing it", () => {
    expect(shouldRemember(NaN, 5400)).toBe(false);
    expect(shouldRemember(-5, 5400)).toBe(false);
  });
});

describe("putPosition", () => {
  it("records a position against an episode id", () => {
    expect(putPosition({}, "a", 300)).toEqual({ a: 300 });
  });

  it("overwrites an earlier position for the same episode", () => {
    expect(putPosition({ a: 100 }, "a", 300)).toEqual({ a: 300 });
  });

  it("does not mutate the map it was given", () => {
    const before: Positions = { a: 100 };
    putPosition(before, "b", 200);
    expect(before).toEqual({ a: 100 });
  });

  it("evicts the oldest-written entries once the cap is reached", () => {
    let p: Positions = {};
    for (let i = 0; i < POSITIONS_CAP + 5; i++) p = putPosition(p, `e${i}`, i + 100);
    expect(Object.keys(p)).toHaveLength(POSITIONS_CAP);
    expect(p["e0"]).toBeUndefined(); // first written, first dropped
    expect(p[`e${POSITIONS_CAP + 4}`]).toBe(POSITIONS_CAP + 104); // newest kept
  });
});
