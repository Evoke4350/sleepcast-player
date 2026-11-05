import { describe, it, expect, beforeEach } from "vitest";
import { needsOnboarding, markOnboarded, applyStarterShows, STARTER_SHOWS } from "./onboarding";
import { loadState } from "./store";
import { AGE_KEY } from "./age";
import { CONSENT_KEY } from "./analytics";

beforeEach(() => localStorage.clear());

describe("needsOnboarding", () => {
  it("is true on a first visit, and false once done", () => {
    expect(needsOnboarding()).toBe(true);
    markOnboarded();
    expect(needsOnboarding()).toBe(false);
  });
  it("is false for anyone already using Sleepcast", () => {
    localStorage.setItem("sleepcast2.state", "{}");
    expect(needsOnboarding()).toBe(false);
    localStorage.clear();
    localStorage.setItem(AGE_KEY, "ok");
    expect(needsOnboarding()).toBe(false);
    localStorage.clear();
    localStorage.setItem(CONSENT_KEY, "denied");
    expect(needsOnboarding()).toBe(false);
  });
});

describe("applyStarterShows", () => {
  it("turns on the picked built-ins, off the rest, and adds catalog picks", () => {
    const catalogPick = STARTER_SHOWS.find((s) => !s.builtinId)!;
    applyStarterShows(new Set(["nmh", catalogPick.key]));
    const feeds = loadState().feeds;
    expect(feeds.filter((f) => f.enabled).map((f) => f.url)).toEqual([
      feeds.find((f) => f.id === "nmh")!.url,
      catalogPick.url,
    ]);
  });
  it("leaves the defaults when nothing is picked", () => {
    applyStarterShows(new Set());
    expect(localStorage.getItem("sleepcast2.state")).toBeNull();
  });
});
