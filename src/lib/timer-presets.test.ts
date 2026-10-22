import { describe, it, expect } from "vitest";
import { TIMER_PRESETS, DEFAULT_TIMER_MINUTES, canExtend, MAX_EXTENSIONS } from "./timer-presets";

describe("timer presets", () => {
  it("are four minute values, the default among them", () => {
    expect(TIMER_PRESETS).toEqual([25, 45, 75, 110]);
    expect(TIMER_PRESETS).toContain(DEFAULT_TIMER_MINUTES);
  });
  it("allow MAX_EXTENSIONS stretches a night, and no more", () => {
    expect(canExtend(MAX_EXTENSIONS - 1)).toBe(true);
    expect(canExtend(MAX_EXTENSIONS)).toBe(false);
  });
});
