import { describe, expect, test, vi, afterEach } from "vitest";
import { clearLockScreen, publishLockScreen, publishLockScreenMetadata, setActionHandlers } from "./lock-screen";

describe("clearLockScreen", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaSession");
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "mediaSession", original);
    else delete (navigator as unknown as { mediaSession?: unknown }).mediaSession;
  });

  test("clears metadata, play state and position", () => {
    const setPositionState = vi.fn();
    const ms = { metadata: { title: "x" }, playbackState: "playing", setPositionState };
    Object.defineProperty(navigator, "mediaSession", { value: ms, configurable: true });
    clearLockScreen();
    expect(ms.metadata).toBeNull();
    expect(ms.playbackState).toBe("none");
    expect(setPositionState).toHaveBeenCalledWith();
  });
});

describe("publishLockScreen", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaSession");
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "mediaSession", original);
    else delete (navigator as unknown as { mediaSession?: unknown }).mediaSession;
  });

  test("state and position, or a cleared position without a span", () => {
    const setPositionState = vi.fn();
    const ms = { playbackState: "none", setPositionState };
    Object.defineProperty(navigator, "mediaSession", { value: ms, configurable: true });
    publishLockScreen("paused", { pos: 30, dur: 600 }, 1);
    expect(ms.playbackState).toBe("paused");
    expect(setPositionState).toHaveBeenLastCalledWith({ duration: 600, position: 30, playbackRate: 1 });
    publishLockScreen("playing", null, 1);
    expect(setPositionState).toHaveBeenLastCalledWith();
  });
});

describe("publishLockScreenMetadata and setActionHandlers", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaSession");
  const originalMeta = (globalThis as { MediaMetadata?: unknown }).MediaMetadata;
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "mediaSession", original);
    else delete (navigator as unknown as { mediaSession?: unknown }).mediaSession;
    (globalThis as { MediaMetadata?: unknown }).MediaMetadata = originalMeta;
  });

  test("metadata falls back to the app name, and survives artwork the browser rejects", () => {
    const ms: { metadata: unknown } = { metadata: null };
    Object.defineProperty(navigator, "mediaSession", { value: ms, configurable: true });
    (globalThis as { MediaMetadata?: unknown }).MediaMetadata = class {
      constructor(init: { artwork?: unknown[] }) {
        if (init.artwork) throw new TypeError("bad artwork URL");
        Object.assign(this, init);
      }
    };
    publishLockScreenMetadata("Episode", undefined, "http://");
    expect(ms.metadata).toMatchObject({ title: "Episode", artist: "sleepcast", album: "sleepcast" });
  });

  test("handlers are set one by one and torn down exactly", () => {
    const set: Record<string, unknown> = {};
    const ms = {
      setActionHandler: (a: string, h: unknown) => {
        if (a === "seekto") throw new TypeError("unknown action");
        set[a] = h;
      },
    };
    Object.defineProperty(navigator, "mediaSession", { value: ms, configurable: true });
    const teardown = setActionHandlers({ play: () => {}, seekto: () => {}, pause: () => {} });
    expect(Object.keys(set).sort()).toEqual(["pause", "play"]);
    teardown();
    expect(set.play).toBeNull();
    expect(set.pause).toBeNull();
  });
});
