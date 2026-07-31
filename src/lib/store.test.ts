import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  BUILTIN_FEEDS,
  loadState,
  saveState,
  addCustomFeed,
  removeCustomFeed,
  getPlays,
  recordHeardPlay,
  loadPositions,
  rememberPosition,
  forgetPosition,
  loadBlocked,
  blockEpisode,
  isBlocked,
  cacheFeedXml,
  getCachedFeedXml,
  loadTimerMinutes,
  saveTimerMinutes,
} from "./store";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// BUILTIN_FEEDS shape
// ---------------------------------------------------------------------------
describe("BUILTIN_FEEDS", () => {
  it("contains exactly 5 entries with expected ids", () => {
    const ids = BUILTIN_FEEDS.map((f) => f.id);
    expect(ids).toContain("swm");
    expect(ids).toContain("nmh");
    expect(ids).toContain("getsleepy");
    expect(ids).toContain("boringbooks");
    expect(ids).toContain("sleepwhispers");
    expect(ids).toContain("sendmetosleep");
    expect(BUILTIN_FEEDS.length).toBe(6);
  });

  it("has builtin:true on all entries", () => {
    for (const f of BUILTIN_FEEDS) {
      expect(f.builtin).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// loadState — default shape
// ---------------------------------------------------------------------------
describe("loadState defaults", () => {
  it("returns timerMinutes:45 (the 'a while' feel default)", () => {
    expect(loadState().settings.timerMinutes).toBe(45);
  });

  it("has all 6 builtin feeds", () => {
    const state = loadState();
    expect(state.feeds.length).toBe(6);
  });

  it("SWM is enabled by default, others are not", () => {
    const state = loadState();
    const swm = state.feeds.find((f) => f.id === "swm")!;
    expect(swm.enabled).toBe(true);
    for (const f of state.feeds.filter((x) => x.id !== "swm")) {
      expect(f.enabled).toBe(false);
    }
  });

  it("all feeds start with skipIntroMin:0", () => {
    for (const f of loadState().feeds) {
      expect(f.skipIntroMin).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// saveState / loadState round-trip
// ---------------------------------------------------------------------------
describe("saveState / loadState round-trip", () => {
  it("persists settings changes", () => {
    const s = loadState();
    s.settings.timerMinutes = 30;
    saveState(s);
    expect(loadState().settings.timerMinutes).toBe(30);
  });

  it("persists feed enabled toggles", () => {
    const s = loadState();
    const nmh = s.feeds.find((f) => f.id === "nmh")!;
    nmh.enabled = true;
    saveState(s);
    const loaded = loadState();
    expect(loaded.feeds.find((f) => f.id === "nmh")!.enabled).toBe(true);
  });

  it("preserves custom feeds across save/load", () => {
    let s = loadState();
    s = addCustomFeed(s, "https://example.com/feed.rss", "My Custom Show");
    saveState(s);
    const loaded = loadState();
    const custom = loaded.feeds.find((f) => !f.builtin);
    expect(custom).toBeDefined();
    expect(custom!.url).toBe("https://example.com/feed.rss");
    expect(custom!.title).toBe("My Custom Show");
  });

  it("unknown saved feeds (not in current BUILTIN_FEEDS) are kept", () => {
    // Simulate a saved state with an extra feed id not in builtins
    const s = loadState();
    const extra = {
      id: "old-builtin",
      url: "https://old.example.com/rss",
      title: "Old Feed",
      builtin: false,
      enabled: true,
      skipIntroMin: 0,
    };
    s.feeds.push(extra);
    saveState(s);
    const loaded = loadState();
    expect(loaded.feeds.some((f) => f.id === "old-builtin")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addCustomFeed
// ---------------------------------------------------------------------------
describe("addCustomFeed", () => {
  it("adds a new feed with builtin:false", () => {
    const s = loadState();
    const s2 = addCustomFeed(s, "https://example.com/rss");
    const custom = s2.feeds.find((f) => !f.builtin);
    expect(custom).toBeDefined();
    expect(custom!.builtin).toBe(false);
    expect(custom!.url).toBe("https://example.com/rss");
  });

  it("uses provided title when given", () => {
    const s = loadState();
    const s2 = addCustomFeed(s, "https://example.com/rss", "My Podcast");
    const custom = s2.feeds.find((f) => f.url === "https://example.com/rss")!;
    expect(custom.title).toBe("My Podcast");
  });

  it("falls back to url as title when no title given", () => {
    const s = loadState();
    const s2 = addCustomFeed(s, "https://example.com/rss");
    const custom = s2.feeds.find((f) => f.url === "https://example.com/rss")!;
    expect(custom.title).toBe("https://example.com/rss");
  });

  it("rejects http:// URL", () => {
    const s = loadState();
    expect(() => addCustomFeed(s, "http://example.com/rss")).toThrow();
  });

  it("rejects garbage string", () => {
    const s = loadState();
    expect(() => addCustomFeed(s, "not-a-url")).toThrow();
  });

  it("rejects empty string", () => {
    const s = loadState();
    expect(() => addCustomFeed(s, "")).toThrow();
  });

  it("dedupes by URL (same URL added twice only appears once)", () => {
    let s = loadState();
    s = addCustomFeed(s, "https://example.com/rss");
    s = addCustomFeed(s, "https://example.com/rss");
    const matches = s.feeds.filter((f) => f.url === "https://example.com/rss");
    expect(matches.length).toBe(1);
  });

  it("returns a new state object (pure function)", () => {
    const s = loadState();
    const s2 = addCustomFeed(s, "https://example.com/rss");
    expect(s2).not.toBe(s);
  });

  it("does not mutate original state", () => {
    const s = loadState();
    const originalFeedCount = s.feeds.length;
    addCustomFeed(s, "https://example.com/rss");
    expect(s.feeds.length).toBe(originalFeedCount);
  });
});

// ---------------------------------------------------------------------------
// removeCustomFeed
// ---------------------------------------------------------------------------
describe("removeCustomFeed", () => {
  it("removes a custom feed by id", () => {
    let s = loadState();
    s = addCustomFeed(s, "https://example.com/rss", "Custom");
    const custom = s.feeds.find((f) => !f.builtin)!;
    const s2 = removeCustomFeed(s, custom.id);
    expect(s2.feeds.find((f) => f.id === custom.id)).toBeUndefined();
  });

  it("no-op when trying to remove a builtin feed", () => {
    const s = loadState();
    const s2 = removeCustomFeed(s, "swm");
    expect(s2.feeds.find((f) => f.id === "swm")).toBeDefined();
    expect(s2.feeds.length).toBe(s.feeds.length);
  });

  it("returns a new state object (pure function)", () => {
    let s = loadState();
    s = addCustomFeed(s, "https://example.com/rss");
    const custom = s.feeds.find((f) => !f.builtin)!;
    const s2 = removeCustomFeed(s, custom.id);
    expect(s2).not.toBe(s);
  });
});

// ---------------------------------------------------------------------------
// recordPlay / getHistory
// ---------------------------------------------------------------------------
describe("getPlays migration + recordHeardPlay", () => {
  it("returns an empty ledger on a fresh install", () => {
    expect(getPlays()).toEqual([]);
  });

  it("migrates a legacy 25-id history once, then drops the old key", () => {
    localStorage.setItem("sleepcast2.history", JSON.stringify(["a", "b"]));
    const migrated = getPlays();
    expect(migrated.map((p) => p.id)).toEqual(["a", "b"]);
    // startedAt 0 so legacy entries recycle first — we don't know when they ran
    expect(migrated.every((p) => p.startedAt === 0)).toBe(true);
    expect(localStorage.getItem("sleepcast2.history")).toBeNull();
    expect(localStorage.getItem("sleepcast2.plays")).not.toBeNull();
  });

  it("does not re-migrate once a ledger exists", () => {
    recordHeardPlay({ id: "x", title: "X", feedId: "f", startedAt: 5, heardSec: 300 });
    localStorage.setItem("sleepcast2.history", JSON.stringify(["legacy"]));
    expect(getPlays().map((p) => p.id)).toEqual(["x"]);
  });

  it("persists a heard play with its title and duration", () => {
    recordHeardPlay({ id: "e1", title: "a bakery", feedId: "dream", startedAt: 111, heardSec: 420 });
    const [p] = getPlays();
    expect(p).toEqual({ id: "e1", title: "a bakery", feedId: "dream", startedAt: 111, heardSec: 420 });
  });

  it("replaces rather than duplicates when the same episode is heard again", () => {
    recordHeardPlay({ id: "e1", title: "t", feedId: "f", startedAt: 1, heardSec: 130 });
    recordHeardPlay({ id: "e1", title: "t", feedId: "f", startedAt: 1, heardSec: 900 });
    const plays = getPlays();
    expect(plays).toHaveLength(1);
    expect(plays[0].heardSec).toBe(900);
  });
});


// ---------------------------------------------------------------------------
// loadTimerMinutes / saveTimerMinutes
// ---------------------------------------------------------------------------
describe("loadTimerMinutes / saveTimerMinutes", () => {
  it("round-trips a saved timer value", () => {
    saveTimerMinutes(45);
    expect(loadTimerMinutes()).toBe(45);
  });

  it("returns default 30 when stored value is garbage", () => {
    localStorage.setItem("sleepcast2.timer", "not-a-number");
    expect(loadTimerMinutes()).toBe(30);
  });

  it("clamps out-of-range saves to [5, 480]", () => {
    saveTimerMinutes(1);
    expect(loadTimerMinutes()).toBe(5);
    saveTimerMinutes(9999);
    expect(loadTimerMinutes()).toBe(480);
  });
});

// ---------------------------------------------------------------------------
// cacheFeedXml / getCachedFeedXml  — eviction at 5 entries
// ---------------------------------------------------------------------------
describe("cacheFeedXml / getCachedFeedXml", () => {
  it("returns null for an uncached feed", () => {
    expect(getCachedFeedXml("unknown")).toBeNull();
  });

  it("stores and retrieves xml", () => {
    cacheFeedXml("swm", "<rss>hello</rss>");
    expect(getCachedFeedXml("swm")).toBe("<rss>hello</rss>");
  });

  it("evicts oldest entry when 6th entry is added", () => {
    // Use increasing timestamps so eviction order is deterministic
    let tick = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => tick++);

    cacheFeedXml("feed1", "<rss>1</rss>"); // tick 1000 (oldest)
    cacheFeedXml("feed2", "<rss>2</rss>"); // tick 1001
    cacheFeedXml("feed3", "<rss>3</rss>"); // tick 1002
    cacheFeedXml("feed4", "<rss>4</rss>"); // tick 1003
    cacheFeedXml("feed5", "<rss>5</rss>"); // tick 1004
    // 5 entries — nothing evicted yet
    expect(getCachedFeedXml("feed1")).toBe("<rss>1</rss>");

    cacheFeedXml("feed6", "<rss>6</rss>"); // tick 1005 — triggers eviction

    // feed1 (oldest) should be gone
    expect(getCachedFeedXml("feed1")).toBeNull();
    // feed2–feed6 should all be present
    expect(getCachedFeedXml("feed2")).toBe("<rss>2</rss>");
    expect(getCachedFeedXml("feed3")).toBe("<rss>3</rss>");
    expect(getCachedFeedXml("feed4")).toBe("<rss>4</rss>");
    expect(getCachedFeedXml("feed5")).toBe("<rss>5</rss>");
    expect(getCachedFeedXml("feed6")).toBe("<rss>6</rss>");
  });

  it("evicts oldest entries and retries when localStorage quota is hit", () => {
    let tick = 3000;
    vi.spyOn(Date, "now").mockImplementation(() => tick++);

    cacheFeedXml("feed1", "<rss>old1</rss>");
    cacheFeedXml("feed2", "<rss>old2</rss>");

    // Simulate a full localStorage: the first two writes throw, then space
    // (freed by evictions) lets the third succeed.
    const realSetItem = Storage.prototype.setItem;
    let failures = 2;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage, k: string, v: string
    ) {
      if (failures > 0) {
        failures--;
        throw new DOMException("quota", "QuotaExceededError");
      }
      realSetItem.call(this, k, v);
    });

    expect(() => cacheFeedXml("feed3", "<rss>new</rss>")).not.toThrow();
    expect(getCachedFeedXml("feed3")).toBe("<rss>new</rss>");
    // Both older entries were sacrificed to make room
    expect(getCachedFeedXml("feed1")).toBeNull();
    expect(getCachedFeedXml("feed2")).toBeNull();
  });

  it("gives up quietly when quota is hit and nothing is evictable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => cacheFeedXml("feed1", "<rss>big</rss>")).not.toThrow();
    expect(getCachedFeedXml("feed1")).toBeNull();
  });

  it("overwriting an existing cache entry does not grow count beyond 5", () => {
    let tick = 2000;
    vi.spyOn(Date, "now").mockImplementation(() => tick++);

    for (let i = 1; i <= 5; i++) cacheFeedXml(`feed${i}`, `<rss>${i}</rss>`);
    // Overwrite feed1 — still only 5 unique entries
    cacheFeedXml("feed1", "<rss>updated</rss>");
    // Should not evict anything since count is still 5
    expect(getCachedFeedXml("feed1")).toBe("<rss>updated</rss>");
    for (let i = 2; i <= 5; i++) {
      expect(getCachedFeedXml(`feed${i}`)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Per-episode resume positions
// ---------------------------------------------------------------------------

describe("positions", () => {
  it("starts empty", () => {
    expect(loadPositions()).toEqual({});
  });

  it("remembers a position worth resuming", () => {
    rememberPosition("e1", 900, 5400);
    expect(loadPositions()["e1"]).toBe(900);
  });

  it("declines to remember the first minute", () => {
    rememberPosition("e1", 20, 5400);
    expect(loadPositions()["e1"]).toBeUndefined();
  });

  it("declines to remember a position in the outro", () => {
    rememberPosition("e1", 5390, 5400);
    expect(loadPositions()["e1"]).toBeUndefined();
  });

  it("forgets a position once the episode has been finished", () => {
    rememberPosition("e1", 900, 5400);
    forgetPosition("e1");
    expect(loadPositions()["e1"]).toBeUndefined();
  });

  it("survives corrupt json rather than throwing into the night", () => {
    localStorage.setItem("sleepcast2.positions", "{not json");
    expect(loadPositions()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Blocked episodes
// ---------------------------------------------------------------------------

describe("blocked episodes", () => {
  it("starts with nothing blocked", () => {
    expect(loadBlocked()).toEqual([]);
    expect(isBlocked("anything")).toBe(false);
  });

  it("blocks an episode and reports it as blocked", () => {
    blockEpisode("bad-one");
    expect(loadBlocked()).toContain("bad-one");
    expect(isBlocked("bad-one")).toBe(true);
  });

  it("does not record the same episode twice", () => {
    blockEpisode("bad-one");
    blockEpisode("bad-one");
    expect(loadBlocked().filter((x) => x === "bad-one")).toHaveLength(1);
  });

  it("survives corrupt json", () => {
    localStorage.setItem("sleepcast2.blocked", "[[[");
    expect(loadBlocked()).toEqual([]);
  });
});

describe("quarter-hour rule opt-in", () => {
  it("is off on a fresh install", () => {
    expect(loadState().settings.quarterHourRule).toBe(false);
  });

  it("is off for an existing listener whose saved settings predate it", () => {
    // The upgrade must never switch on a rule that can end a night early.
    localStorage.setItem(
      "sleepcast2.state",
      JSON.stringify({ feeds: [], settings: { timerMinutes: 45 } }),
    );
    expect(loadState().settings.quarterHourRule).toBe(false);
  });

  it("is off for any non-true value, not merely falsy ones", () => {
    for (const v of ["true", 1, {}, [], "yes"]) {
      localStorage.setItem(
        "sleepcast2.state",
        JSON.stringify({ feeds: [], settings: { timerMinutes: 45, quarterHourRule: v } }),
      );
      expect(loadState().settings.quarterHourRule).toBe(false);
    }
  });

  it("survives a save/load round trip once switched on", () => {
    const s = loadState();
    saveState({ ...s, settings: { ...s.settings, quarterHourRule: true } });
    expect(loadState().settings.quarterHourRule).toBe(true);
  });
});
