import { describe, expect, test } from "vitest";
import { isPlaybackStep, PlaybackWitness, rearmsWatchdogOnTap, tapPauses } from "./witness";

describe("isPlaybackStep", () => {
  test("a second of playback over a second counts", () => {
    expect(isPlaybackStep(10, 1_000, 11, 2_000, 0)).toBe(true);
  });

  test("throttled ticks a minute apart still count real playback", () => {
    expect(isPlaybackStep(100, 1_000, 160, 61_000, 0)).toBe(true);
  });

  test("a jump faster than the clock is a seek", () => {
    expect(isPlaybackStep(0, 1_000, 120, 2_000, 0)).toBe(false);
  });

  test("the start seek landing from 0 is not playback, even under a throttled cap", () => {
    expect(isPlaybackStep(0, 1_000, 60, 61_000, 60)).toBe(false);
  });

  test("the start seek landing from the previous video's leftover position is not playback", () => {
    expect(isPlaybackStep(250, 1_000, 300, 61_000, 300)).toBe(false);
  });

  test("playing on from the start counts", () => {
    expect(isPlaybackStep(300, 1_000, 301, 2_000, 300)).toBe(true);
  });

  test("a position that doesn't move (a stale reading, a hang) never counts", () => {
    expect(isPlaybackStep(1200, 1_000, 1200, 30_000, 0)).toBe(false);
  });

  test("backwards never counts", () => {
    expect(isPlaybackStep(50, 1_000, 10, 2_000, 0)).toBe(false);
  });

  test("without a real earlier time, nothing counts", () => {
    expect(isPlaybackStep(0, 0, 0.8, 5_000, 0)).toBe(false);
  });
});

describe("PlaybackWitness", () => {
  test("a throttled first look a minute after the load counts", () => {
    const w = new PlaybackWitness();
    w.reset(0, 1_000);
    expect(w.observe(55, 61_000, true)).toBe(true);
  });

  test("the first look right after a load does not count a position far from the start", () => {
    const w = new PlaybackWitness();
    w.reset(0, 1_000);
    expect(w.observe(1200, 2_000, true)).toBe(false);
  });

  test("a paused reading never opens the gate, even if the position moved", () => {
    const w = new PlaybackWitness();
    w.reset(10, 1_000);
    expect(w.observe(11, 2_000, false)).toBe(false);
    expect(w.observe(12, 3_000, true)).toBe(true);
  });

  test("reset closes the gate and re-seeds", () => {
    const w = new PlaybackWitness();
    w.reset(0, 1_000);
    w.observe(1, 2_000, true);
    expect(w.played).toBe(true);
    w.reset(300, 5_000);
    expect(w.played).toBe(false);
    expect(w.startSec).toBe(300);
    expect(w.observe(300, 6_000, true)).toBe(false); // sitting at the start isn't movement
    expect(w.observe(301, 7_000, true)).toBe(true);
  });

  test("markPlayed trusts the player's own event", () => {
    const w = new PlaybackWitness();
    w.reset(0, 1_000);
    w.markPlayed();
    expect(w.played).toBe(true);
  });
});

describe("PlaybackWitness per-episode state", () => {
  test("heard survives a reload of the same episode; played does not", () => {
    const w = new PlaybackWitness();
    w.newEpisode(0, 1_000);
    w.observe(1, 2_000, true);
    expect(w.played).toBe(true);
    w.reset(3_590, 5_000); // a retry near its end
    expect(w.played).toBe(false);
    expect(w.heard).toBe(true);
  });

  test("a new episode clears heard and replayed", () => {
    const w = new PlaybackWitness();
    w.newEpisode(0, 1_000);
    w.markPlayed();
    w.markReplayed();
    w.newEpisode(0, 2_000);
    expect(w.heard).toBe(false);
    expect(w.replayed).toBe(false);
  });

  test("an episode started at a saved position counts as heard", () => {
    const w = new PlaybackWitness();
    w.newEpisode(10_000, 1_000, true);
    expect(w.heard).toBe(true);
    expect(w.played).toBe(false);
  });

  test("replayed survives the replay's reload", () => {
    const w = new PlaybackWitness();
    w.newEpisode(300, 1_000);
    w.markReplayed();
    w.reset(0, 2_000);
    expect(w.replayed).toBe(true);
  });
});

describe("PlaybackWitness.resumeAt", () => {
  test("is the load's start until it plays, then where it got to", () => {
    const w = new PlaybackWitness();
    w.newEpisode(180, 0);
    expect(w.resumeAt(0)).toBe(180);
    expect(w.resumeAt(900)).toBe(180);
    w.markPlayed();
    expect(w.resumeAt(900)).toBe(900);
    expect(w.resumeAt(0)).toBe(180); // a failed element reading 0
  });
});

describe("PlaybackWitness.shownAt", () => {
  test("the load's start until it has played and its start seek is done, then the reading", () => {
    const w = new PlaybackWitness();
    w.newEpisode(1800, 0);
    expect(w.shownAt(0, true)).toBe(1800);
    w.markPlayed();
    expect(w.shownAt(0.9, true)).toBe(1800); // played from 0 while the start seek retries
    expect(w.shownAt(1805, false)).toBe(1805);
    expect(w.shownAt(600, false)).toBe(600); // a listener's seek back before the start
    expect(w.shownSpan(600, false, 3600)).toEqual({ pos: 600, dur: 3600 });
    expect(w.shownSpan(600, false, 0)).toBeNull();
  });
});

describe("tapPauses", () => {
  test("pauses what plays, or stalls once heard; otherwise asks for sound", () => {
    expect(tapPauses("playing", false)).toBe(true);
    expect(tapPauses("buffering", true)).toBe(true);
    expect(tapPauses("buffering", false)).toBe(false);
    expect(tapPauses("paused", true)).toBe(false);
    expect(tapPauses("awaiting-start", false)).toBe(false);
  });
});

describe("rearmsWatchdogOnTap", () => {
  test("only for an unplayed episode that is not already buffering", () => {
    expect(rearmsWatchdogOnTap(false, "paused")).toBe(true);
    expect(rearmsWatchdogOnTap(false, "buffering")).toBe(false);
    expect(rearmsWatchdogOnTap(true, "paused")).toBe(false);
  });
});
