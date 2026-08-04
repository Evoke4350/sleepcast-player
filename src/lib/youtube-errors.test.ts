import { describe, expect, test } from "vitest";
import { classifyYouTubeError } from "./youtube-errors";

describe("videos that will never play, however many times we ask", () => {
  test("embedding disabled by the uploader", () => {
    // 101 and 150 are the same condition reported two ways. Common enough on
    // exactly the long ambient uploads this feature targets that treating it
    // as retryable would mean a night that stalls instead of moving on.
    for (const code of [101, 150]) {
      expect(classifyYouTubeError(code)).toEqual({
        action: "skip",
        permanent: true,
        reason: "the uploader does not allow this video to be played outside YouTube",
      });
    }
  });

  test("removed, private, or never existed", () => {
    expect(classifyYouTubeError(100)).toEqual({
      action: "skip",
      permanent: true,
      reason: "the video is private or has been removed",
    });
  });

  test("a video id YouTube will not even parse", () => {
    expect(classifyYouTubeError(2)).toEqual({
      action: "skip",
      permanent: true,
      reason: "the video id is not one YouTube recognises",
    });
  });
});

describe("failures worth one more try", () => {
  test("the HTML5 player falling over", () => {
    // 5 is the player itself erroring, not a verdict on the video. A night
    // should not lose an episode to one bad frame.
    expect(classifyYouTubeError(5)).toEqual({
      action: "retry",
      permanent: false,
      reason: "the YouTube player failed to start",
    });
  });
});

describe("codes we have never seen", () => {
  test("are skipped rather than retried forever", () => {
    // Retrying an unknown failure risks a loop that never advances and never
    // ends — the app sits in silence while the timer runs down, which is the
    // worst outcome available here. Moving on is recoverable; stalling is not.
    const verdict = classifyYouTubeError(999);
    expect(verdict.action).toBe("skip");
    expect(verdict.permanent).toBe(false);
  });

  test("but are not remembered as permanently dead", () => {
    // Skipped for tonight, eligible again tomorrow: we do not actually know
    // the video is broken, only that it did not start this time.
    expect(classifyYouTubeError(999).permanent).toBe(false);
  });

  test("carry the code, so a report can say what happened", () => {
    expect(classifyYouTubeError(999).reason).toContain("999");
  });
});
