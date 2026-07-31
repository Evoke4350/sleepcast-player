import { describe, expect, it } from "vitest";
import { searchEpisodes } from "./episode-search";

const ep = (title: string, feedId = "swm") => ({
  id: title, title, url: `https://x/${title}`, feedId, date: "",
});

const POOL = [
  ep("Night Train Timetables"),
  ep("The 3:40 Train to Nowhere"),
  ep("Trains, and the People Who Time Them"),
  ep("A Canal Boat Moored for the Night"),
  ep("Sleep With Me #1042: the slow rails"),
  ep("Rain Learning the Roof", "verse"),
  ep("Moss on the North Side", "field"),
];

const titles = (r: { title: string }[]) => r.map((e) => e.title);

describe("finding an episode you half-remember", () => {
  it("matches a single word anywhere in the title", () => {
    const r = titles(searchEpisodes(POOL, "train", 10));
    expect(r).toContain("Night Train Timetables");
    expect(r).toContain("The 3:40 Train to Nowhere");
  });

  it("requires every word, not any of them", () => {
    // "night train" must not drag in every episode with "night" in it.
    const r = titles(searchEpisodes(POOL, "night train", 10));
    expect(r).toEqual(["Night Train Timetables"]);
  });

  it("ignores case", () => {
    expect(titles(searchEpisodes(POOL, "MOSS", 10))).toEqual(["Moss on the North Side"]);
  });

  it("ignores punctuation on both sides", () => {
    // Someone typing at 2am will not reproduce "#1042:" exactly.
    expect(titles(searchEpisodes(POOL, "1042", 10))).toContain("Sleep With Me #1042: the slow rails");
    expect(titles(searchEpisodes(POOL, "trains,", 10)).length).toBeGreaterThan(0);
  });

  it("matches a partial word, since people type prefixes", () => {
    expect(titles(searchEpisodes(POOL, "tim", 10))).toContain("Night Train Timetables");
  });
});

describe("ranking", () => {
  it("puts an exact title first", () => {
    const r = titles(searchEpisodes(POOL, "Moss on the North Side", 10));
    expect(r[0]).toBe("Moss on the North Side");
  });

  it("prefers a title that starts with the query", () => {
    const r = titles(searchEpisodes(POOL, "night", 10));
    expect(r[0]).toBe("Night Train Timetables");
  });

  it("prefers the shorter title when the matches are genuinely equal", () => {
    // Neither of these leads with the query, so no prefix bonus applies and
    // length is the only thing separating them. Shorter is more specific.
    const r = titles(searchEpisodes([
      ep("The Slow Train and the People Who Time Them"),
      ep("The Night Train"),
    ], "train", 10));
    expect(r[0]).toBe("The Night Train");
  });

  it("ranks a title that leads with the query above a shorter one that does not", () => {
    // The case that corrected the test above: a prefix match is a stronger
    // signal than brevity, which is how search is normally expected to behave.
    const r = titles(searchEpisodes([
      ep("The Night Train"),
      ep("Trains, and the People Who Time Them"),
    ], "train", 10));
    expect(r[0]).toBe("Trains, and the People Who Time Them");
  });

  it("is deterministic regardless of pool order", () => {
    const a = titles(searchEpisodes(POOL, "train", 10));
    const b = titles(searchEpisodes([...POOL].reverse(), "train", 10));
    expect(a).toEqual(b);
  });
});

describe("edge cases", () => {
  it("returns nothing for an empty or whitespace query", () => {
    expect(searchEpisodes(POOL, "", 10)).toEqual([]);
    expect(searchEpisodes(POOL, "   ", 10)).toEqual([]);
  });

  it("returns nothing when there is no match rather than guessing", () => {
    expect(searchEpisodes(POOL, "helicopter", 10)).toEqual([]);
  });

  it("respects the limit", () => {
    expect(searchEpisodes(POOL, "the", 2)).toHaveLength(2);
  });

  it("handles an empty pool", () => {
    expect(searchEpisodes([], "train", 10)).toEqual([]);
  });

  it("does not choke on a query of only punctuation", () => {
    expect(searchEpisodes(POOL, "#:!", 10)).toEqual([]);
  });
});
