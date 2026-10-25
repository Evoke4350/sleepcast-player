import { describe, it, expect } from "vitest";
import { CATALOG, CATALOG_STYLES, isAdded } from "./catalog";
import { BUILTIN_FEEDS, addCustomFeed, type AppState } from "./store";

describe("catalog", () => {
  it("lists each show once, over https, in a style that's shown", () => {
    const urls = CATALOG.map((s) => s.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(new Set(CATALOG.map((s) => s.title)).size).toBe(CATALOG.length);
    const styles = new Set(CATALOG_STYLES.map((s) => s.style));
    for (const s of CATALOG) {
      expect(new URL(s.url).protocol).toBe("https:");
      expect(styles.has(s.style)).toBe(true);
      expect(s.about.length).toBeGreaterThan(0);
    }
  });

  it("doesn't repeat a built-in show", () => {
    const builtin = new Set(BUILTIN_FEEDS.map((f) => f.url));
    expect(CATALOG.filter((s) => builtin.has(s.url))).toEqual([]);
  });

  it("an added show is one of yours, on in the shuffle, and removable", () => {
    const show = CATALOG[0];
    const s: AppState = { feeds: [], settings: {} as AppState["settings"] };
    expect(isAdded(show, s.feeds)).toBe(false);
    const next = addCustomFeed(s, show.url, show.title);
    expect(isAdded(show, next.feeds)).toBe(true);
    expect(next.feeds[0]).toMatchObject({ url: show.url, title: show.title, enabled: true, builtin: false });
    // Adding again changes nothing.
    expect(addCustomFeed(next, show.url, show.title).feeds).toHaveLength(1);
  });
});
