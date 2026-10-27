// Experiments: two shows, or two timer lengths, on random nights, and which
// put you to sleep faster.
//
// The by-show figures elsewhere are a rough guide because shows get
// different nights: a tired night, a late one, a weekend. Here each ordinary
// night (the moon) is given one side at random, the two kept even, so the
// nights fall evenly and a difference is down to the shows (or timers).
//
// The result is time to fall asleep from pressing play: the watch's when it
// timed the night (a night it saw no sleep in counts as slowest), else
// Sleepcast's own guess; a night with neither is left out. It is only given
// once both sides reach the nights asked for: looking early and stopping on
// a lucky streak is how chance passes for a result. The test is a rank-sum
// (Mann-Whitney) test, exact by permutation.
//
// Nights are matched to the experiment by when they started, so nothing on
// the night's own record changes (see nightOf).

import type { RestNight } from "./types";
import { believableOnsetMs, median } from "./ledger";
import { writeMakingRoom } from "../store";

export type Arm = { kind: "show"; feedId: string } | { kind: "timer"; minutes: number };
export type Side = 0 | 1;

export interface Experiment {
  id: string;
  startedAt: number;
  arms: [Arm, Arm];
  /** Nights each side needs before there's a result. */
  perArm: number;
  /** Each night given a side: when, and which. */
  assignments: { at: number; side: Side }[];
  /** The side the next night gets, decided ahead so the Sleep screen can say. */
  next: Side;
  endedAt?: number;
}

interface Saved {
  current: Experiment | null;
  past: Experiment[];
}

const KEY = "sleepcast2.experiment";
const PAST_KEPT = 10;
/** A night started this soon after its assignment is that night. */
const MATCH_MS = 2 * 60 * 1000;

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as Saved) : null;
    return s && typeof s === "object" ? { current: s.current ?? null, past: Array.isArray(s.past) ? s.past : [] } : { current: null, past: [] };
  } catch {
    return { current: null, past: [] };
  }
}

function save(s: Saved): void {
  try {
    writeMakingRoom(KEY, JSON.stringify({ current: s.current, past: s.past.slice(-PAST_KEPT) }));
  } catch {
    /* quota / private mode */
  }
}

export function currentExperiment(): Experiment | null {
  return load().current;
}

export function pastExperiments(): Experiment[] {
  return load().past;
}

const coin = (rand: () => number): Side => (rand() < 0.5 ? 0 : 1);

export function startExperiment(arms: [Arm, Arm], perArm: number, now = Date.now(), rand = Math.random): Experiment {
  const e: Experiment = { id: `x-${now}`, startedAt: now, arms, perArm, assignments: [], next: coin(rand) };
  const s = load();
  // One at a time: a running one is ended, kept with the past ones.
  save({ current: e, past: withEnded(s, now) });
  return e;
}

export function endExperiment(now = Date.now()): void {
  const s = load();
  if (!s.current) return;
  save({ current: null, past: withEnded(s, now) });
}

/** The past ones, with the running one ended, unless it never had a night. */
function withEnded(s: Saved, now: number): Experiment[] {
  return s.current?.assignments.length ? [...s.past, { ...s.current, endedAt: now }] : s.past;
}

/** Ask for more nights each, after a result that wasn't clear. */
export function extendExperiment(more: number): void {
  const s = load();
  if (!s.current) return;
  save({ ...s, current: { ...s.current, perArm: s.current.perArm + more } });
}

/** Give tonight its side, and decide the next: whichever side has had fewer
 *  nights, a coin toss when even. Returns tonight's arm. */
export function assignTonight(now = Date.now(), rand = Math.random): Arm | null {
  const s = load();
  const e = s.current;
  if (!e) return null;
  const side = e.next;
  const assignments = [...e.assignments, { at: now, side }];
  const count = (k: Side) => assignments.filter((a) => a.side === k).length;
  const next: Side = count(0) === count(1) ? coin(rand) : count(0) < count(1) ? 0 : 1;
  save({ ...s, current: { ...e, assignments, next } });
  return e.arms[side];
}

