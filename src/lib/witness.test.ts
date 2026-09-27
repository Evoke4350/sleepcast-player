import { describe, expect, test } from "vitest";
import { isPlaybackStep, PlaybackWitness } from "./witness";

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
