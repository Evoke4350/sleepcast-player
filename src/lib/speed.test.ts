import { describe, expect, it, beforeEach } from "vitest";
import { nextSpeed, realSeconds, sanitizeSpeeds, speedLabel, SPEEDS } from "./speed";
import { loadSpeed, saveSpeed, loadState } from "./store";

describe("speed", () => {
  it("steps through the speeds and wraps", () => {
    expect(SPEEDS.map(nextSpeed)).toEqual([0.9, 1, 1.25, 1.5, 0.8]);
    expect(nextSpeed(1.1)).toBe(1); // not on the list
  });

  it("labels", () => {
    expect([0.8, 1, 1.25].map(speedLabel)).toEqual(["0.8×", "1×", "1.25×"]);
  });

  it("episode seconds become real seconds", () => {
    expect(realSeconds(90, 0.9)).toBeCloseTo(100);
    expect(realSeconds(150, 1.5)).toBe(100);
    expect(realSeconds(null, 0.8)).toBeNull();
    expect(realSeconds(60, 0)).toBe(60);
  });

  it("keeps only listed speeds other than 1", () => {
    expect(sanitizeSpeeds({ a: 0.8, b: 1, c: 3, d: "0.9", e: 1.5 })).toEqual({ a: 0.8, e: 1.5 });
    expect(sanitizeSpeeds(null)).toEqual({});
  });
});

describe("speed per show, stored", () => {
  beforeEach(() => localStorage.clear());

  it("is 1 until picked, then kept per show", () => {
    expect(loadSpeed("swm")).toBe(1);
    saveSpeed("swm", 0.8);
    saveSpeed("other", 1.25);
    expect(loadSpeed("swm")).toBe(0.8);
    expect(loadSpeed("other")).toBe(1.25);
  });

  it("back to 1 forgets it", () => {
    saveSpeed("swm", 0.9);
    saveSpeed("swm", 1);
    expect(loadSpeed("swm")).toBe(1);
    expect(loadState().settings.feedSpeed ?? {}).toEqual({});
  });

  it("drops a stored speed the controls can't set", () => {
    const s = loadState();
    localStorage.setItem("sleepcast2.state", JSON.stringify({ ...s, settings: { ...s.settings, feedSpeed: { swm: 4 } } }));
    expect(loadSpeed("swm")).toBe(1);
  });
});
