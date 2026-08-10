import { describe, it, expect } from "vitest";
import { chooseLead, preferVideoLead } from "./mixed-night";
import type { Episode } from "./engine";

const yt = (id: string): Episode => ({
  id, title: id, url: `https://www.youtube.com/watch?v=${id}`,
  feedId: "chan", date: "", youtubeId: id,
});
const pod = (id: string): Episode => ({
  id, title: id, url: `https://x.test/${id}.mp3`, feedId: "swm", date: "",
});
const none = new Set<string>();

describe("what a mixed night opens on", () => {
  it("leads with a YouTube episode", () => {
    // The embed may refuse to autoplay. At bedtime the listener is awake and
    // taps; at 2am the same refusal stalls the night with the timer running.
    // So the expensive first video happens while someone can answer for it.
    const lead = chooseLead([pod("p1"), yt("v1"), pod("p2")], none, [], () => 0);
    expect(lead?.youtubeId).toBe("v1");
  });

  it("never leads with a podcast while any playable video remains", () => {
    for (const r of [0, 0.4, 0.99]) {
      const lead = chooseLead([pod("p1"), pod("p2"), pod("p3"), yt("v1")], none, [], () => r);
      expect(lead?.id).toBe("v1");
    }
  });

  it("falls back to a podcast when every video is dead", () => {
    // Blocked or failed videos still leave a night worth having.
    const dead = new Set(["v1", "v2"]);
    const lead = chooseLead([yt("v1"), yt("v2"), pod("p1")], dead, [], () => 0);
    expect(lead?.id).toBe("p1");
  });

  it("prefers an unheard video, the same as the ordinary shuffle", () => {
    const plays = [{ id: "v1", title: "v1", feedId: "chan", startedAt: 1, heardSec: 999 }];
    const lead = chooseLead([yt("v1"), yt("v2"), pod("p1")], none, plays, () => 0);
    expect(lead?.id).toBe("v2");
  });

  it("returns null when nothing is playable", () => {
    expect(chooseLead([yt("v1"), pod("p1")], new Set(["v1", "p1"]), [], () => 0)).toBeNull();
    expect(chooseLead([], none, [], () => 0)).toBeNull();
  });

  it("handles a pool with no videos at all", () => {
    // chooseLead is only called for mixed lineups, but a pool can lose its
    // last video to blocking between the check and the start.
    expect(chooseLead([pod("p1")], none, [], () => 0)?.id).toBe("p1");
  });
});

describe("a lead somebody else supplied", () => {
  const mixed = [pod("p1"), yt("v1"), yt("v2"), pod("p2")];

  it("keeps a video lead exactly as given", () => {
    // It already buys what the rule is for, and the listener may have picked
    // this one specifically.
    expect(preferVideoLead(yt("v2"), mixed, none, [], () => 0)?.id).toBe("v2");
  });

  it("replaces a podcast lead with a video", () => {
    // The 3am re-anchor picks in array order and knows nothing about kinds, so
    // its lead is a podcast half the time and the waking gesture is wasted.
    const lead = preferVideoLead(pod("p1"), mixed, none, [], () => 0);
    expect(lead?.youtubeId).toBeTruthy();
  });

  it("keeps a podcast lead when every video is dead", () => {
    // A podcast the listener may have chosen beats overriding it with a
    // different podcast they did not.
    const dead = new Set(["v1", "v2"]);
    expect(preferVideoLead(pod("p2"), mixed, dead, [], () => 0)?.id).toBe("p2");
  });

  it("keeps a podcast lead on an all-podcast pool", () => {
    expect(preferVideoLead(pod("p1"), [pod("p1"), pod("p2")], none, [], () => 0)?.id).toBe("p1");
  });

  it("behaves like chooseLead when no lead was supplied", () => {
    for (const empty of [null, undefined]) {
      expect(preferVideoLead(empty, mixed, none, [], () => 0)?.id).toBe(
        chooseLead(mixed, none, [], () => 0)?.id,
      );
    }
    expect(preferVideoLead(null, [], none, [], () => 0)).toBeNull();
    expect(preferVideoLead(undefined, [yt("v1")], new Set(["v1"]), [], () => 0)).toBeNull();
  });
});
