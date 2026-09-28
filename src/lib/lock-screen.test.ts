import { describe, expect, test, vi, afterEach } from "vitest";
import { clearLockScreen, publishLockScreen } from "./lock-screen";

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
