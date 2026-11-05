import { describe, it, expect, beforeEach } from "vitest";
import { oldEnough, storedAge, saveAge, retryAt, clearAge, AGE_KEY, RETRY_AFTER_MS } from "./age";

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

describe("changing a too-young answer", () => {
  beforeEach(() => localStorage.clear());
  it("can be done a day after it was given", () => {
    saveAge("under", 1_000);
    expect(retryAt()).toBe(1_000 + RETRY_AFTER_MS);
    clearAge();
    expect(storedAge()).toBeNull();
    expect(retryAt()).toBeNull();
  });
  it("at once for an answer kept without a time", () => {
    localStorage.setItem(AGE_KEY, "under");
    expect(retryAt()).toBe(0);
  });
  it("doesn't apply to old enough", () => {
    saveAge("ok");
    expect(retryAt()).toBeNull();
  });
});
