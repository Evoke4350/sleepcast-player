import { describe, expect, test } from "vitest";
import { heardDelta } from "./heard";

describe("heardDelta", () => {
  test("a forward step under 5 s is listening", () => {
    expect(heardDelta(10, 10.25, false)).toBe(0.25);
  });
  test("seeks, backward steps and enforced seeks are not", () => {
    expect(heardDelta(10, 300, false)).toBe(0);
    expect(heardDelta(10, 5, false)).toBe(0);
    expect(heardDelta(0, 1.8, true)).toBe(0);
  });
});
