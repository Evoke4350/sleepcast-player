import { describe, it, expect } from "vitest";
import { scoreFeeds, rankedFeeds, WEIGHT_FLOOR, MIN_NIGHTS } from "./sleepscore";
import type { RestNight } from "./types";

const night = (over: Partial<RestNight>): RestNight => ({
  startedAt: 1_000_000,
  timerMinutes: 45,
  endedVia: "faded",
  sleptAtMs: 900_000,
  timeToSleepMs: 900_000,
  interactions: 0,
  detector: "inference",
  ...over,
});

const onset = (feedId: string, startedAt = 1_000_000) =>
  night({ startedAt, onsetFeedId: feedId, onsetEpisodeId: `${feedId}-ep` });

describe("scoring a feed by what it did", () => {
  it("gives the onset feed the most credit", () => {
    const [f] = scoreFeeds([onset("swm")]);
    expect(f.feedId).toBe("swm");
    expect(f.score).toBe(2);
    expect(f.onsetNights).toBe(1);
  });

  it("gives a slept-through feed less than the onset feed", () => {
    const s = scoreFeeds([night({ onsetFeedId: "swm", sleptThrough: ["boring"] })]);
    const by = Object.fromEntries(s.map((f) => [f.feedId, f.score]));
    expect(by.swm).toBe(2);
    expect(by.boring).toBe(1);
  });

  it("penalises a skipped feed", () => {
    const [f] = scoreFeeds([night({ sleptAtMs: null, detector: "none", skipped: ["swm"] })]);
    expect(f.score).toBe(-1);
    expect(f.skipNights).toBe(1);
  });

  it("credits a feed once per night even if an array repeats it", () => {
    // RestNight's type permits duplicates and ledger.ts JSON.parses stored
    // nights with no validation, so this module cannot rely on its producer
    // having de-duplicated. Double credit here would silently inflate a feed
    // above one that genuinely did better.
    const dupes = night({ sleptAtMs: null, detector: "none", skipped: ["swm", "swm", "swm"] });
    const [f] = scoreFeeds([dupes]);
    expect(f.score).toBe(-1);
    expect(f.nights).toBe(1);
    expect(f.skipNights).toBe(1);
  });

  it("stacks onset and slept-through credit for the same feed in one night", () => {
    // A feed can lead the night and still be what's playing when the timer
    // fades — legitimately earning +2 (onset) + 1 (slept through) against a
    // single night. This path existed only in a probe script deleted before
    // commit.
    const stacked = night({ onsetFeedId: "swm", onsetEpisodeId: "swm-ep", sleptThrough: ["swm"] });
    const [f] = scoreFeeds([stacked]);
    expect(f.score).toBe(3);
    expect(f.nights).toBe(1);
    expect(f.onsetNights).toBe(1);
  });

  it("counts nights the feed appeared in, not nights in the ledger", () => {
    // A feed on 2 of 50 nights is judged on those 2.
    const nights = [onset("swm"), onset("swm"), ...Array.from({ length: 48 }, () => onset("boring"))];
    const swm = scoreFeeds(nights).find((f) => f.feedId === "swm")!;
    expect(swm.nights).toBe(2);
  });

  it("never zeroes a feed out, however badly it scored", () => {
    // A feed skipped every night still lands at 1 + WEIGHT_SLOPE * -1 = 0.75,
    // well above zero. The property that matters is the last assertion —
    // WEIGHT_FLOOR exists so a scorer never eliminates its own exploration —
    // not the exact value, which is pinned separately below.
    const bad = Array.from({ length: 9 }, () =>
      night({ sleptAtMs: null, detector: "none", skipped: ["swm"] }),
    );
    const [f] = scoreFeeds(bad);
    expect(f.score).toBe(-9);
    expect(f.weight).toBe(0.75);
    expect(f.weight).toBeGreaterThan(0);
  });

  it("cannot score low enough for the floor to bind", () => {
    // Per night a feed earns at most +3 (led, then auto-advanced) and at worst
    // −1 (skipped once — the arrays are de-duplicated). So weight lives in
    // [0.75, 1.75] and WEIGHT_FLOOR is unreachable insurance, not live logic.
    // If this ever fails, the credit scheme changed and the floor is in play.
    const worst = Array.from({ length: 20 }, () =>
      night({ sleptAtMs: null, detector: "none", skipped: ["swm"] }),
    );
    expect(scoreFeeds(worst)[0].weight).toBeGreaterThan(WEIGHT_FLOOR);
  });

  it("a feed that always works scores above one", () => {
    const [f] = scoreFeeds([onset("swm"), onset("swm"), onset("swm")]);
    expect(f.weight).toBeGreaterThan(1);
  });

  it("ignores nights recorded before any of this existed", () => {
    // 90 stored nights have none of the new fields and must not throw.
    expect(scoreFeeds([night({}), night({})])).toEqual([]);
  });

  it("handles an empty ledger", () => {
    expect(scoreFeeds([])).toEqual([]);
  });
});

describe("ranking, and the confidence gate", () => {
  it("does not rank a feed below the night threshold", () => {
    const thin = Array.from({ length: MIN_NIGHTS - 1 }, () => onset("swm"));
    expect(rankedFeeds(thin)).toEqual([]);
  });

  it("ranks it once the threshold is reached", () => {
    const enough = Array.from({ length: MIN_NIGHTS }, () => onset("swm"));
    expect(rankedFeeds(enough).map((f) => f.feedId)).toEqual(["swm"]);
  });

  it("puts the better feed first", () => {
    const nights = [
      ...Array.from({ length: 3 }, () => onset("boring")),
      ...Array.from({ length: 3 }, () => night({ sleptAtMs: null, detector: "none", skipped: ["swm"] })),
    ];
    expect(rankedFeeds(nights)[0].feedId).toBe("boring");
  });

  it("breaks ties deterministically, so the suggestion does not flicker", () => {
    // Two feeds with identical evidence must not swap places between renders.
    const nights = [
      ...Array.from({ length: 3 }, () => onset("aaa")),
      ...Array.from({ length: 3 }, () => onset("bbb")),
    ];
    const a = rankedFeeds(nights).map((f) => f.feedId);
    const b = rankedFeeds(nights).map((f) => f.feedId);
    expect(a).toEqual(b);
    expect(a).toEqual(["aaa", "bbb"]);
  });
});
