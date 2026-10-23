import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildBackup, backupFilename, parseBackup, restoreBackup, summarizeStored } from "./backup";

const state = JSON.stringify({ feeds: [{ id: "a" }, { id: "b" }], settings: {} });

describe("backup", () => {
  beforeEach(() => localStorage.clear());

  it("takes the listener's data and leaves out caches and the night in progress", () => {
    localStorage.setItem("sleepcast2.state", state);
    localStorage.setItem("sleepcast2.rest", JSON.stringify([{ startedAt: 1 }]));
    localStorage.setItem("sleepcast2.timer", "45");
    localStorage.setItem("sleepcast2.feedcache.a", JSON.stringify({ at: 1, xml: "<rss/>" }));
    localStorage.setItem("sleepcast2.live", "{}");
    const b = buildBackup(new Date("2026-10-22T12:00:00Z"));
    expect(Object.keys(b.data).sort()).toEqual(["sleepcast2.rest", "sleepcast2.state", "sleepcast2.timer"]);
    expect(b).toMatchObject({ app: "sleepcast", version: 1, exportedAt: "2026-10-22T12:00:00.000Z" });
  });

  it("includes the default feeds and settings before anything was changed", () => {
    localStorage.setItem("sleepcast2.rest", JSON.stringify([{ startedAt: 1 }]));
    const parsed = parseBackup(JSON.stringify(buildBackup()));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.summary.feeds).toBeGreaterThan(0);
    expect(parsed.ok && parsed.summary.nights).toBe(1);
  });

  it("names the file by local date", () => {
    expect(backupFilename(new Date(2026, 0, 5, 23, 59))).toBe("sleepcast-backup-2026-01-05.json");
  });

  it("round-trips: restore puts back exactly what was backed up", () => {
    localStorage.setItem("sleepcast2.state", state);
    localStorage.setItem("sleepcast2.plays", JSON.stringify([{ id: "e" }, { id: "f" }, { id: "g" }]));
    localStorage.setItem("sleepcast2.rest", JSON.stringify([{ startedAt: 1 }, { startedAt: 2 }]));
    const text = JSON.stringify(buildBackup());
    localStorage.clear();
    localStorage.setItem("sleepcast2.blocked", JSON.stringify(["x"])); // not in the backup: goes
    localStorage.setItem("sleepcast2.cleanup", "done");
    const parsed = parseBackup(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.summary).toEqual({ feeds: 2, nights: 2, plays: 3 });
    restoreBackup(parsed.backup);
    expect(localStorage.getItem("sleepcast2.state")).toBe(state);
    expect(localStorage.getItem("sleepcast2.blocked")).toBeNull();
    expect(localStorage.getItem("sleepcast2.cleanup")).toBeNull();
    expect(summarizeStored()).toEqual({ feeds: 2, nights: 2, plays: 3 });
  });

  it("refuses files that aren't a usable backup", () => {
    expect(parseBackup("<opml/>").ok).toBe(false);
    expect(parseBackup(JSON.stringify({ app: "other", data: {} })).ok).toBe(false);
    expect(parseBackup(JSON.stringify({ app: "sleepcast", version: 2, data: { "sleepcast2.state": state } }))).toMatchObject({ ok: false, error: expect.stringContaining("newer") });
    expect(parseBackup(JSON.stringify({ app: "sleepcast", version: 1, data: { "sleepcast2.state": "{not json" } })).ok).toBe(false);
    expect(parseBackup(JSON.stringify({ app: "sleepcast", version: 1, data: { "sleepcast2.rest": "[]" } })).ok).toBe(false);
  });

  it("ignores keys it doesn't know", () => {
    const parsed = parseBackup(JSON.stringify({ app: "sleepcast", version: 1, data: { "sleepcast2.state": state, "evil.key": "1" } }));
    expect(parsed.ok && Object.keys(parsed.backup.data)).toEqual(["sleepcast2.state"]);
  });

  it("puts the old data back if the browser runs out of room partway", () => {
    localStorage.setItem("sleepcast2.state", state);
    localStorage.setItem("sleepcast2.rest", JSON.stringify([{ startedAt: 1 }]));
    const parsed = parseBackup(JSON.stringify({
      app: "sleepcast", version: 1,
      data: { "sleepcast2.state": JSON.stringify({ feeds: [], settings: {} }), "sleepcast2.rest": "[]" },
    }));
    if (!parsed.ok) throw new Error("expected ok");
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === "sleepcast2.rest" && v === "[]") throw new DOMException("full", "QuotaExceededError");
      real.call(this, k, v);
    });
    expect(() => restoreBackup(parsed.backup)).toThrow();
    spy.mockRestore();
    expect(localStorage.getItem("sleepcast2.state")).toBe(state);
    expect(localStorage.getItem("sleepcast2.rest")).toBe(JSON.stringify([{ startedAt: 1 }]));
  });
});
