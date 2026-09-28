import { describe, expect, test } from "vitest";
import { SkipIntro, tooShortForSkip } from "./skip-intro";

describe("tooShortForSkip", () => {
  test("unknown, long, short, stream", () => {
    expect(tooShortForSkip(300, NaN)).toBeNull();
    expect(tooShortForSkip(300, 0)).toBeNull();
    expect(tooShortForSkip(300, 3600)).toBe(false);
    expect(tooShortForSkip(300, 320)).toBe(true);
    expect(tooShortForSkip(300, 240)).toBe(true);
    expect(tooShortForSkip(300, Infinity)).toBe(false);
  });
});

describe("SkipIntro", () => {
  test("a long episode announces the skip once it is known to stand", () => {
    const s = new SkipIntro(300);
    expect(s.landedNow()).toBe(false); // duration still unknown
    expect(s.decide(NaN, false)).toBe("wait");
    expect(s.decide(3600, false)).toBe("announce");
    expect(s.decide(3600, false)).toBe("none"); // once
  });

  test("announces at once when already decided", () => {
    const s = new SkipIntro(300);
    expect(s.decide(3600, true)).toBe("none");
    expect(s.landedNow()).toBe(true);
  });

  test("a short episode plays whole, pending or landed", () => {
    expect(new SkipIntro(300).decide(320, true)).toBe("play-whole");
    const landed = new SkipIntro(300);
    landed.landedNow();
    expect(landed.decide(320, false)).toBe("play-whole"); // however far it has played since
  });

  test("not after the listener has moved", () => {
    const s = new SkipIntro(300);
    s.seeked(); // before landing: the skip's own seek, not the listener
    s.landedNow();
    s.seeked();
    expect(s.decide(320, false)).toBe("none");
  });

  test("a stream with no length is long: the owed announcement is made", () => {
    const s = new SkipIntro(300);
    s.landedNow();
    expect(s.decide(Infinity, false)).toBe("announce");
  });

  test("no announcement after the listener went back to hear the intro", () => {
    const s = new SkipIntro(300);
    s.landedNow();
    s.seeked();
    expect(s.decide(3600, false)).toBe("none");
  });

  test("one message, fractional minutes kept", () => {
    expect(new SkipIntro(300).message).toBe("skipped the 5 min intro");
    expect(new SkipIntro(30).message).toBe("skipped the 0.5 min intro");
  });

  test("nothing to undo when the seek never happened", () => {
    expect(new SkipIntro(300).decide(240, false)).toBe("none");
  });
});
