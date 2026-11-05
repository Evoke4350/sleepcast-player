import { describe, it, expect, beforeEach } from "vitest";
import { oldEnough, storedAge, saveAge, AGE_KEY } from "./age";

describe("oldEnough", () => {
  const now = new Date(2026, 10, 5); // 5 November 2026
  it("lets in anyone who turned 13 before this month", () => {
    expect(oldEnough(2013, 10, now)).toBe(true);
    expect(oldEnough(1980, 1, now)).toBe(true);
  });
  it("turns away anyone younger", () => {
    expect(oldEnough(2013, 12, now)).toBe(false);
    expect(oldEnough(2020, 1, now)).toBe(false);
  });
  it("counts a birthday this month as not yet", () => {
    expect(oldEnough(2013, 11, now)).toBe(false);
    expect(oldEnough(2012, 11, now)).toBe(true);
  });
});

describe("the stored answer", () => {
  beforeEach(() => localStorage.clear());
  it("keeps only ok or under", () => {
    expect(storedAge()).toBeNull();
    saveAge("under");
    expect(storedAge()).toBe("under");
    localStorage.setItem(AGE_KEY, "2010-04");
    expect(storedAge()).toBeNull();
  });
});
