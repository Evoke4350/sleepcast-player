import { describe, it, expect } from "vitest";
import { TRIM_STEPS, nextTrim } from "./leveler";

describe("nextTrim", () => {
  it("steps up and down the scale", () => {
    expect(nextTrim(1.0, 1)).toBe(1.25);
    expect(nextTrim(1.0, -1)).toBe(0.75);
  });
  it("clamps at the ends", () => {
    expect(nextTrim(1.5, 1)).toBe(1.5);
    expect(nextTrim(0.5, -1)).toBe(0.5);
  });
  it("snaps unknown values to nearest step first", () => {
    expect(nextTrim(1.1, 1)).toBe(1.25);
    expect(nextTrim(0.6, -1)).toBe(0.5);
  });
  it("exposes the canonical five steps", () => {
    expect(TRIM_STEPS).toEqual([0.5, 0.75, 1.0, 1.25, 1.5]);
  });
});

import { Leveler } from "./leveler";

describe("Leveler", () => {
  it("attach() returns false where Web Audio is unavailable and never throws", () => {
    const audio = document.createElement("audio");
    const lv = new Leveler(audio);
    expect(lv.attach()).toBe(false);
    lv.dispose(); // must not throw either
  });
});
