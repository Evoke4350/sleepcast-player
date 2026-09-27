import { describe, expect, test } from "vitest";
import { isPlaybackStep } from "./witness";

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

  test("with no earlier look, a small first step counts", () => {
    expect(isPlaybackStep(0, 0, 0.8, 5_000, 0)).toBe(true);
  });
});
