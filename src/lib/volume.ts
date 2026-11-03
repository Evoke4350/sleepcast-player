// The listener's volume: one level for the whole night, under the fade and
// each feed's trim (effectiveVolume). Kept under its own key, not in the app
// state, which the Sleep screen holds and saves whole: a change made on Now
// Playing would be written over by the screen's older copy.
//
// Some phones don't let a page set the volume at all. iPhone Safari has kept
// it under the side buttons, reading back 1 whatever is written, so a slider
// there would move and change nothing. volumeIsSettable asks the browser.

import { writeMakingRoom } from "./store";

const KEY = "sleepcast2.volume";

/** The quietest the slider goes: silence is what pause is for. */
export const VOLUME_MIN = 0.05;

const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= VOLUME_MIN && n <= 1;

/** The saved level, or 1 (full) if none. */
export function loadVolume(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return valid(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function saveVolume(level: number): void {
  try {
    writeMakingRoom(KEY, JSON.stringify(Math.min(1, Math.max(VOLUME_MIN, level))));
  } catch {
    /* quota / private mode */
  }
}

/** Whether this browser lets a page set an audio element's volume. */
export function volumeIsSettable(): boolean {
  try {
    const probe = document.createElement("audio");
    probe.volume = 0.5;
    return Math.abs(probe.volume - 0.5) < 0.01;
  } catch {
    return false;
  }
}
