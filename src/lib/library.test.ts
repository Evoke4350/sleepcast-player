import { describe, it, expect, beforeEach } from "vitest";
import { lastPlayedByFeed, arrangeShows, jumpBackIn, loadLibraryView, saveLibraryView } from "./library";
import type { Episode } from "./engine";

const feeds = [
  { id: "a", title: "The Sleepy Bookshelf", enabled: true },
  { id: "b", title: "Nothing Much Happens", enabled: false },
  { id: "c", title: "Sleep With Me", enabled: true },
  { id: "d", title: "Boring Books for Bedtime", enabled: true },
];

describe("lastPlayedByFeed", () => {
  it("keeps each show's latest start", () => {
    expect(lastPlayedByFeed([
      { feedId: "a", startedAt: 5 },
      { feedId: "a", startedAt: 9 },
      { feedId: "c", startedAt: 7 },
      { feedId: "a", startedAt: 2 },
    ])).toEqual({ a: 9, c: 7 });
  });
});

describe("arrangeShows", () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  it("sorts by last played, never-played after in their own order", () => {
    expect(ids(arrangeShows(feeds, "all", "recent", { c: 9, b: 3 }))).toEqual(["c", "b", "a", "d"]);
  });
  it("sorts by title, ignoring a leading The", () => {
    expect(ids(arrangeShows(feeds, "all", "az", {}))).toEqual(["d", "b", "c", "a"]);
  });
  it("filters by shuffle", () => {
    expect(ids(arrangeShows(feeds, "on", "recent", {}))).toEqual(["a", "c", "d"]);
    expect(ids(arrangeShows(feeds, "off", "recent", {}))).toEqual(["b"]);
  });
});

describe("jumpBackIn", () => {
  const ep = (id: string): Episode => ({ id, title: id, url: `https://x/${id}.mp3`, feedId: "a", date: "" });
  it("lists episodes you went under in, latest played first, once each", () => {
    const eps = [ep("1"), ep("2"), ep("3"), ep("2")];
    const out = jumpBackIn(eps, { "1": 30, "2": 60 }, [
      { id: "1", startedAt: 5 },
      { id: "2", startedAt: 8 },
      { id: "1", startedAt: 4 },
    ]);
    expect(out.map((e) => e.id)).toEqual(["2", "1"]);
  });
  it("stops at the limit", () => {
    expect(jumpBackIn([ep("1"), ep("2")], { "1": 1, "2": 1 }, [], 1)).toHaveLength(1);
  });
});

describe("library view", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to a list and remembers a grid", () => {
    expect(loadLibraryView()).toBe("list");
    saveLibraryView("grid");
    expect(loadLibraryView()).toBe("grid");
  });
});
