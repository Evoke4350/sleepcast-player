import { describe, it, expect, beforeEach } from "vitest";
import { latestToKeep, loadManualSaves, pinnedUrls, sanitizeKeep, toggleManualSave } from "./keep-latest";
import { loadKeepLatest, saveKeepLatest } from "./store";

const ep = (n: number, date: string, url = `https://cdn/${n}.mp3`) => ({ url, date });

describe("keep latest", () => {
  beforeEach(() => localStorage.clear());

  it("picks the newest n that can be saved, whatever the feed's order", () => {
    const eps = [ep(1, "2026-11-01"), ep(3, "2026-11-03"), ep(2, "2026-11-02"), ep(9, "2026-11-09", "http://plain/9.mp3")];
    expect(latestToKeep(eps, 2).map((e) => e.url)).toEqual(["https://cdn/3.mp3", "https://cdn/2.mp3"]);
    expect(latestToKeep(eps, 0)).toEqual([]);
  });

  it("pins by-hand saves first, then each show's latest, no URL twice", () => {
    const byFeed = { a: [ep(1, "2026-11-01"), ep(2, "2026-11-02")], b: [ep(5, "2026-11-05")] };
    expect(pinnedUrls({ a: 3, b: 1 }, byFeed, ["https://cdn/2.mp3", "https://x/hand.mp3"])).toEqual([
      "https://cdn/2.mp3", "https://x/hand.mp3", "https://cdn/1.mp3", "https://cdn/5.mp3",
    ]);
    expect(pinnedUrls({}, byFeed, [])).toEqual([]);
  });

  it("by-hand saves toggle and persist", () => {
    expect(toggleManualSave("https://x/a.mp3")).toBe(true);
    expect(loadManualSaves()).toEqual(["https://x/a.mp3"]);
    expect(toggleManualSave("https://x/a.mp3")).toBe(false);
    expect(localStorage.getItem("sleepcast2.saved")).toBeNull();
  });

  it("the per-show count is a setting, limited to the choices", () => {
    saveKeepLatest("a", 5);
    saveKeepLatest("b", 3);
    expect(loadKeepLatest()).toEqual({ a: 5, b: 3 });
    saveKeepLatest("a", 0);
    expect(loadKeepLatest()).toEqual({ b: 3 });
    expect(sanitizeKeep({ a: 3, b: 4, c: 0, d: "5" })).toEqual({ a: 3 });
  });
});
