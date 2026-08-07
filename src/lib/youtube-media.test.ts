import { describe, expect, it, test, vi } from "vitest";
import { YouTubeMedia, type YTPlayerLike, type CreatePlayerArgs } from "./youtube-media";

/** A stand-in for YT.Player that records calls and lets a test decide when
 *  onReady fires — which is the whole point, since the real one is not usable
 *  the moment it is constructed. */
function fakePlayer() {
  const calls: string[] = [];
  let args: CreatePlayerArgs | null = null;
  let created = 0;

  let state = -1;
  const player: YTPlayerLike = {
    getPlayerState: () => state,
    playVideo: () => void calls.push("play"),
    pauseVideo: () => void calls.push("pause"),
    setVolume: (n) => void calls.push(`volume:${n}`),
    getCurrentTime: () => 42.5,
    getDuration: () => 7200,
    loadVideoById: (id, start) => void calls.push(`load:${id}@${start ?? 0}`),
    destroy: () => void calls.push("destroy"),
  };

  return {
    calls,
    created: () => created,
    create: (a: CreatePlayerArgs) => {
      created++;
      args = a;
      calls.push(`create:${a.videoId}@${a.startSeconds ?? 0}`);
      return player;
    },
    ready: () => args!.onReady(),
    setState: (s: number) => { state = s; },
    ended: () => args!.onEnded(),
    error: (code: number) => args!.onError(code),
  };
}

describe("commands issued before the player is ready", () => {
  test("are queued, not dropped", () => {
    // An <audio> takes .play() immediately; a YT player rejects everything
    // until onReady. A night that starts fading at t=0 must not lose it.
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);

    media.load("AAAAAAAAAAA");
    media.setVolume(1);
    media.play();

    expect(f.calls).toEqual(["create:AAAAAAAAAAA@0"]);
  });

  test("and replay in the order they were issued once it fires", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);

    media.load("AAAAAAAAAAA");
    media.setVolume(0.5);
    media.play();
    f.ready();

    expect(f.calls).toEqual(["create:AAAAAAAAAAA@0", "volume:50", "play"]);
  });

  test("a second load before ready does not build a second player", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);

    media.load("AAAAAAAAAAA");
    media.load("BBBBBBBBBBB");
    f.ready();

    expect(f.created()).toBe(1);
    expect(f.calls).toEqual(["create:AAAAAAAAAAA@0", "load:BBBBBBBBBBB@0"]);
  });
});

describe("volume, which is on a different scale", () => {
  test("0-1 becomes 0-100", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();

    media.setVolume(1);
    media.setVolume(0.25);
    media.setVolume(0);

    expect(f.calls.slice(1)).toEqual(["volume:100", "volume:25", "volume:0"]);
  });

  test("rounds, because setVolume wants a whole number", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    media.setVolume(0.333);
    expect(f.calls.slice(1)).toEqual(["volume:33"]);
  });

  test("clamps out-of-range input rather than passing it through", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    media.setVolume(2);
    media.setVolume(-1);
    expect(f.calls.slice(1)).toEqual(["volume:100", "volume:0"]);
  });
});

describe("reading the clock", () => {
  test("returns 0 before ready instead of throwing or NaN", () => {
    // The countdown reads this every tick, including during the first second
    // while the iframe is still coming up.
    const media = new YouTubeMedia(fakePlayer().create);
    media.load("A");
    expect(media.currentTime()).toBe(0);
    expect(media.duration()).toBe(0);
  });

  test("reports the player's values once ready", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    expect(media.currentTime()).toBe(42.5);
    expect(media.duration()).toBe(7200);
  });
});

describe("after the night ends", () => {
  test("destroy tears the player down", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    media.destroy();
    expect(f.calls).toContain("destroy");
  });

  test("later commands are ignored, not thrown into a dead iframe", () => {
    // The countdown interval and the fade can both fire after a session ends.
    // This codebase has been bitten by exactly that before — it is why
    // tick-gate.ts exists — so the failure must be inert here too.
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    media.destroy();
    const after = f.calls.length;

    media.play();
    media.setVolume(0.5);
    media.load("BBBBBBBBBBB");

    expect(f.calls.length).toBe(after);
    expect(media.currentTime()).toBe(0);
  });

  test("destroy twice is harmless", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    media.destroy();
    media.destroy();
    expect(f.calls.filter((c) => c === "destroy").length).toBe(1);
  });

  test("readiness arriving after destroy does not resurrect queued commands", () => {
    // The iframe can finish loading after the user has already ended the
    // night. Flushing the queue then would start audio with nothing to stop it.
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    media.play();
    media.destroy();
    f.ready();
    expect(f.calls).toEqual(["create:A@0", "destroy"]);
  });
});

describe("events the night depends on", () => {
  test("ended reaches the caller, so the next episode can start", () => {
    const onEnded = vi.fn();
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create, { onEnded });
    media.load("A");
    f.ready();
    f.ended();
    expect(onEnded).toHaveBeenCalledOnce();
  });

  test("errors reach the caller with the code, so a dead video can be skipped", () => {
    const onError = vi.fn();
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create, { onError });
    media.load("A");
    f.ready();
    f.error(150); // "embedding disabled by the uploader" — a real, common case
    expect(onError).toHaveBeenCalledWith(150);
  });
});

