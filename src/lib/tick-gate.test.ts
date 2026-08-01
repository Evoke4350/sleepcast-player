import { describe, expect, test } from "vitest";
import { shouldTick } from "./tick-gate";

const gate = (over: Partial<Parameters<typeof shouldTick>[0]> = {}) => ({
  lastRunAt: 0,
  now: 10_000,
  minIntervalMs: 900,
  sessionActive: true,
  ...over,
});

describe("two sources, one tick", () => {
  test("runs when the gap since the last run has elapsed", () => {
    expect(shouldTick(gate({ lastRunAt: 9_000, now: 10_000 }))).toBe(true);
  });

  test("refuses a second run inside the gap", () => {
    // The interval and timeupdate both fire; only one of them should do work.
    expect(shouldTick(gate({ lastRunAt: 9_800, now: 10_000 }))).toBe(false);
  });

  test("runs exactly at the boundary", () => {
    expect(shouldTick(gate({ lastRunAt: 9_100, now: 10_000 }))).toBe(true);
  });

  test("runs the very first time, when lastRunAt is still the 0 sentinel", () => {
    // `now` is a real epoch timestamp, so the gap against 0 is enormous.
    expect(shouldTick(gate({ lastRunAt: 0, now: 1_760_000_000_000 }))).toBe(true);
  });

  test("does not run when no time has passed at all", () => {
    expect(shouldTick(gate({ lastRunAt: 5_000, now: 5_000 }))).toBe(false);
  });
});

describe("refusing to tick when no timer is live", () => {
  test("never runs once the session is over, however long the gap", () => {
    // The regression this exists for: "timeupdate" keeps firing after the
    // session ends, because the audio element is still attached. An ungated
    // tick then reads a null end time, computes a hugely negative remaining,
    // and ends a session that has already ended.
    expect(shouldTick(gate({ sessionActive: false, lastRunAt: 0, now: 10_000 }))).toBe(false);
  });

  test("an inactive session beats an elapsed interval", () => {
    expect(shouldTick(gate({ sessionActive: false, lastRunAt: 0, now: 1e9 }))).toBe(false);
  });
});
