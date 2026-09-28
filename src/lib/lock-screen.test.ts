import { describe, expect, test, vi, afterEach } from "vitest";
import { clearLockScreen } from "./lock-screen";

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
