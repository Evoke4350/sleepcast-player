import { describe, it, expect } from "vitest";
import {
  scoreFeeds,
  rankedFeeds,
  medianTimeToSleep,
  evidenceFor,
  WEIGHT_FLOOR,
  MIN_NIGHTS,
} from "./sleepscore";
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

  it("never ranks a feed that has only ever failed (Finding 1)", () => {
    // Three nights of nothing but skips clears MIN_NIGHTS on count alone —
    // the gate must also require having led at least once and net positive,
    // or the suggestion card recommends the exact feed the evidence damns.
    const nights = Array.from({ length: 3 }, () =>
      night({ sleptAtMs: null, detector: "none", skipped: ["aaa"] }),
    );
    expect(rankedFeeds(nights)).toEqual([]);
    // The audit panel is ungated by design and must still show it.
    expect(scoreFeeds(nights).map((f) => f.feedId)).toEqual(["aaa"]);
  });

  it("does not rank a feed that led once but was skipped enough to go negative", () => {
    const nights = [
      onset("swm"),
      ...Array.from({ length: 5 }, () => night({ sleptAtMs: null, detector: "none", skipped: ["swm"] })),
    ];
    const [f] = scoreFeeds(nights);
    expect(f.onsetNights).toBe(1);
    expect(f.score).toBeLessThan(0);
    expect(rankedFeeds(nights)).toEqual([]);
  });

  it("still ranks a feed with three onset nights, unchanged by the new gate", () => {
    const nights = Array.from({ length: 3 }, () => onset("swm"));
    expect(rankedFeeds(nights).map((f) => f.feedId)).toEqual(["swm"]);
  });
});

describe("nights the listener said they were awake (Finding 2)", () => {
  it("does not credit an onset on a night self-labelled awake", () => {
    // selfLabel: "awake" means the listener told the app the detector was
    // wrong. stepback.ts already honours this; scoreFeeds must too, or a
    // false-positive onset still earns a feed +2.
    const nights = [night({ onsetFeedId: "swm", onsetEpisodeId: "swm-ep", selfLabel: "awake" })];
    expect(scoreFeeds(nights)).toEqual([]);
  });

  it("still credits sleptThrough and skipped feeds normally on an awake night", () => {
    // The whole night is thrown out, not just the onset credit — every claim
    // it carries (what auto-advanced, what was skipped) rests on the same
    // discredited detector call.
    const nights = [
      night({
        onsetFeedId: "swm",
        onsetEpisodeId: "swm-ep",
        sleptThrough: ["boring"],
        skipped: ["other"],
        selfLabel: "awake",
      }),
    ];
    expect(scoreFeeds(nights)).toEqual([]);
  });

  it("still scores an ordinary night with no selfLabel at all", () => {
    const nights = [onset("swm")];
    expect(scoreFeeds(nights)[0].feedId).toBe("swm");
  });

  it("still scores a night explicitly self-labelled slept", () => {
    const nights = [night({ onsetFeedId: "swm", onsetEpisodeId: "swm-ep", selfLabel: "slept" })];
    expect(scoreFeeds(nights)[0].feedId).toBe("swm");
  });
});

