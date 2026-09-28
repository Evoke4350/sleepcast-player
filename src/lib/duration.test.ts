import { describe, expect, test } from "vitest";
import { DurationLatch, knownDuration, shortOfEnd } from "./duration";

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

describe("DurationLatch", () => {
  test("keeps the last known length through NaN and Infinity, until reset", () => {
    const l = new DurationLatch();
    expect(l.read(NaN)).toBeNull();
    expect(l.read(600)).toBe(600);
    expect(l.read(NaN)).toBe(600);
    expect(l.read(Infinity)).toBe(600);
    expect(l.read(610)).toBe(610);
    l.reset();
    expect(l.read(NaN)).toBeNull();
  });
});
