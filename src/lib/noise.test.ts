import { describe, it, expect } from "vitest";
import { noiseGain, BrownNoise } from "./noise";

describe("noiseGain", () => {
  it("scales level by the fade driver", () => {
    expect(noiseGain(0.2, 120, 60)).toBeCloseTo(0.2);
    expect(noiseGain(0.2, 30, 60)).toBeCloseTo(0.1);
    expect(noiseGain(0.2, 0, 60)).toBe(0);
  });
  it("steady at level when driver is Infinity (all-night)", () => {
    expect(noiseGain(0.25, Infinity, 60)).toBeCloseTo(0.25);
  });
  it("clamps level to 0.3", () => {
    expect(noiseGain(9, Infinity, 60)).toBe(0.3);
  });
});

describe("BrownNoise", () => {
  it("reports unsupported in jsdom and start() resolves false without throwing", async () => {
    expect(BrownNoise.supported()).toBe(false);
    const n = new BrownNoise();
    await expect(n.start()).resolves.toBe(false);
    n.setGain(0.1); // no-op, must not throw
    n.stop(); // idempotent, must not throw
  });
});
