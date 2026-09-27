import { describe, expect, it, test, vi } from "vitest";
import { YouTubeMedia, SWITCH_GUARD_MAX_MS, type YTPlayerLike, type CreatePlayerArgs } from "./youtube-media";

/** A stand-in for YT.Player that records calls and lets a test decide when
 *  onReady fires — which is the whole point, since the real one is not usable
 *  the moment it is constructed. */
function fakePlayer(opts: { reportsId?: boolean } = {}) {
  const calls: string[] = [];
  let args: CreatePlayerArgs | null = null;
  let created = 0;

  let state = -1;
  // The id the player says it has loaded. Deliberately NOT updated by
  // loadVideoById: the real iframe catches up later, which is the point.
  let shownId = "";
  let time = 42.5;
  const player: YTPlayerLike = {
    getPlayerState: () => state,
    playVideo: () => void calls.push("play"),
    pauseVideo: () => void calls.push("pause"),
    setVolume: (n) => void calls.push(`volume:${n}`),
    getCurrentTime: () => time,
    getDuration: () => 7200,
    loadVideoById: (id, start) => void calls.push(`load:${id}@${start ?? 0}`),
    destroy: () => void calls.push("destroy"),
    ...(opts.reportsId ? { getVideoData: () => ({ video_id: shownId }) } : {}),
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
    ended: () => { state = 0; args!.onStateChange(0); },
    error: (code: number) => args!.onError(code),
    stateChange: (s: number) => { state = s; args!.onStateChange(s); },
    showVideo: (id: string) => { shownId = id; },
    setTime: (t: number) => { time = t; },
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
    expect(onError).toHaveBeenCalledWith(150, { uncertain: false });
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

  it("resubscribe restarts the clock after the last unsubscribe", () => {
    // One interval serves every subscriber, started on the first and cleared
    // with the last. A version that nulled the timer without allowing restart
    // would pass all existing tests and silently stop progress for the second
    // episode of a night.
    vi.useFakeTimers();
    try {
      const { create, ready } = fakePlayer();
      const media = new YouTubeMedia(create);
      media.load("abc");
      ready();
      const cb1 = vi.fn();
      const off1 = media.onProgress(cb1);
      vi.advanceTimersByTime(1500);
      expect(cb1.mock.calls.length).toBeGreaterThan(0);
      off1(); // Clears the interval
      cb1.mockClear();
      vi.advanceTimersByTime(2000);
      expect(cb1).not.toHaveBeenCalled(); // Still not called
      const cb2 = vi.fn();
      media.onProgress(cb2); // Restart the clock
      vi.advanceTimersByTime(1500);
      expect(cb2.mock.calls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("partial unsubscribe leaves the clock running for the other subscriber", () => {
    // A version that cleared the interval on any unsubscribe would kill the
    // fade for whoever was still listening.
    vi.useFakeTimers();
    try {
      const { create, ready } = fakePlayer();
      const media = new YouTubeMedia(create);
      media.load("abc");
      ready();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const off1 = media.onProgress(cb1);
      media.onProgress(cb2);
      vi.advanceTimersByTime(1500);
      expect(cb1.mock.calls.length).toBeGreaterThan(0);
      expect(cb2.mock.calls.length).toBeGreaterThan(0);
      cb1.mockClear();
      cb2.mockClear();
      off1(); // Remove only the first subscriber
      vi.advanceTimersByTime(1500);
      expect(cb2.mock.calls.length).toBeGreaterThan(0); // Second still fires
      expect(cb1).not.toHaveBeenCalled(); // First does not
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
    expect(subError).toHaveBeenCalledWith(150, { uncertain: false });
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

describe("YouTubeMedia pending queue", () => {
  // The night's tick sets volume every second. A player that never becomes
  // ready (embed blocked) queued one closure per second all night, then
  // replayed them all in a burst if it did become ready.
  test("volume commands before ready collapse to the latest", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    for (let i = 0; i < 3600; i++) media.setVolume(i % 2 ? 0.5 : 0.25);
    media.setVolume(0.8);
    f.ready();
    expect(f.calls.filter((c) => c.startsWith("volume:"))).toEqual(["volume:80"]);
  });

  test("other queued commands keep their order around the volume", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    media.setVolume(0.2);
    media.pause();
    media.setVolume(0.4);
    f.ready();
    expect(f.calls).toContain("pause");
    expect(f.calls.filter((c) => c.startsWith("volume:"))).toEqual(["volume:40"]);
  });
});


describe("YouTubeMedia after a switch", () => {
  // loadVideoById returns at once, but the iframe keeps reporting the previous
  // video's state and time until it emits a state change for the new load.
  // Every reader then had to guard against stale readings itself.
  test("reports the new load as buffering at its start until the player says otherwise", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    f.stateChange(1); // A playing
    expect(media.state()).toBe(1);
    expect(media.currentTime()).toBe(42.5);
    media.load("B", 300);
    expect(media.state()).toBe(3);
    expect(media.currentTime()).toBe(300);
    expect(media.duration()).toBe(0);
    f.stateChange(-1); // B announced: the player is now talking about B
    f.stateChange(3);
    expect(media.state()).toBe(3);
    expect(media.currentTime()).toBe(42.5);
  });
});

describe("YouTubeMedia switch guard: what may end it", () => {
  // An event already in flight for the PREVIOUS video (its PLAYING, say) must
  // not end the guard: the new load announces itself as unstarted (-1) or cued
  // (5), and only that is about the new video.
  test("a stale PLAYING in flight does not end the guard; the new load's unstarted does", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    f.stateChange(1);
    media.load("B", 0);
    f.stateChange(1); // A's PLAYING, already in flight
    expect(media.state()).toBe(3);
    f.stateChange(-1); // B announced
    f.stateChange(1);
    expect(media.state()).toBe(1);
  });

  // With events lost altogether the guard must not hold forever: the new video
  // would read as unstarted while audible, and the watchdog would kill it.
  test("the guard gives up after a while if no event ever comes", () => {
    vi.useFakeTimers();
    try {
      const f = fakePlayer();
      const media = new YouTubeMedia(f.create);
      media.load("A");
      f.ready();
      f.setState(1);
      media.load("B", 0);
      expect(media.state()).toBe(3);
      vi.advanceTimersByTime(SWITCH_GUARD_MAX_MS + 1);
      expect(media.state()).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  test("destroy drops the guard, so currentTime is 0 as documented", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    media.load("B", 300);
    media.destroy();
    expect(media.currentTime()).toBe(0);
  });
});

describe("YouTubeMedia switch guard with a player that reports its video", () => {
  // Event types were a guess at which video an event was about: a stale
  // unstarted from an earlier load could end the guard early, and a load that
  // never announced itself left it on for the full timeout. A player that says
  // which video it has settles it.
  test("holds until the player reports the requested video, whatever events arrive", () => {
    const f = fakePlayer({ reportsId: true });
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    f.showVideo("A");
    f.stateChange(1);
    media.load("B", 120);
    f.stateChange(-1); // an unstarted that may belong to an earlier load
    f.stateChange(1);
    expect(media.state()).toBe(3);
    expect(media.currentTime()).toBe(120);
    f.showVideo("B");
    f.setState(3); // B, freshly loading
    expect(media.state()).toBe(3);
  });

  test("a load that never announces itself is released as soon as the player shows it", () => {
    const f = fakePlayer({ reportsId: true });
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    f.showVideo("A");
    media.load("B");
    f.showVideo("B"); // no -1 or 5 event at all
    f.setState(1);
    f.setTime(0.5); // playing from its start
    expect(media.state()).toBe(1);
  });
});

describe("YouTubeMedia.eventState", () => {
  // Players decide PLAYING/PAUSED/ENDED from the event. Reading the player's
  // cached state instead assumed it had caught up with the event it was
  // dispatching; outside a switch the event's own value is the truth.
  test("is the event's own state outside a switch, even if the cache lags", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    f.setState(1); // cache still says playing
    expect(media.eventState(0)).toBe(0); // the ENDED event is believed
  });

  test("is unstarted during a switch, so a stale ENDED can't skip the new video", () => {
    const f = fakePlayer({ reportsId: true });
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    f.showVideo("A");
    media.load("B");
    expect(media.eventState(0)).toBe(3);
    f.showVideo("B");
    expect(media.eventState(0)).toBe(0);
  });
});

describe("YouTubeMedia guard timing", () => {
  // A load queued before ready used to arm the guard when queued, so it could
  // expire (or be cleared by the first video's own startup) before the load
  // even ran.
  test("the guard starts when the queued load actually runs", () => {
    vi.useFakeTimers();
    try {
      const f = fakePlayer();
      const media = new YouTubeMedia(f.create);
      media.load("A");
      media.load("B", 60); // queued: not ready yet
      vi.advanceTimersByTime(SWITCH_GUARD_MAX_MS + 1);
      f.ready(); // loadVideoById(B) runs now
      f.setState(1);
      expect(media.state()).toBe(3);
      expect(media.currentTime()).toBe(60);
    } finally { vi.useRealTimers(); }
  });
});

describe("YouTubeMedia switch guard: same id, errors, bounds", () => {
  // Requesting the video the player already shows (A → B → A quickly, or a
  // retry of the same video) matched the id at once, before the player had
  // restarted anything, and let the in-between video's events through.
  test("a same-id switch holds until the player shows a fresh load", () => {
    const f = fakePlayer({ reportsId: true });
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    f.showVideo("A");
    f.setState(1);
    f.setTime(500);
    media.load("A", 30);
    expect(media.eventState(1)).toBe(3); // still A's old playback
    f.setState(3); // the reload is buffering
    expect(media.state()).toBe(3);
  });

  test("a same-id switch also releases once the position is at the requested start", () => {
    const f = fakePlayer({ reportsId: true });
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    f.showVideo("A");
    f.setState(1);
    f.setTime(500);
    media.load("A", 30);
    f.setTime(31);
    expect(media.state()).toBe(1);
  });

  // An error doesn't say which video it's about. Holding or dropping it
  // mid-switch guessed, and a wrong guess blocked a working video or stalled a
  // night on a dead one. It is delivered at once, marked uncertain mid-switch.
  test("an error during a switch is delivered at once, marked uncertain", () => {
    const f = fakePlayer({ reportsId: true });
    const errs: Array<[number | string, boolean]> = [];
    const media = new YouTubeMedia(f.create, { onError: (c, i) => errs.push([c, i.uncertain]) });
    media.onError((c, i) => errs.push([`sub:${c}`, i.uncertain]));
    media.load("A");
    f.ready();
    f.showVideo("A");
    f.setState(1);
    f.setTime(500);
    media.load("B");
    f.error(150);
    expect(errs).toEqual([[150, true], ["sub:150", true]]);
  });

  test("an error outside a switch is certain", () => {
    const f = fakePlayer({ reportsId: true });
    const errs: boolean[] = [];
    const media = new YouTubeMedia(f.create, { onError: (_c, i) => errs.push(i.uncertain) });
    media.load("A");
    f.ready();
    f.showVideo("A");
    f.error(101);
    expect(errs).toEqual([false]);
  });

  // A retry reloads at the position the player already shows, so "at the
  // requested start" held at once and released before anything restarted.
  test("a retry at the current position waits for a fresh state, not the position", () => {
    const f = fakePlayer({ reportsId: true });
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    f.showVideo("A");
    f.setState(1);
    f.setTime(1800);
    media.load("A", 1800);
    expect(media.state()).toBe(3);
    f.setState(3);
    expect(media.state()).toBe(3);
  });

  // Requesting the video that just ended (a lone survivor repeating) would
  // confirm on the old load's own ENDED, which sits at its end.
  test("the old load's ENDED does not confirm re-requesting the same video", () => {
    const f = fakePlayer({ reportsId: true });
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    f.showVideo("A");
    f.setState(0);
    f.setTime(3600);
    media.load("A", 0);
    expect(media.eventState(0)).toBe(3);
  });

  // A Short past a long skip-intro ends before confirming on this path, and
  // the ENDED reads as loading; the players skip a never-played episode that
  // ends either way.
  test("an ENDED before the requested start does not confirm either", () => {
    const f = fakePlayer({ reportsId: true });
    const media = new YouTubeMedia(f.create);
    media.load("A");
    f.ready();
    f.showVideo("A");
    f.setState(1);
    f.setTime(500);
    media.load("B", 300);
    f.showVideo("B");
    f.setTime(60);
    f.setState(0);
    expect(media.eventState(0)).toBe(3);
  });

  test("an error while the new video already shows freshly loaded is certain", () => {
    const f = fakePlayer({ reportsId: true });
    const errs: boolean[] = [];
    const media = new YouTubeMedia(f.create, { onError: (_c, i) => errs.push(i.uncertain) });
    media.load("A");
    f.ready();
    f.showVideo("A");
    f.setState(1);
    f.setTime(500);
    media.load("B");
    f.showVideo("B");
    f.setState(-1);
    f.error(150);
    expect(errs).toEqual([false]);
  });

  test("events and errors after destroy are ignored", () => {
    const f = fakePlayer({ reportsId: true });
    let ended = 0;
    const errs: number[] = [];
    const media = new YouTubeMedia(f.create, { onEnded: () => ended++, onError: (c) => errs.push(c) });
    media.load("A");
    f.ready();
    media.destroy();
    f.ended();
    f.error(150);
    expect(ended).toBe(0);
    expect(errs).toEqual([]);
  });

  // With the id check the guard had no upper bound: a load dropped without an
  // error left the player on the old id, and everything read unstarted forever.
  test("the guard is bounded even when the player reports ids", () => {
    vi.useFakeTimers();
    try {
      const f = fakePlayer({ reportsId: true });
      const media = new YouTubeMedia(f.create);
      media.load("A");
      f.ready();
      f.showVideo("A");
      f.setState(1);
      media.load("B");
      expect(media.state()).toBe(3);
      vi.advanceTimersByTime(SWITCH_GUARD_MAX_MS + 1);
      expect(media.state()).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  test("routeStateEvent sends each state to its handler, filtered by the guard", () => {
    const f = fakePlayer({ reportsId: true });
    const media = new YouTubeMedia(f.create);
    const seen: string[] = [];
    media.onEnded(() => seen.push("ended"));
    const h = {
      transport: (t: string) => seen.push(`t:${t}`),
      playing: () => seen.push("playing"),
      paused: () => seen.push("paused"),
    };
    media.load("A");
    f.ready();
    f.showVideo("A");
    f.setState(1);
    f.setTime(500);
    media.routeStateEvent(1, h);
    media.routeStateEvent(2, h);
    media.load("B");
    media.routeStateEvent(0, h); // A's stale ENDED: must not end B
    expect(seen).toEqual(["t:playing", "playing", "t:paused", "paused", "t:buffering"]);
    f.showVideo("B");
    f.setState(3);
    expect(media.state()).toBe(3); // a tick sees B, freshly loading: confirmed
    f.ended(); // B's own ENDED, fired by the wrapper from the event
    expect(seen.at(-1)).toBe("ended");
  });

  test("with an onStateEvent handler, every state event reaches it", () => {
    const f = fakePlayer();
    const raws: number[] = [];
    const media = new YouTubeMedia(f.create, { onStateEvent: (r) => raws.push(r) });
    media.load("A");
    f.ready();
    f.stateChange(1);
    f.stateChange(0);
    expect(raws).toEqual([1, 0]);
  });
});

describe("YouTubeMedia fires ENDED itself", () => {
  test("even when the caller's state handler ignores the event", () => {
    const f = fakePlayer();
    let ended = 0;
    const media = new YouTubeMedia(f.create, { onStateEvent: () => {}, onEnded: () => ended++ });
    media.load("A");
    f.ready();
    f.ended();
    expect(ended).toBe(1);
  });

  test("onReady reports whether the wrapper is still live", async () => {
    let live: boolean | null = null;
    const media = new YouTubeMedia((args) => {
      queueMicrotask(() => { live = args.onReady(); });
      return fakePlayer().create(args);
    });
    media.load("A");
    media.destroy();
    await Promise.resolve();
    expect(live).toBe(false);
  });
});

describe("YouTubeMedia subscriber dispatch", () => {
  // Night's handler unsubscribes and re-subscribes itself while handling (a
  // skip starts the next episode). Looping over the live Set visited the
  // re-added handler again: one error blocked every following video.
  test("a handler that re-subscribes during dispatch runs once", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    let calls = 0;
    let off = () => {};
    const handler = () => {
      calls++;
      if (calls > 10) return; // don't hang the test if it regresses
      off();
      off = media.onError(handler);
    };
    off = media.onError(handler);
    media.load("A");
    f.ready();
    f.error(150);
    expect(calls).toBe(1);
  });

  test("the same holds for ended", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    let calls = 0;
    let off = () => {};
    const handler = () => {
      calls++;
      if (calls > 10) return;
      off();
      off = media.onEnded(handler);
    };
    off = media.onEnded(handler);
    media.load("A");
    f.ready();
    f.ended();
    expect(calls).toBe(1);
  });
});

describe("YouTubeMedia: the real Short-past-skip-intro sequence", () => {
  // The player announces the load (-1) before the Short hits its end, so the
  // switch confirms and the ENDED reaches onEnded. The wrapper passes it on;
  // the players decide it was a failure, since nothing played.
  test("unstarted then ended: the switch confirms and ENDED is fired", () => {
    const f = fakePlayer({ reportsId: true });
    let ended = 0;
    const media = new YouTubeMedia(f.create, { onEnded: () => ended++ });
    media.load("A");
    f.ready();
    f.showVideo("A");
    f.setState(1);
    f.setTime(500);
    media.load("B", 300);
    f.showVideo("B");
    f.stateChange(-1);
    f.setTime(50);
    f.ended();
    expect(ended).toBe(1);
  });
});

describe("YouTubeMedia progress dispatch", () => {
  test("a progress handler that re-subscribes during dispatch runs once per poll", () => {
    vi.useFakeTimers();
    try {
      const f = fakePlayer();
      const media = new YouTubeMedia(f.create);
      let calls = 0;
      let off = () => {};
      const handler = () => {
        calls++;
        if (calls > 10) return;
        off();
        off = media.onProgress(handler);
      };
      off = media.onProgress(handler);
      media.load("A");
      f.ready();
      vi.advanceTimersByTime(1000);
      expect(calls).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  test("dispatch stops once a handler destroys the media", () => {
    const f = fakePlayer();
    const media = new YouTubeMedia(f.create);
    const seen: string[] = [];
    media.onError(() => { seen.push("first"); media.destroy(); });
    media.onError(() => seen.push("second"));
    media.load("A");
    f.ready();
    f.error(150);
    expect(seen).toEqual(["first"]);
  });
});

describe("YouTubeMedia: an ENDED swallowed during a switch", () => {
  // A short video that plays and ends while the guard still holds had its
  // ENDED read as loading and dropped, and nothing sent it again: the night
  // sat silent until the watchdog.
  test("is fired once the guard lets go, if the player still shows ENDED", async () => {
    vi.useFakeTimers();
    try {
      const f = fakePlayer({ reportsId: true });
      let ended = 0;
      const media = new YouTubeMedia(f.create, { onEnded: () => ended++ });
      media.load("A");
      f.ready();
      f.showVideo("A");
      f.setState(1);
      f.setTime(500);
      media.load("B"); // the player never reports B (lagging id)
      f.ended(); // B played and ended inside the hold
      expect(ended).toBe(0);
      vi.advanceTimersByTime(SWITCH_GUARD_MAX_MS + 1);
      media.state(); // the next tick lets go of the guard
      await Promise.resolve();
      expect(ended).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  test("is not fired if the player has moved on by then", async () => {
    vi.useFakeTimers();
    try {
      const f = fakePlayer({ reportsId: true });
      let ended = 0;
      const media = new YouTubeMedia(f.create, { onEnded: () => ended++ });
      media.load("A");
      f.ready();
      f.showVideo("A");
      f.setState(1);
      f.setTime(500);
      media.load("B");
      f.ended();
      f.setState(1); // playing again
      vi.advanceTimersByTime(SWITCH_GUARD_MAX_MS + 1);
      media.state();
      await Promise.resolve();
      expect(ended).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
