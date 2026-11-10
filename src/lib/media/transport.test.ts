import { describe, expect, test } from "vitest";
import { isPlayingThrough, mediaTransport, rearmsWatchdogOnTap } from "./transport";

describe("isPlayingThrough", () => {
  test("not paused, with data ahead", () => {
    expect(isPlayingThrough({ paused: false, readyState: 3 })).toBe(true);
    expect(isPlayingThrough({ paused: false, readyState: 2 })).toBe(false);
    expect(isPlayingThrough({ paused: true, readyState: 4 })).toBe(false);
  });
});

describe("mediaTransport", () => {
  test("paused, playing through, or buffering", () => {
    expect(mediaTransport({ paused: true, readyState: 4, seeking: false })).toBe("paused");
    expect(mediaTransport({ paused: false, readyState: 4, seeking: false })).toBe("playing");
    expect(mediaTransport({ paused: false, readyState: 1, seeking: false })).toBe("buffering");
    expect(mediaTransport({ paused: false, readyState: 4, seeking: true })).toBe("buffering");
  });
});

describe("rearmsWatchdogOnTap", () => {
  test("only for an unplayed episode that is not already buffering", () => {
    expect(rearmsWatchdogOnTap(false, "paused")).toBe(true);
    expect(rearmsWatchdogOnTap(false, "buffering")).toBe(false);
    expect(rearmsWatchdogOnTap(true, "paused")).toBe(false);
  });
});
