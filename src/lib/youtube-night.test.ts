import { describe, expect, test } from "vitest";
import {
  nextPlayable,
  decideAfterError,
  isYouTubeLineup,
  isMixedLineup,
  transportFor,
  shouldGiveUp,
  YT_STATE,
  MAX_RETRIES,
} from "./youtube-night";
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

describe("telling a YouTube lineup from a podcast one", () => {
  const pod: Episode = { id: "p", title: "p", url: "https://x/a.mp3", feedId: "f", date: "" };

  test("all videos is a YouTube night", () => {
    expect(isYouTubeLineup(POOL)).toBe(true);
  });

  test("all podcasts is not", () => {
    expect(isYouTubeLineup([pod])).toBe(false);
  });

  test("an empty lineup is not a YouTube night", () => {
    // [].every() is true, so the obvious one-liner routes an empty pool to the
    // video player, which then renders a black rectangle and no explanation.
    expect(isYouTubeLineup([])).toBe(false);
  });

  test("a mix is neither, and has to be caught before a night starts", () => {
    // The video path cannot play an enclosure and the audio path cannot play a
    // videoId. Whichever one ran would silently drop half the lineup.
    expect(isYouTubeLineup([...POOL, pod])).toBe(false);
    expect(isMixedLineup([...POOL, pod])).toBe(true);
    expect(isMixedLineup(POOL)).toBe(false);
    expect(isMixedLineup([pod])).toBe(false);
    expect(isMixedLineup([])).toBe(false);
  });
});

describe("what the player's state means for the transport", () => {
  test("playing and paused are what they look like", () => {
    expect(transportFor(YT_STATE.PLAYING)).toBe("playing");
    expect(transportFor(YT_STATE.PAUSED)).toBe("paused");
  });

  test("buffering is not paused", () => {
    // Showing "Resume" mid-buffer invites a tap that pauses a video which was
    // about to start on its own.
    expect(transportFor(YT_STATE.BUFFERING)).toBe("buffering");
  });

  test("unstarted and cued mean it is waiting to be told to go", () => {
    // This is the case that was being rendered as "playing". A loaded video
    // that has never started is not paused and not playing — it needs a tap,
    // and the UI has to say so rather than show a Pause button for silence.
    expect(transportFor(YT_STATE.UNSTARTED)).toBe("awaiting-start");
    expect(transportFor(YT_STATE.CUED)).toBe("awaiting-start");
  });

  test("ended is not a state to draw a transport from", () => {
    expect(transportFor(YT_STATE.ENDED)).toBe("buffering");
  });

  test("a state nobody documented does not become 'playing'", () => {
    expect(transportFor(99)).toBe("buffering");
  });
});

describe("when a stalled video should be given up on", () => {
  const base = { elapsedMs: 60_000, limitMs: 25_000, hasEverPlayed: true };

  test("a video stuck buffering past the limit is skipped", () => {
    expect(shouldGiveUp({ ...base, state: YT_STATE.BUFFERING })).toBe(true);
  });

  test("not before the limit", () => {
    expect(shouldGiveUp({ ...base, state: YT_STATE.BUFFERING, elapsedMs: 1000 })).toBe(false);
  });

  test("a video that is playing is never given up on", () => {
    expect(shouldGiveUp({ ...base, state: YT_STATE.PLAYING })).toBe(false);
  });

  test("nor one the listener paused", () => {
    // Sitting at 0:00 for an hour because someone paused it is a choice, not
    // a stall.
    expect(shouldGiveUp({ ...base, state: YT_STATE.PAUSED })).toBe(false);
  });

  test("an unstarted video before anything has ever played is NOT a dead video", () => {
    // This is the autoplay case, and getting it wrong is expensive: the
    // browser is refusing to start any video without a tap, so skipping burns
    // through the entire lineup in under three minutes and ends the night
    // having played nothing. It needs a tap, not a funeral.
    expect(shouldGiveUp({ ...base, state: YT_STATE.UNSTARTED, hasEverPlayed: false })).toBe(false);
    expect(shouldGiveUp({ ...base, state: YT_STATE.CUED, hasEverPlayed: false })).toBe(false);
  });

  test("but once something has played, autoplay works and a stall is real", () => {
    // Playback is permitted — this video specifically is not starting.
    expect(shouldGiveUp({ ...base, state: YT_STATE.UNSTARTED, hasEverPlayed: true })).toBe(true);
  });
});
