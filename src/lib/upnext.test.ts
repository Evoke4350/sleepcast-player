import { describe, it, expect, beforeEach } from "vitest";
import { addUpNext, isUpNext, loadUpNext, removeUpNext, takeUpNext, UP_NEXT_CAP } from "./upnext";
import { getPlays, loadPositions, markPlayed, markUnplayed, rememberPosition } from "./store";
import { HEARD_SEC } from "./plays";
import type { Episode } from "./engine";

const ep = (id: string): Episode => ({ id, title: `t-${id}`, url: `https://x/${id}.mp3`, feedId: "f", date: "" });

describe("up next", () => {
  beforeEach(() => localStorage.clear());

  it("is empty, then keeps what was added, in order", () => {
    expect(loadUpNext()).toEqual([]);
    addUpNext(ep("a"));
    addUpNext(ep("b"));
    expect(loadUpNext().map((e) => e.id)).toEqual(["a", "b"]);
    expect(isUpNext("a")).toBe(true);
    expect(isUpNext("z")).toBe(false);
  });

  it("adding again moves it to the end", () => {
    addUpNext(ep("a")); addUpNext(ep("b")); addUpNext(ep("a"));
    expect(loadUpNext().map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("take hands out the first, skipping and dropping blocked ones", () => {
    addUpNext(ep("a")); addUpNext(ep("b")); addUpNext(ep("c"));
    expect(takeUpNext(new Set(["a"]))?.id).toBe("b");
    expect(loadUpNext().map((e) => e.id)).toEqual(["c"]);
    expect(takeUpNext()?.id).toBe("c");
    expect(takeUpNext()).toBeNull();
    expect(localStorage.getItem("sleepcast2.upnext")).toBeNull();
  });

  it("take with everything skipped empties the list", () => {
    addUpNext(ep("a"));
    expect(takeUpNext(new Set(["a"]))).toBeNull();
    expect(loadUpNext()).toEqual([]);
  });

  it("remove, and the cap", () => {
    for (let i = 0; i < UP_NEXT_CAP + 3; i++) addUpNext(ep(`e${i}`));
    expect(loadUpNext()).toHaveLength(UP_NEXT_CAP);
    expect(loadUpNext()[0].id).toBe("e3");
    removeUpNext("e3");
    expect(loadUpNext()[0].id).toBe("e4");
  });
});

describe("mark played / unplayed", () => {
  beforeEach(() => localStorage.clear());

  it("played by hand counts as heard, dated 0", () => {
    markPlayed(ep("a"));
    const p = getPlays().find((x) => x.id === "a")!;
    expect(p.heardSec).toBe(HEARD_SEC);
    expect(p.startedAt).toBe(0);
  });

  it("unplayed drops the play and the saved position", () => {
    markPlayed(ep("a"));
    rememberPosition("a", 600, 3600);
    expect(loadPositions().a).toBe(600);
    markUnplayed("a");
    expect(getPlays().some((x) => x.id === "a")).toBe(false);
    expect(loadPositions().a).toBeUndefined();
  });
});
