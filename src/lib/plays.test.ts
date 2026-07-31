import { describe, expect, it } from "vitest";
import {
  recordHeard,
  migrateLegacyHistory,
  pickNextEpisode,
  playsSince,
  playAtMoment,
  HEARD_SEC,
  type Play,
} from "./plays";

const play = (id: string, startedAt: number, over: Partial<Play> = {}): Play => ({
  id,
  title: `title ${id}`,
  feedId: "swm",
  startedAt,
  heardSec: 600,
  ...over,
});

const ep = (id: string) => ({ id, title: `title ${id}` });

describe("HEARD_SEC", () => {
  it("is two minutes — long enough that a skipped intro doesn't burn an episode", () => {
    expect(HEARD_SEC).toBe(120);
  });
});

describe("recordHeard", () => {
  it("appends a play that hasn't been recorded before", () => {
    const out = recordHeard([], play("a", 1000), 10);
    expect(out.map((p) => p.id)).toEqual(["a"]);
  });

  it("replaces an earlier play of the same episode rather than duplicating it", () => {
    const out = recordHeard([play("a", 1000), play("b", 2000)], play("a", 3000), 10);
    expect(out.map((p) => p.id)).toEqual(["b", "a"]);
    expect(out.find((p) => p.id === "a")!.startedAt).toBe(3000);
  });

  it("drops the oldest entries once the cap is reached", () => {
    const start = [play("a", 1), play("b", 2), play("c", 3)];
    const out = recordHeard(start, play("d", 4), 3);
    expect(out.map((p) => p.id)).toEqual(["b", "c", "d"]);
  });

  it("does not mutate the array it was given", () => {
    const start = [play("a", 1)];
    recordHeard(start, play("b", 2), 10);
    expect(start.map((p) => p.id)).toEqual(["a"]);
  });
});

describe("migrateLegacyHistory", () => {
  it("turns bare ids into plays that sort oldest, so they recycle first", () => {
    const out = migrateLegacyHistory(["x", "y"]);
    expect(out).toEqual([
      { id: "x", title: "", feedId: "", startedAt: 0, heardSec: 0 },
      { id: "y", title: "", feedId: "", startedAt: 0, heardSec: 0 },
    ]);
  });

  it("handles an empty legacy history", () => {
    expect(migrateLegacyHistory([])).toEqual([]);
  });
});

describe("pickNextEpisode", () => {
  const always0 = () => 0;

  it("returns null when there are no episodes", () => {
    expect(pickNextEpisode([], [], always0)).toBeNull();
  });

  it("only returns unheard episodes while plenty remain unheard", () => {
    const eps = ["a", "b", "c", "d", "e"].map(ep);
    const plays = [play("a", 1)];
    // 4 of 5 unheard — comfortably above the floor, so "a" must never come back
    for (let i = 0; i < 20; i++) {
      const got = pickNextEpisode(eps, plays, () => i / 20);
      expect(got!.id).not.toBe("a");
    }
  });

  it("recycles the OLDEST-heard episode when everything has been heard", () => {
    // The old behaviour fell back to the whole pool at random, so the episode
    // heard ten minutes ago was as likely as the one heard a year ago.
    const eps = ["a", "b", "c"].map(ep);
    const plays = [play("c", 300), play("a", 100), play("b", 200)];
    expect(pickNextEpisode(eps, plays, always0)!.id).toBe("a");
  });

  it("tops up with oldest-heard episodes when unheard drops below the floor", () => {
    // 10 episodes, 9 heard -> 1 unheard is below the 20% floor, so the single
    // oldest-heard is allowed back to bring the candidate count to 2.
    const eps = Array.from({ length: 10 }, (_, i) => ep(`e${i}`));
    const plays = eps.slice(0, 9).map((e, i) => play(e.id, 100 + i));
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(pickNextEpisode(eps, plays, () => i / 40)!.id);
    expect(seen).toContain("e9"); // the unheard one
    expect(seen).toContain("e0"); // the oldest-heard, recycled
    expect(seen).not.toContain("e8"); // the most recently heard stays out
  });

  it("returns the only episode there is, even once it has been heard", () => {
    const eps = [ep("a")];
    expect(pickNextEpisode(eps, [play("a", 1)], always0)!.id).toBe("a");
  });

  it("ignores plays for episodes that are not in the pool", () => {
    const eps = [ep("a")];
    expect(pickNextEpisode(eps, [play("zzz", 1)], always0)!.id).toBe("a");
  });

  it("is deterministic for a given random value", () => {
    const eps = ["a", "b", "c", "d", "e"].map(ep);
    const a = pickNextEpisode(eps, [], () => 0.5);
    const b = pickNextEpisode(eps, [], () => 0.5);
    expect(a!.id).toBe(b!.id);
  });
});

describe("playsSince", () => {
  it("returns plays at or after the cutoff, oldest first", () => {
    const plays = [play("a", 100), play("b", 200), play("c", 300)];
    expect(playsSince(plays, 200).map((p) => p.id)).toEqual(["b", "c"]);
  });

  it("returns nothing when the cutoff is in the future", () => {
    expect(playsSince([play("a", 100)], 999)).toEqual([]);
  });
});

describe("playAtMoment", () => {
  it("finds the play that was running at a given instant", () => {
    const plays = [play("a", 100), play("b", 200), play("c", 300)];
    expect(playAtMoment(plays, 250)!.id).toBe("b");
  });

  it("returns the last play when the instant is after all of them", () => {
    const plays = [play("a", 100), play("b", 200)];
    expect(playAtMoment(plays, 9999)!.id).toBe("b");
  });

  it("returns null when the instant precedes every play", () => {
    expect(playAtMoment([play("a", 100)], 50)).toBeNull();
  });

  it("returns null for an empty ledger", () => {
    expect(playAtMoment([], 100)).toBeNull();
  });
});
