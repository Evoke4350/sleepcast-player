import { describe, expect, test } from "vitest";
import { decideSkip, skipMessage, stillAtStart } from "./skip-intro";
import { tooShortForStart } from "./episode-end";

describe("tooShortForStart", () => {
  test("unknown, long, short, stream", () => {
    expect(tooShortForStart(300, NaN)).toBeNull();
    expect(tooShortForStart(300, 0)).toBeNull();
    expect(tooShortForStart(300, 3600)).toBe(false);
    expect(tooShortForStart(300, 320)).toBe(true);
    expect(tooShortForStart(300, 240)).toBe(true);
    expect(tooShortForStart(300, Infinity)).toBe(false);
  });
});

describe("decideSkip", () => {
  test("waits for the duration", () => {
    expect(decideSkip(300, NaN, 0)).toBe("wait");
  });

  test("skips a long episode still at its start", () => {
    expect(decideSkip(300, 3600, 0)).toBe("skip");
    expect(decideSkip(300, 3600, 2.5)).toBe("skip"); // a moment of intro while the duration arrived
    expect(decideSkip(300, Infinity, 0)).toBe("skip");
  });

  test("plays a short episode whole", () => {
    expect(decideSkip(300, 320, 0)).toBe("none");
  });

  test("leaves a listener who has moved", () => {
    expect(decideSkip(300, 3600, 1200)).toBe("none");
    expect(decideSkip(300, 3600, 40)).toBe("none");
  });
});

describe("skipMessage", () => {
  test("minutes, fractional minutes, seconds", () => {
    expect(skipMessage(300)).toBe("Skipped the 5 min intro");
    expect(skipMessage(90)).toBe("Skipped the 1.5 min intro");
    expect(skipMessage(15)).toBe("Skipped the 15 s intro");
    expect(skipMessage(61.2)).toBe("Skipped the 1 min intro");
    expect(skipMessage(59.7)).toBe("Skipped the 1 min intro");
    expect(skipMessage(0.3)).toBe("Skipped the 1 s intro");
  });
});

describe("stillAtStart, the one rule", () => {
  test("up to 15 s in, and short of the skip", () => {
    expect(stillAtStart(15, 300)).toBe(true);
    expect(stillAtStart(15.1, 300)).toBe(false);
    expect(stillAtStart(10, 15)).toBe(true);
    expect(stillAtStart(15, 15)).toBe(false);
    expect(stillAtStart(0, 0)).toBe(false); // no skip
  });

  test("decideSkip follows it at the boundary", () => {
    expect(decideSkip(300, 3600, 15)).toBe("skip");
    expect(decideSkip(300, 3600, 15.1)).toBe("none");
    expect(decideSkip(15, 3600, 10)).toBe("skip");
  });
});
