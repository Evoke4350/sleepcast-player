import { describe, it, expect, beforeEach } from "vitest";
import { hiddenEpisodes, loadHidden, UNKNOWN_TITLE } from "./hidden";
import { blockEpisode, loadBlocked, loadBlockedNames, unblockEpisode } from "./store";
import type { Episode } from "./engine";

const ep = (id: string, feedId = "f1"): Episode => ({ id, title: `Episode ${id}`, url: `https://x/${id}.mp3`, feedId, date: "" });
const shows = { f1: "Sleep With Me", f2: "Nothing Much Happens" };

describe("hidden episodes", () => {
  beforeEach(() => localStorage.clear());

  it("lists newest hidden first; an older block without a name is named from the feed", () => {
    const list = hiddenEpisodes(["a", "b"], {}, [ep("a"), ep("b", "f2")], shows);
    expect(list).toEqual([
      { id: "b", title: "Episode b", show: "Nothing Much Happens" },
      { id: "a", title: "Episode a", show: "Sleep With Me" },
    ]);
  });

  it("falls back to the name written down, then to 'no longer listed'", () => {
    const list = hiddenEpisodes(["gone", "old"], { gone: { title: "The loud one", show: "A show I removed" } }, [], {});
    expect(list).toEqual([
      { id: "old", title: UNKNOWN_TITLE, show: "", unknown: true },
      { id: "gone", title: "The loud one", show: "A show I removed" },
    ]);
  });

  it("the name written down when hiding wins over the feed", () => {
    expect(hiddenEpisodes(["a"], { a: { title: "As hidden", show: "Written" } }, [ep("a")], shows)[0]).toEqual({ id: "a", title: "As hidden", show: "Written" });
  });

  it("blocking with a name keeps it; unblocking drops both", () => {
    blockEpisode("a", { title: "Episode a", show: "Sleep With Me" });
    blockEpisode("b");
    expect(loadBlocked()).toEqual(["a", "b"]);
    expect(loadBlockedNames()).toEqual({ a: { title: "Episode a", show: "Sleep With Me" } });
    expect(loadHidden([], {})).toEqual([
      { id: "b", title: UNKNOWN_TITLE, show: "", unknown: true },
      { id: "a", title: "Episode a", show: "Sleep With Me" },
    ]);
    unblockEpisode("a");
    expect(loadBlocked()).toEqual(["b"]);
    expect(loadBlockedNames()).toEqual({});
    expect(localStorage.getItem("sleepcast2.blocked.names")).toBeNull();
  });

  it("naming an episode already blocked adds the name without a second entry", () => {
    blockEpisode("a");
    blockEpisode("a", { title: "t", show: "s" });
    expect(loadBlocked()).toEqual(["a"]);
    expect(loadBlockedNames().a).toEqual({ title: "t", show: "s" });
  });

  it("names survive corrupt storage", () => {
    localStorage.setItem("sleepcast2.blocked.names", "[[[");
    expect(loadBlockedNames()).toEqual({});
    localStorage.setItem("sleepcast2.blocked.names", "[1]");
    expect(loadBlockedNames()).toEqual({});
  });
});
