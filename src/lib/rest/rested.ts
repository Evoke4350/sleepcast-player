// The morning rating: one tap, "how rested do you feel?", and in time what
// goes with the rested mornings.
//
// A rating belongs to a sleep, not a night in the ledger: a 3am re-anchor
// makes one sleep two nights (see trends.ts), so it is kept on the first.
// It is asked only the morning after, for the sleep just gone: rested is
// how you feel now, and a rating from memory days later says little.
//
// What goes with it is a rank correlation (Spearman's) for each measure of
// the night, tested by shuffling the ratings. With several measures tested
// at once, one would pass by chance now and then, so a link is only called
// clear after Holm's correction across all of them.

import type { RestNight, Rested } from "./types";
import { believableOnsetMs, loadNights, saveNights } from "./ledger";
import { SAME_SLEEP_MS, minutesAfterNoon, sleepRecords } from "./trends";
import { ranks, seeded } from "./stats";

/** What each rating means, as the question offers it. */
export const RESTED_LABEL: Record<Rested, string> = {
  1: "Exhausted",
  2: "Tired",
  3: "Okay",
  4: "Rested",
  5: "Very rested",
};

/** Asked once the last night started this long ago: the sleep is over. */
const RATE_AFTER_MS = 3 * 60 * 60 * 1000;
/** And until the sleep started this long ago: the same morning. */
const RATE_WITHIN_MS = 20 * 60 * 60 * 1000;
/** Rated sleeps a measure needs before it is tested. */
export const MIN_RATED = 7;
const SIGNIFICANT = 0.05;
const SHUFFLES = 5000;

/** The ledger's nights as sleeps, oldest first: each group's first night
 *  is the one a rating is kept on. */
function sleeps(nights: readonly RestNight[]): RestNight[][] {
  const groups: RestNight[][] = [];
  for (const n of [...nights].sort((a, b) => a.startedAt - b.startedAt)) {
    const g = groups[groups.length - 1];
    if (g && n.startedAt - g[0].startedAt < SAME_SLEEP_MS) g.push(n);
    else groups.push([n]);
  }
  return groups;
}

/** The night to ask about this morning (the first of the last sleep), or
 *  null when it isn't morning-after for any. */
export function nightToRate(nights: readonly RestNight[], now: number): RestNight | null {
  const g = sleeps(nights).at(-1);
  if (!g) return null;
  if (now - g[g.length - 1].startedAt < RATE_AFTER_MS) return null;
  if (now - g[0].startedAt > RATE_WITHIN_MS) return null;
  return g[0];
}

export function rateNight(startedAt: number, rested: Rested): void {
  const nights = loadNights();
  const i = nights.findIndex((n) => n.startedAt === startedAt);
  if (i === -1) return;
  nights[i] = { ...nights[i], rested };
  saveNights(nights);
}

export type Measure = "asleep" | "deep" | "rem" | "awake" | "wakings" | "toSleep" | "bedtime" | "played";
const MEASURES: Measure[] = ["asleep", "deep", "rem", "awake", "wakings", "toSleep", "bedtime", "played"];

export interface RestedLink {
  measure: Measure;
  /** Rated sleeps that had this measure. */
  n: number;
  /** -1 to 1: positive, more of it went with more rested mornings. */
  rho: number;
  pValue: number;
  /** Clear after Holm's correction across every measure tested. */
  clear: boolean;
}

export interface RestedSummary {
  rated: number;
  average: number;
  /** Measures with MIN_RATED rated sleeps or more, clear ones first, then
   *  by strength. */
  links: RestedLink[];
}

/** Each rated sleep's measures; null where that night didn't have one. */
function rows(nights: readonly RestNight[]): { rested: number; m: Record<Measure, number | null> }[] {
  const watch = new Map(sleepRecords(nights).map((r) => [r.startedAt, r]));
  return sleeps(nights).flatMap((g) => {
    const first = g[0];
    if (!first.rested) return [];
    const w = watch.get(first.startedAt);
    // A watch that doesn't tell stages apart has no Deep or REM, not none.
    const staged = !!w && w.stretches.some((s) => s.stage === "deep" || s.stage === "rem" || s.stage === "core");
    const played = g.flatMap((n) => (n.playedMs === undefined ? [] : [n.playedMs]));
    return [{
      rested: first.rested,
      m: {
        asleep: w ? w.asleepMs : null,
        deep: staged ? w!.deepMs : null,
        rem: staged ? w!.remMs : null,
        awake: w ? w.awakeMs : null,
        wakings: w ? w.wakings : null,
        toSleep: w ? w.toSleepMs : believableOnsetMs(first),
        bedtime: minutesAfterNoon(first.startedAt),
        played: played.length ? played.reduce((a, b) => a + b, 0) : null,
      },
    }];
  });
}

function pearson(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** Spearman's rho, and a two-sided p-value from shuffling y: how often a
 *  random pairing is at least as strong. NaN rho when either side never
 *  varies. */
export function spearman(x: readonly number[], y: readonly number[], rand = seeded(1)): { rho: number; pValue: number } {
  const rx = ranks(x);
  const ry = ranks(y);
  const rho = pearson(rx, ry);
  if (Number.isNaN(rho)) return { rho, pValue: 1 };
  const observed = Math.abs(rho) - 1e-9;
  const shuffled = [...ry];
  let extreme = 0;
  for (let s = 0; s < SHUFFLES; s++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (Math.abs(pearson(rx, shuffled)) >= observed) extreme++;
  }
  return { rho, pValue: (extreme + 1) / (SHUFFLES + 1) };
}

export function restedSummary(nights: readonly RestNight[]): RestedSummary | null {
  const rs = rows(nights);
  if (!rs.length) return null;
  const tested: RestedLink[] = [];
  for (const measure of MEASURES) {
    const pairs = rs.filter((r) => r.m[measure] !== null);
    if (pairs.length < MIN_RATED) continue;
    const { rho, pValue } = spearman(pairs.map((r) => r.m[measure]!), pairs.map((r) => r.rested));
    if (Number.isNaN(rho)) continue;
    tested.push({ measure, n: pairs.length, rho, pValue, clear: false });
  }
  // Holm: the smallest p against 0.05/m, the next against 0.05/(m-1), and
  // so on, stopping at the first that fails.
  const byP = [...tested].sort((a, b) => a.pValue - b.pValue);
  for (let i = 0; i < byP.length; i++) {
    if (byP[i].pValue >= SIGNIFICANT / (byP.length - i)) break;
    byP[i].clear = true;
  }
  return {
    rated: rs.length,
    average: rs.reduce((a, r) => a + r.rested, 0) / rs.length,
    links: tested.sort((a, b) => Number(b.clear) - Number(a.clear) || Math.abs(b.rho) - Math.abs(a.rho)),
  };
}
