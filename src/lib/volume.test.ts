import { beforeEach, describe, expect, it } from "vitest";
import { loadVolume, saveVolume, volumeIsSettable, VOLUME_MIN } from "./volume";

const KEY = "sleepcast2.volume";

beforeEach(() => localStorage.clear());

describe("volume", () => {
  it("is full until one is saved", () => {
    expect(loadVolume()).toBe(1);
  });

  it("keeps a saved level", () => {
    saveVolume(0.4);
    expect(loadVolume()).toBe(0.4);
  });

  it("saves within the slider's range", () => {
    saveVolume(0);
    expect(loadVolume()).toBe(VOLUME_MIN);
    saveVolume(3);
    expect(loadVolume()).toBe(1);
  });

  it("ignores a stored value that isn't a level", () => {
    for (const bad of ["\"loud\"", "0", "1.5", "null", "{", "-1"]) {
      localStorage.setItem(KEY, bad);
      expect(loadVolume()).toBe(1);
    }
  });

  it("asks the browser whether a page may set the volume", () => {
    // jsdom keeps what is written, like a desktop browser.
    expect(volumeIsSettable()).toBe(true);
  });
});