/** The night that began with an assignment, if one did. */
export function nightOf(at: number, nights: readonly RestNight[]): RestNight | undefined {
  return nights.find((n) => n.startedAt >= at - 5000 && n.startedAt <= at + MATCH_MS);
}

/** Time to fall asleep: the watch's, else Sleepcast's guess; Infinity when
 *  the watch saw no sleep; null when nothing timed it. */
export function outcomeMs(n: RestNight): number | null {
  if (n.detector === "hr") return n.watchSleptAfterMs ?? Infinity;
  return believableOnsetMs(n);
}

export interface SideResult {
  /** Nights played on this side, and the ones that were timed. */
  nights: number;
  times: number[];
  medianMs: number | null;
}

export interface ExperimentResult {
  sides: [SideResult, SideResult];
  /** Both sides have their nights timed. */
  done: boolean;
  /** Two-sided; null until done. */
  pValue: number | null;
  /** The faster side, when the difference is unlikely to be chance. */
  winner: Side | null;
}

export const SIGNIFICANT = 0.05;

export function experimentResult(e: Experiment, nights: readonly RestNight[]): ExperimentResult {
  const sides = ([0, 1] as const).map((k) => {
    const played = e.assignments.filter((a) => a.side === k).map((a) => nightOf(a.at, nights)).filter((n): n is RestNight => !!n);
    const times = played.map(outcomeMs).filter((t): t is number => t !== null);
    return { nights: played.length, times, medianMs: median(times) };
  }) as [SideResult, SideResult];
  const done = sides.every((s) => s.times.length >= e.perArm);
  if (!done) return { sides, done, pValue: null, winner: null };
  const pValue = rankSumPValue(sides[0].times, sides[1].times);
  // Faster by mean rank, the measure the test itself compares.
  const r = ranks([...sides[0].times, ...sides[1].times]);
  const k = sides[0].times.length;
  const meanRank0 = r.slice(0, k).reduce((a, x) => a + x, 0) / k;
  const meanRank1 = r.slice(k).reduce((a, x) => a + x, 0) / (r.length - k);
  const winner = pValue < SIGNIFICANT ? (meanRank0 < meanRank1 ? 0 : 1) : null;
  return { sides, done, pValue, winner };
}

/** Midranks of all values together (ties share their average rank). */
function ranks(all: readonly number[]): number[] {
  const order = all.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(all.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

/** Above this many ways to split the nights, sample splits instead. */
const EXACT_LIMIT = 200_000;

/** Two-sided p-value of the rank-sum test: how often a random split of the
 *  same nights into the same two sizes is at least as lopsided. */
export function rankSumPValue(a: readonly number[], b: readonly number[], rand = seeded(1)): number {
  const r = ranks([...a, ...b]);
  const n = r.length;
  const k = a.length;
  const mean = (k * (n + 1)) / 2;
  const observed = Math.abs(r.slice(0, k).reduce((s, x) => s + x, 0) - mean) - 1e-9;
  let extreme = 0;
  let total = 0;
  if (choose(n, k) <= EXACT_LIMIT) {
    const walk = (start: number, left: number, sum: number) => {
      if (left === 0) {
        total++;
        if (Math.abs(sum - mean) >= observed) extreme++;
        return;
      }
      for (let i = start; i <= n - left; i++) walk(i + 1, left - 1, sum + r[i]);
    };
    walk(0, k, 0);
  } else {
    for (total = 0; total < 20_000; total++) {
      const idx = r.map((_, i) => i);
      for (let i = 0; i < k; i++) {
        const j = i + Math.floor(rand() * (n - i));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      const sum = idx.slice(0, k).reduce((s, i) => s + r[i], 0);
      if (Math.abs(sum - mean) >= observed) extreme++;
    }
  }
  return extreme / total;
}

function choose(n: number, k: number): number {
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c;
}

/** A repeatable random stream, so a result reads the same each visit. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
