import { describe, expect, test } from "vitest";
import { barPosition, DurationLatch, knownDuration, remainingOf, shortOfEnd, spanOf } from "./duration";

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

describe("spans", () => {
  test("a known length keeps the position within it; unknown is null", () => {
    expect(spanOf(30, 600)).toEqual({ pos: 30, dur: 600 });
    expect(spanOf(700, 600)).toEqual({ pos: 600, dur: 600 });
    expect(spanOf(-5, 600)).toEqual({ pos: 0, dur: 600 });
    expect(spanOf(30, null)).toBeNull();
    expect(spanOf(30, NaN)).toBeNull();
    expect(spanOf(30, 0)).toBeNull();
    expect(spanOf(30, Infinity)).toBeNull();
    expect(remainingOf(spanOf(30, 600))).toBe(570);
    expect(remainingOf(null)).toBeNull();
  });

  test("the bar keeps its position when nothing changed", () => {
    const prev = { cur: 30, dur: 600 };
    expect(barPosition(prev, { pos: 30, dur: 600 })).toBe(prev);
    expect(barPosition(prev, { pos: 31, dur: 600 })).toEqual({ cur: 31, dur: 600 });
    expect(barPosition(prev, null)).toBeNull();
  });
});

describe("DurationLatch", () => {
  test("keeps the last known length through NaN until reset; Infinity (a stream) forgets it", () => {
    const l = new DurationLatch();
    expect(l.read(NaN)).toBeNull();
    expect(l.read(600)).toBe(600);
    expect(l.read(NaN)).toBe(600);
    expect(l.read(Infinity)).toBeNull();
    expect(l.read(NaN)).toBeNull();
    expect(l.read(610)).toBe(610);
    l.reset();
    expect(l.read(NaN)).toBeNull();
  });
});
