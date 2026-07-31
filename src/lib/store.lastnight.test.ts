import { describe, it, expect, beforeEach } from "vitest";
import { saveLastNight, loadLastNight, clearLastNight, type LastNight } from "./store";
import type { Episode } from "./engine";

function ep(id: string): Episode {
  return { id, title: `t-${id}`, url: `https://x/${id}.mp3`, feedId: "f" } as Episode;
}

const base: LastNight = {
  pool: [ep("a"), ep("b")],
  playedIds: ["a"],
  feedTitles: { f: "Feed" },
  artworkByFeedId: {},
  skipIntroByFeedId: {},
  endedVia: "faded",
  endedAt: 1000,
  wasVaried: true,
};

describe("lastnight persistence", () => {
  beforeEach(() => localStorage.clear());

  it("returns null when nothing saved", () => {
    expect(loadLastNight()).toBeNull();
  });

  it("round-trips a saved night", () => {
    saveLastNight(base);
    const got = loadLastNight();
    expect(got?.endedVia).toBe("faded");
    expect(got?.wasVaried).toBe(true);
    expect(got?.playedIds).toEqual(["a"]);
    expect(got?.pool.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("bounds the stored pool to 80 episodes", () => {
    const big: LastNight = { ...base, pool: Array.from({ length: 200 }, (_, i) => ep(String(i))) };
    saveLastNight(big);
    expect(loadLastNight()!.pool.length).toBe(80);
  });

  it("clears", () => {
    saveLastNight(base);
    clearLastNight();
    expect(loadLastNight()).toBeNull();
  });
});
