// What wakes you: whether waking, by the watch, follows what Sleepcast does
// while you sleep more often than chance would have it.
//
// Two things Sleepcast does can wake a sleeper: start a new episode (a fresh
// intro, a jingle, an ad, a different voice), and stop (the sound ending, or
// its fade). Each time one happens while the watch has you asleep, look for
// a waking within WAKE_WINDOW_MS after it. Chance is how often a waking would
// start that soon after any moment of that night's sleep: a restless night
// wakes after anything.

import type { RestNight, SleepStretch } from "./types";

export const WAKE_WINDOW_MS = 3 * 60 * 1000;

export type WakeCause = "episode" | "stop";

export interface NightEvent {
  /** ms from night start. */
  t: number;
  cause: WakeCause;
  /** A waking started within WAKE_WINDOW_MS after it. */
  woke: boolean;
  /** How likely that was for this night by chance. */
  chance: number;
}

function asleepAt(stretches: readonly SleepStretch[], t: number): boolean {
  return stretches.some((s) => s.stage !== "awake" && s.from <= t && t < s.to);
}

/** A waking: an awake stretch straight after sleep. */
function wakeStarts(stretches: readonly SleepStretch[]): number[] {
  return stretches.filter((s, i) => s.stage === "awake" && i > 0 && stretches[i - 1].stage !== "awake" && stretches[i - 1].to === s.from).map((s) => s.from);
}

/** What Sleepcast did while the watch had you asleep, and whether you woke after it. */
export function eventsWhileAsleep(n: RestNight): NightEvent[] {
  const stretches = n.watchSleep;
  if (!stretches?.length) return [];
  const wakes = wakeStarts(stretches);
  const asleepMs = stretches.filter((s) => s.stage !== "awake").reduce((t, s) => t + s.to - s.from, 0);
  if (!asleepMs) return [];
  const chance = Math.min(1, (wakes.length * WAKE_WINDOW_MS) / asleepMs);

  const events: { t: number; cause: WakeCause }[] = [
    // The first episode starts as you press play: you're awake for it.
    ...[...(n.episodes ?? [])].sort((a, b) => a.t - b.t).slice(1).map((e) => ({ t: e.t, cause: "episode" as const })),
    // Stopping by hand means you were awake to do it.
    ...(n.endedVia !== "abandoned" && n.playedMs ? [{ t: n.playedMs, cause: "stop" as const }] : []),
  ];
  return events
    .filter((e) => asleepAt(stretches, e.t))
    .map((e) => ({ ...e, woke: wakes.some((w) => w > e.t && w <= e.t + WAKE_WINDOW_MS), chance }));
}

export interface WakeAudit {
  cause: WakeCause;
  /** Times it happened while you slept, and how many were followed by waking. */
  events: number;
  woke: number;
  /** Wakings chance alone would give. */
  expected: number;
  /** How likely this many wakings or more would be by chance alone. */
  pValue: number;
  verdict: "wakes" | "doesnt" | "unclear";
}

/** Enough times for a verdict either way. */
export const MIN_EVENTS = 5;

/** P(at least k of the events woke you) if each did with its own chance:
 *  the Poisson binomial tail, exact by dynamic programming. */
export function tailProbability(chances: readonly number[], k: number): number {
  let dist = [1];
  for (const p of chances) {
    const next = new Array(dist.length + 1).fill(0);
    dist.forEach((q, i) => {
      next[i] += q * (1 - p);
      next[i + 1] += q * p;
    });
    dist = next;
  }
  return Math.min(1, dist.slice(k).reduce((a, b) => a + b, 0));
}

export function wakeAudit(nights: readonly RestNight[]): WakeAudit[] {
  const all = nights.flatMap(eventsWhileAsleep);
  return (["episode", "stop"] as const).flatMap((cause) => {
    const evs = all.filter((e) => e.cause === cause);
    if (!evs.length) return [];
    const woke = evs.filter((e) => e.woke).length;
    const expected = evs.reduce((t, e) => t + e.chance, 0);
    const pValue = tailProbability(evs.map((e) => e.chance), woke);
    const verdict =
      evs.length < MIN_EVENTS ? "unclear"
      : woke >= 2 && pValue < 0.05 ? "wakes"
      : woke <= Math.max(1, expected * 1.5) ? "doesnt"
      : "unclear";
    return [{ cause, events: evs.length, woke, expected, pValue, verdict }];
  });
}
