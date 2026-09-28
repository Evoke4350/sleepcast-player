import { describe, expect, test } from "vitest";
import { knownDuration, shortOfEnd } from "./duration";

describe("durations", () => {
  test("knownDuration: finite and positive only", () => {
    expect(knownDuration(90)).toBe(90);
    expect(knownDuration(NaN)).toBeNull();
    expect(knownDuration(0)).toBeNull();
    expect(knownDuration(Infinity)).toBeNull();
  });
  test("shortOfEnd: within the episode, a second short of a known end", () => {
    expect(shortOfEnd(60, 40)).toBe(39);
    expect(shortOfEnd(-5, 40)).toBe(0);
    expect(shortOfEnd(60, null)).toBe(60);
    expect(shortOfEnd(10, 0.6)).toBe(0);
  });
});