describe("picking up where a reload left off", () => {
  test("passes the start position through to the player", async () => {
    // A night snapshotted before a refresh revives at the second it stopped.
    // Without this the listener is dropped back at 0:00 of a four-hour video.
    const { create, calls } = fakePlayer();
    const media = new YouTubeMedia(create);
    media.load("abc", 1830);
    expect(calls).toContain("create:abc@1830");
  });

  test("a later video starts at the top unless told otherwise", () => {
    const { create, calls, ready } = fakePlayer();
    const media = new YouTubeMedia(create);
    media.load("abc");
    ready();
    media.load("def");
    expect(calls).toContain("load:def@0");
  });

  test("switching videos can also start mid-way", () => {
    const { create, calls, ready } = fakePlayer();
    const media = new YouTubeMedia(create);
    media.load("abc");
    ready();
    media.load("def", 42);
    expect(calls).toContain("load:def@42");
  });
});

describe("asking the player what it is actually doing", () => {
  test("reports unstarted before it is ready", () => {
    // The whole reason this exists: mirroring state into a boolean on the
    // events we happened to handle means the ones we didn't (unstarted, cued,
    // buffering) leave the UI asserting something false.
    const { create } = fakePlayer();
    const media = new YouTubeMedia(create);
    media.load("abc");
    expect(media.state()).toBe(-1);
  });

  test("reports the player's own state once ready", () => {
    const { create, ready, setState } = fakePlayer();
    const media = new YouTubeMedia(create);
    media.load("abc");
    ready();
    setState(1);
    expect(media.state()).toBe(1);
    setState(5);
    expect(media.state()).toBe(5);
  });

  test("reports unstarted after destroy rather than throwing", () => {
    const { create, ready, setState } = fakePlayer();
    const media = new YouTubeMedia(create);
    media.load("abc");
    ready();
    setState(1);
    media.destroy();
    expect(media.state()).toBe(-1);
  });
});

describe("conforming to the shared backend interface", () => {
  it("polls its own clock, because an iframe emits no timeupdate", () => {
    // An <audio> gets progress free from timeupdate, which survives a locked
    // screen. There is no equivalent here, so the backend owns an interval and
    // the orchestrator never learns the difference.
    vi.useFakeTimers();
    try {
      const { create, ready } = fakePlayer();
      const media = new YouTubeMedia(create);
      media.load("abc");
      ready();
      const cb = vi.fn();
      media.onProgress(cb);
      vi.advanceTimersByTime(2000);
      expect(cb.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribing stops the callbacks", () => {
    vi.useFakeTimers();
    try {
      const { create, ready } = fakePlayer();
      const media = new YouTubeMedia(create);
      media.load("abc");
      ready();
      const cb = vi.fn();
      const off = media.onProgress(cb);
      off();
      vi.advanceTimersByTime(3000);
      expect(cb).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroy stops the polling", () => {
    // An interval outliving the night is the bug tick-gate.ts exists for.
    vi.useFakeTimers();
    try {
      const { create, ready } = fakePlayer();
      const media = new YouTubeMedia(create);
      media.load("abc");
      ready();
      const cb = vi.fn();
      media.onProgress(cb);
      media.destroy();
      vi.advanceTimersByTime(5000);
      expect(cb).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("subscribed ended and error fire alongside the constructor handlers", () => {
    // YouTubeNight.tsx passes handlers to the constructor and must keep
    // working — this is additive, not a replacement.
    const ctorEnded = vi.fn();
    const { create, ready, ended, error } = fakePlayer();
    const media = new YouTubeMedia(create, { onEnded: ctorEnded });
    media.load("abc");
    ready();
    const subEnded = vi.fn();
    const subError = vi.fn();
    media.onEnded(subEnded);
    media.onError(subError);
    ended();
    error(150);
    expect(ctorEnded).toHaveBeenCalledTimes(1);
    expect(subEnded).toHaveBeenCalledTimes(1);
    expect(subError).toHaveBeenCalledWith(150);
  });

  it("transport maps YT's state codes, not a mirrored boolean", () => {
    const { create, ready, setState } = fakePlayer();
    const media = new YouTubeMedia(create);
    media.load("abc");
    ready();
    setState(1);
    expect(media.transport()).toBe("playing");
    setState(2);
    expect(media.transport()).toBe("paused");
    setState(-1);
    expect(media.transport()).toBe("awaiting-start");
    setState(3);
    expect(media.transport()).toBe("buffering");
  });

  it("transport reports dead rather than awaiting-start once destroyed", () => {
    // state() falls back to -1 after destroy, and transportFor(-1) reads that
    // as "awaiting-start" — the reading that once drew a tap prompt over a
    // play() that can no longer do anything. transport() must catch destroy
    // before transportFor ever sees the -1.
    const { create, ready } = fakePlayer();
    const media = new YouTubeMedia(create);
    media.load("abc");
    ready();
    media.destroy();
    expect(media.transport()).toBe("dead");
  });
});
