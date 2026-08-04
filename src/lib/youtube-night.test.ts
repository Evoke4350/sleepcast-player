import { describe, expect, test } from "vitest";
import { nextPlayable, decideAfterError, MAX_RETRIES } from "./youtube-night";
import type { Episode } from "./engine";

const ep = (id: string): Episode => ({
  id,
  title: id,
  url: `https://www.youtube.com/watch?v=${id}`,
  feedId: "yt",
  date: "",
  youtubeId: id,
});

const POOL = [ep("a"), ep("b"), ep("c")];
const none = new Set<string>();

describe("choosing what plays next", () => {
  test("picks something from the pool", () => {
    const chosen = nextPlayable(POOL, none, null, [], () => 0);
    expect(POOL).toContain(chosen);
  });

  test("never picks a video already known not to play", () => {
    // Both kinds of dead land in the same set: blocked across nights (the
    // uploader disabled embedding) and failed once tonight.
    const dead = new Set(["a", "b"]);
    for (const r of [0, 0.4, 0.99]) {
      expect(nextPlayable(POOL, dead, null, [], () => r)?.id).toBe("c");
    }
  });

  test("does not hand back the video that is already playing", () => {
    // Without this, "Next" on a three-video channel has a real chance of
    // restarting the same hours-long video from 0:00.
    for (const r of [0, 0.4, 0.99]) {
      expect(nextPlayable(POOL, none, "a", [], () => r)?.id).not.toBe("a");
    }
  });

  test("but will repeat the only survivor rather than stop the night", () => {
    // One video left and it just ended: playing it again beats silence, which
    // is the outcome this whole module exists to avoid.
    const dead = new Set(["b", "c"]);
    expect(nextPlayable(POOL, dead, "a", [], () => 0)?.id).toBe("a");
  });

  test("nothing playable means nothing — the caller ends the night", () => {
    expect(nextPlayable(POOL, new Set(["a", "b", "c"]), null, [], () => 0)).toBeNull();
    expect(nextPlayable([], none, null, [], () => 0)).toBeNull();
  });

  test("prefers what has not been heard, the same as a podcast night", () => {
    // Delegates to pickNextEpisode, so a YouTube night gets the same freshness
    // behaviour as every other night rather than a second, divergent rule.
    const plays = [
      { id: "a", title: "a", feedId: "yt", startedAt: 1, heardSec: 999 },
      { id: "b", title: "b", feedId: "yt", startedAt: 2, heardSec: 999 },
    ];
    expect(nextPlayable(POOL, none, null, plays, () => 0)?.id).toBe("c");
  });
});

describe("what a failed video means for the night", () => {
  test("embedding disabled is remembered forever, not just tonight", () => {
    expect(decideAfterError(101, 0)).toEqual({ action: "skip", permanent: true });
    expect(decideAfterError(150, 0)).toEqual({ action: "skip", permanent: true });
  });

  test("a removed video is remembered forever too", () => {
    expect(decideAfterError(100, 0)).toEqual({ action: "skip", permanent: true });
  });

  test("the player falling over is worth another go", () => {
    expect(decideAfterError(5, 0)).toEqual({ action: "retry", permanent: false });
  });

  test("but only so many goes, or the night loops in silence", () => {
    // A video that fails with 5 every time would otherwise be retried forever:
    // the countdown runs down, the fade runs, the session ends normally, and
    // the listener got nothing.
    expect(decideAfterError(5, MAX_RETRIES)).toEqual({ action: "skip", permanent: false });
  });

  test("an unrecognised code is skipped, and not held against the video", () => {
    // We do not know it is broken, only that it did not start this time — so
    // it moves on tonight and is eligible again tomorrow.
    expect(decideAfterError(999, 0)).toEqual({ action: "skip", permanent: false });
  });
});
