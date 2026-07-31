import { describe, expect, it } from "vitest";
import {
  shouldSuggestGettingUp,
  RULE_AFTER_MS,
  RECENT_MS,
  MIN_INTERACTIONS,
} from "./quarterhour";

const MIN = 60_000;

const input = (over: Partial<Parameters<typeof shouldSuggestGettingUp>[0]> = {}) => ({
  elapsedMs: 30 * MIN,
  interactions: 6,
  msSinceLastInteraction: 1 * MIN,
  ...over,
});

describe("shouldSuggestGettingUp", () => {
  it("fires once a restless stretch passes the threshold", () => {
    expect(shouldSuggestGettingUp(input())).toBe(true);
  });

  it("stays silent before the threshold, however restless", () => {
    expect(
      shouldSuggestGettingUp(input({ elapsedMs: RULE_AFTER_MS - 1, interactions: 20 })),
    ).toBe(false);
  });

  it("never fires on a quiet night", () => {
    // No interaction at all is indistinguishable from sleep — the detector
    // cannot tell lying-still-awake from asleep, so we must not guess.
    expect(
      shouldSuggestGettingUp(input({ interactions: 0, msSinceLastInteraction: null })),
    ).toBe(false);
  });

  it("stays silent once someone has settled, even after a restless start", () => {
    // Ten minutes without a touch means they have very likely gone under.
    expect(
      shouldSuggestGettingUp(input({ msSinceLastInteraction: RECENT_MS + 1 })),
    ).toBe(false);
  });

  it("ignores a single stray tap — reaching for a glass of water is not insomnia", () => {
    expect(
      shouldSuggestGettingUp(input({ interactions: MIN_INTERACTIONS - 1 })),
    ).toBe(false);
  });

  it("fires at exactly the boundaries", () => {
    expect(
      shouldSuggestGettingUp({
        elapsedMs: RULE_AFTER_MS,
        interactions: MIN_INTERACTIONS,
        msSinceLastInteraction: RECENT_MS,
      }),
    ).toBe(true);
  });

  it("uses roughly the quarter-hour rule's timing, not the whole timer", () => {
    // CBT-I's stimulus control says get up after ~20 minutes awake. 25 gives
    // a little grace without letting the bed become a place you lie awake.
    expect(RULE_AFTER_MS).toBe(25 * MIN);
  });
});