describe("the evidence beside the pick", () => {
  it("takes the median time-to-sleep over nights this feed led", () => {
    const nights = [
      night({ onsetFeedId: "swm", timeToSleepMs: 600_000 }),
      night({ onsetFeedId: "swm", timeToSleepMs: 900_000 }),
      night({ onsetFeedId: "swm", timeToSleepMs: 1_800_000 }),
      night({ onsetFeedId: "boring", timeToSleepMs: 60_000 }),
    ];
    expect(medianTimeToSleep(nights, "swm")).toBe(900_000);
  });

  it("is null when the feed never led a night", () => {
    expect(medianTimeToSleep([onset("boring")], "swm")).toBeNull();
  });

  it("states the count and the median, both of which are checkable", () => {
    const nights = Array.from({ length: 3 }, () =>
      night({ onsetFeedId: "swm", timeToSleepMs: 840_000 }),
    );
    const [f] = rankedFeeds(nights);
    const line = evidenceFor(nights, f);
    expect(line).toMatch(/14 min/);
    expect(line).toMatch(/3/);
  });

  it("says something true when the feed has only ever been skipped", () => {
    // No onset nights means no median. The line must not claim a time.
    const nights = Array.from({ length: 3 }, () =>
      night({ sleptAtMs: null, detector: "none", skipped: ["swm"] }),
    );
    const [f] = scoreFeeds(nights);
    const line = evidenceFor(nights, f);
    expect(line).not.toMatch(/\bmin\b/);
    expect(line).toMatch(/skipped/i);
  });

  it("says something true when the feed only ever slept through, never led or skipped", () => {
    // Reachability check for the "no median, no skips" branch: FeedScore
    // exists for any feed that appeared in a night at all, and sleptThrough
    // credit doesn't touch onset or skip counts. So a feed can have nights
    // > 0 with no median and no skips — this is live data, not dead code —
    // and the line must not fabricate a time or a skip that never happened.
    const nights = Array.from({ length: 3 }, () =>
      night({ onsetFeedId: "other", timeToSleepMs: 500_000, sleptThrough: ["swm"] }),
    );
    const f = scoreFeeds(nights).find((s) => s.feedId === "swm")!;
    expect(f.skipNights).toBe(0);
    expect(medianTimeToSleep(nights, "swm")).toBeNull();
    const line = evidenceFor(nights, f);
    expect(line).not.toMatch(/\bmin\b/);
    expect(line).not.toMatch(/skipped/i);
    expect(line).toMatch(/3/);
  });

  it("counts only nights with a recorded time, not every night the feed led", () => {
    // f.onsetNights counts every night onsetFeedId matched this feed, even
    // one where timeToSleepMs is null (this module doesn't trust its
    // producer — see scoreFeeds' de-dup comments — so that combination isn't
    // ruled out). The median can only be built from nights with a real time,
    // so the "N times" claim must be counted the same way, or it names a
    // night the minutes figure never saw.
    const nights = [
      night({ onsetFeedId: "swm", timeToSleepMs: 600_000 }),
      night({ onsetFeedId: "swm", timeToSleepMs: 1_200_000 }),
      night({ onsetFeedId: "swm", timeToSleepMs: null }),
    ];
    const [f] = scoreFeeds(nights);
    expect(f.onsetNights).toBe(3);
    const line = evidenceFor(nights, f);
    expect(line).toMatch(/15 min/);
    expect(line).toMatch(/2 times/);
    expect(line).not.toMatch(/3 times/);
  });

  it("still leads with the median when the feed has also been skipped", () => {
    // The median clause still comes first and is still true on its own —
    // a feed that led three nights genuinely does have that lead time.
    // What changed (Finding 1) is that the median no longer gets to be the
    // *whole* sentence: see the next test for why.
    const nights = [
      ...Array.from({ length: 3 }, () => night({ onsetFeedId: "swm", timeToSleepMs: 600_000 })),
      night({ sleptAtMs: null, detector: "none", skipped: ["swm"] }),
    ];
    const f = scoreFeeds(nights).find((s) => s.feedId === "swm")!;
    expect(f.skipNights).toBe(1);
    const line = evidenceFor(nights, f);
    expect(line).toMatch(/^Gone in 10 min the last 3 times it led\./);
  });

  it("also states the skip count when a median coexists with skips", () => {
    // Previously the median won unconditionally and skips were never
    // mentioned once a feed had led at least one night. A feed that led 3
    // times with a clean 10-minute median but was skipped on 5 of its 8
    // nights rendered as flawless — every word true, and the one fact that
    // would change a reader's mind left out. This is the reviewer's exact
    // scenario.
    const nights = [
      ...Array.from({ length: 3 }, () => night({ onsetFeedId: "swm", timeToSleepMs: 600_000 })),
      ...Array.from({ length: 5 }, () => night({ sleptAtMs: null, detector: "none", skipped: ["swm"] })),
    ];
    const f = scoreFeeds(nights).find((s) => s.feedId === "swm")!;
    expect(f.nights).toBe(8);
    expect(f.skipNights).toBe(5);
    const line = evidenceFor(nights, f);
    expect(line).toBe("Gone in 10 min the last 3 times it led. Skipped on 5 of 8 nights.");
  });

  it("does not mention skipping when a median exists and there isn't any", () => {
    // A sentence that always carried "skipped on 0 of N nights" would be
    // harder to read than one that only shows up when it has something to
    // say — the zero case stays silent on purpose.
    const nights = Array.from({ length: 3 }, () =>
      night({ onsetFeedId: "swm", timeToSleepMs: 840_000 }),
    );
    const [f] = rankedFeeds(nights);
    expect(f.skipNights).toBe(0);
    const line = evidenceFor(nights, f);
    expect(line).not.toMatch(/skip/i);
  });

  it("says 'night', not 'nights', when the feed has only played once", () => {
    const nights = [night({ onsetFeedId: "other", timeToSleepMs: 500_000, sleptThrough: ["swm"] })];
    const f = scoreFeeds(nights).find((s) => s.feedId === "swm")!;
    expect(f.nights).toBe(1);
    const line = evidenceFor(nights, f);
    expect(line).toBe("It's played on 1 night.");
  });

  it("says 'night', not 'nights', in the skip-only branch with one night", () => {
    const nights = [night({ sleptAtMs: null, detector: "none", skipped: ["swm"] })];
    const f = scoreFeeds(nights).find((s) => s.feedId === "swm")!;
    expect(f.nights).toBe(1);
    expect(f.skipNights).toBe(1);
    const line = evidenceFor(nights, f);
    expect(line).toBe("You've skipped it on 1 of 1 night.");
  });

  it("renders a sub-minute median as 'under a minute', not '0 min'", () => {
    const nights = [night({ onsetFeedId: "swm", timeToSleepMs: 29_000 })];
    const f = scoreFeeds(nights).find((s) => s.feedId === "swm")!;
    const line = evidenceFor(nights, f);
    expect(line).toBe("Gone in under a minute the last 1 time it led.");
  });

  it("reads onsetAfterMs for the median, not timeToSleepMs", () => {
    // timeToSleepMs is the night-level figure (from night start); onsetAfterMs
    // is how long the feed itself had been playing. Set them apart so a
    // regression that reads the wrong field is caught rather than coincidentally
    // passing.
    const nights = [night({ onsetFeedId: "swm", timeToSleepMs: 900_000, onsetAfterMs: 120_000 })];
    expect(medianTimeToSleep(nights, "swm")).toBe(120_000);
  });

  it("excludes a night with onsetFeedId but no onsetAfterMs from the median, rather than falling back", () => {
    // A wrong number is worse than a smaller sample — this combination
    // shouldn't occur once shipped (session.ts sets both together), but the
    // median must not trust that and fall back to timeToSleepMs anyway.
    const nights = [
      night({ onsetFeedId: "swm", timeToSleepMs: 600_000, onsetAfterMs: 60_000 }),
      night({ onsetFeedId: "swm", timeToSleepMs: 900_000 }), // no onsetAfterMs
    ];
    expect(medianTimeToSleep(nights, "swm")).toBe(60_000);
  });

  it("keeps evidenceFor's 'N times it led' in step with the median's sample, not onsetNights", () => {
    // 3 nights carry onsetFeedId, but only 2 carry onsetAfterMs. The sentence
    // must say "2 times" — the count the median was actually built from — not
    // 3, or it would name a night the minutes figure never saw.
    const nights = [
      night({ onsetFeedId: "swm", timeToSleepMs: 600_000, onsetAfterMs: 100_000 }),
      night({ onsetFeedId: "swm", timeToSleepMs: 700_000, onsetAfterMs: 140_000 }),
      night({ onsetFeedId: "swm", timeToSleepMs: 800_000 }), // no onsetAfterMs
    ];
    const [f] = scoreFeeds(nights);
    expect(f.onsetNights).toBe(3);
    const line = evidenceFor(nights, f);
    expect(line).toMatch(/2 times/);
    expect(line).not.toMatch(/3 times/);
  });
});
