import { describe, it, expect, beforeEach } from "vitest";
import { dropKeptTimer, keepTimer, keptTimer } from "./kept-timer";

describe("kept timer", () => {
  beforeEach(() => localStorage.clear());

  it("none until one is kept; kept until dropped", () => {
    expect(keptTimer()).toBeNull();
    keepTimer({ minutes: 25, beat: 45 });
    expect(keptTimer()).toEqual({ minutes: 25, beat: 45 });
    dropKeptTimer();
    expect(keptTimer()).toBeNull();
  });

  it("ignores a saved value that isn't a timer", () => {
    localStorage.setItem("sleepcast2.keptTimer", JSON.stringify({ minutes: 9000, beat: 45 }));
    expect(keptTimer()).toBeNull();
    localStorage.setItem("sleepcast2.keptTimer", "not json");
    expect(keptTimer()).toBeNull();
  });
});
