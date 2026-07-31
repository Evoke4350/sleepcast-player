import { describe, it, expect } from "vitest";
import { FEEL_PRESETS, labelForMinutes, DEFAULT_FEEL_MINUTES, canExtend, MAX_EXTENSIONS } from "./timer-feel";

describe("timer-feel", () => {
  it("has the four documented presets, ascending", () => {
    expect(FEEL_PRESETS.map((p) => p.minutes)).toEqual([25, 45, 75, 110]);
    expect(FEEL_PRESETS.map((p) => p.label)).toEqual([
      "a short drift", "a while", "a long while", "the whole way",
    ]);
  });
  it("default is 45 = 'a while'", () => {
    expect(DEFAULT_FEEL_MINUTES).toBe(45);
    expect(labelForMinutes(DEFAULT_FEEL_MINUTES)).toBe("a while");
  });
  it("labelForMinutes returns exact-match labels", () => {
    expect(labelForMinutes(25)).toBe("a short drift");
    expect(labelForMinutes(110)).toBe("the whole way");
  });
  it("labelForMinutes returns null for non-preset (custom) minutes", () => {
    expect(labelForMinutes(60)).toBeNull();
    expect(labelForMinutes(30)).toBeNull();
  });
});

describe("canExtend", () => {
  it("allows the first few extensions without comment", () => {
    expect(canExtend(0)).toBe(true);
    expect(canExtend(MAX_EXTENSIONS - 1)).toBe(true);
  });

  it("stops offering once the cap is reached", () => {
    // Unlimited "a little longer" is the 3am doom loop: awake, extend, still
    // awake, extend. Past the cap the app should stop helping you stay up.
    expect(canExtend(MAX_EXTENSIONS)).toBe(false);
    expect(canExtend(MAX_EXTENSIONS + 5)).toBe(false);
  });

  it("caps at three — 45 extra minutes, enough for daytime listening too", () => {
    expect(MAX_EXTENSIONS).toBe(3);
  });
});
