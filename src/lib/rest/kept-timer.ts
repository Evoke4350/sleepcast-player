// "Your timer": a timer you chose to keep, set each night ahead of the
// learned one until you change it. Saved when an experiment between two
// timers ends with a winner (Experiments, Done), and dropped by going back
// to the learned timer on the Sleep screen.
//
// A saved preference, not worked out again from the experiments each night:
// once dropped, it stays dropped. Kept under its own key, not in the app
// state, which the Sleep screen holds and saves whole.

import { TIMER_MAX, TIMER_MIN, writeMakingRoom } from "../store";

const KEY = "sleepcast2.keptTimer";

export interface KeptTimer {
  minutes: number;
  /** The timer it beat, for saying why. */
  beat: number;
}

const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= TIMER_MIN && n <= TIMER_MAX;

export function keptTimer(): KeptTimer | null {
  try {
    const raw = localStorage.getItem(KEY);
    const k = raw ? (JSON.parse(raw) as Partial<KeptTimer>) : null;
    return k && valid(k.minutes) && valid(k.beat) ? { minutes: k.minutes, beat: k.beat } : null;
  } catch {
    return null;
  }
}

export function keepTimer(k: KeptTimer): void {
  try {
    writeMakingRoom(KEY, JSON.stringify(k));
  } catch {
    /* quota / private mode */
  }
}

export function dropKeptTimer(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* unavailable */
  }
}
