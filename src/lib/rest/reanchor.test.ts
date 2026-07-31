import { describe, it, expect } from "vitest";
import { shouldReanchor, nextInSpread, REANCHOR_WINDOW_MS } from "./reanchor";
import type { LastNight } from "../store";
import type { Episode } from "../engine";

function ep(id: string): Episode {
  return { id, title: id, url: `https://x/${id}`, feedId: "f" } as Episode;
}
const night = (over: Partial<LastNight> = {}): LastNight => ({
  pool: [ep("a"), ep("b")],
  playedIds: ["a"],
  feedTitles: {},
  artworkByFeedId: {},
  skipIntroByFeedId: {},
  endedVia: "faded",
  endedAt: 1_000_000,
  wasVaried: false,
  ...over,
});
const NOW = 1_000_000 + 60_000; // 1 min after the night ended

describe("nextInSpread", () => {
  it("returns the first unplayed episode in order", () => {
    expect(nextInSpread([ep("a"), ep("b")], ["a"])?.id).toBe("b");
  });
  it("null when all played", () => {
    expect(nextInSpread([ep("a")], ["a"])).toBeNull();
  });
  it("null for an empty pool", () => {
    expect(nextInSpread([], [])).toBeNull();
  });
});

describe("shouldReanchor", () => {
  it("true on the happy path (faded, in window, night hours, next exists)", () => {
    expect(shouldReanchor({ lastNight: night(), now: NOW, localHour: 3 })).toBe(true);
  });
  it("false when there is no last night", () => {
    expect(shouldReanchor({ lastNight: null, now: NOW, localHour: 3 })).toBe(false);
  });
  it("false when the night was ended or abandoned, not faded", () => {
    expect(shouldReanchor({ lastNight: night({ endedVia: "ended" }), now: NOW, localHour: 3 })).toBe(false);
    expect(shouldReanchor({ lastNight: night({ endedVia: "abandoned" }), now: NOW, localHour: 3 })).toBe(false);
  });
  it("false past the 6h window", () => {
    const late = 1_000_000 + REANCHOR_WINDOW_MS + 1;
    expect(shouldReanchor({ lastNight: night(), now: late, localHour: 3 })).toBe(false);
  });
  it("respects night-hour boundaries (>=21 or <6)", () => {
    expect(shouldReanchor({ lastNight: night(), now: NOW, localHour: 20 })).toBe(false);
    expect(shouldReanchor({ lastNight: night(), now: NOW, localHour: 21 })).toBe(true);
    expect(shouldReanchor({ lastNight: night(), now: NOW, localHour: 5 })).toBe(true);
    expect(shouldReanchor({ lastNight: night(), now: NOW, localHour: 6 })).toBe(false);
    expect(shouldReanchor({ lastNight: night(), now: NOW, localHour: 0 })).toBe(true);
  });
  it("false when nothing is left in the spread", () => {
    expect(shouldReanchor({ lastNight: night({ playedIds: ["a", "b"] }), now: NOW, localHour: 3 })).toBe(false);
  });
});
