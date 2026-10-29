// Nights over time, from the watch: when you went to bed, fell asleep and
// woke, how long you slept, and how that went with what was playing.
//
// One sleep can be two nights in the ledger: a 3am re-anchor starts a night
// of its own, and nightStages stops the first where the second starts. Here
// they are one sleep again, so a re-anchored night isn't counted as a short
// one.

import type { RestNight, SleepStretch } from "./types";
import { summarizeStages } from "./watch";
import { median } from "./ledger";

/** A night that starts this soon after the one before is the same sleep. */
export const SAME_SLEEP_MS = 10 * 60 * 60 * 1000;

export interface SleepRecord {
  /** When you pressed play. */
  startedAt: number;
  fellAsleepAt: number;
  wokeAt: number;
  asleepMs: number;
  awakeMs: number;
  wakings: number;
  deepMs: number;
  remMs: number;
  /** From pressing play to the watch's onset; null when it saw none in its window. */
  toSleepMs: number | null;
  /** What was playing when you fell asleep, if the audio was still on. */
  onsetFeedId?: string;
  /** When Sleepcast played, from night start (the first night of the sleep). */
  playedMs: number;
  stretches: SleepStretch[];
}

/** One record per sleep the watch saw, oldest first. */
export function sleepRecords(nights: readonly RestNight[]): SleepRecord[] {
  const watched = nights.filter((n) => n.watchSleep?.length).sort((a, b) => a.startedAt - b.startedAt);
  const groups: RestNight[][] = [];
  for (const n of watched) {
    const g = groups[groups.length - 1];
    if (g && n.startedAt - g[0].startedAt < SAME_SLEEP_MS) g.push(n);
    else groups.push([n]);
  }
  const out: SleepRecord[] = [];
  for (const g of groups) {
    const first = g[0];
    // Every night's stretches on the first night's clock.
    const stretches = g.flatMap((n) => n.watchSleep!.map((s) => ({ ...s, from: s.from + n.startedAt - first.startedAt, to: s.to + n.startedAt - first.startedAt })));
    const sum = summarizeStages(stretches);
    if (!sum) continue;
    out.push({
      startedAt: first.startedAt,
      fellAsleepAt: first.startedAt + sum.fellAsleepMs,
      wokeAt: first.startedAt + sum.wokeMs,
      asleepMs: sum.asleepMs,
      awakeMs: sum.awakeMs,
      wakings: sum.wakings,
      deepMs: sum.byStage.deep ?? 0,
      remMs: sum.byStage.rem ?? 0,
      toSleepMs: first.watchSleptAfterMs ?? null,
      ...(first.onsetFeedId ? { onsetFeedId: first.onsetFeedId } : {}),
      playedMs: first.playedMs ?? 0,
      stretches,
    });
  }
  return out;
}

/** Minutes after noon, local time: a clock that doesn't break at midnight,
 *  so 11pm (660) and 1am (780) average to midnight, not to noon. */
export function minutesAfterNoon(ms: number): number {
  const d = new Date(ms);
  return (((d.getHours() - 12 + 24) % 24) * 60) + d.getMinutes();
}

export interface Typical {
  nights: number;
  /** Medians; clock times in minutesAfterNoon. */
  bedtime: number;
  fellAsleep: number;
  woke: number;
  toSleepMs: number | null;
  asleepMs: number;
}

export function typical(records: readonly SleepRecord[]): Typical | null {
  if (!records.length) return null;
  return {
    nights: records.length,
    bedtime: median(records.map((r) => minutesAfterNoon(r.startedAt)))!,
    fellAsleep: median(records.map((r) => minutesAfterNoon(r.fellAsleepAt)))!,
    woke: median(records.map((r) => minutesAfterNoon(r.wokeAt)))!,
    toSleepMs: median(records.flatMap((r) => (r.toSleepMs === null ? [] : [r.toSleepMs]))),
    asleepMs: median(records.map((r) => r.asleepMs))!,
  };
}

export interface ShowTrend {
  feedId: string;
  nights: number;
  toSleepMs: number;
  asleepMs: number;
}

/** By the show you fell asleep to: only shows with `min` sleeps or more,
 *  quickest to sleep first. */
export function byShow(records: readonly SleepRecord[], min = 2): ShowTrend[] {
  const groups = new Map<string, SleepRecord[]>();
  for (const r of records) {
    if (!r.onsetFeedId || r.toSleepMs === null) continue;
    groups.set(r.onsetFeedId, [...(groups.get(r.onsetFeedId) ?? []), r]);
  }
  return [...groups]
    .filter(([, rs]) => rs.length >= min)
    .map(([feedId, rs]) => ({
      feedId,
      nights: rs.length,
      toSleepMs: median(rs.map((r) => r.toSleepMs!))!,
      asleepMs: median(rs.map((r) => r.asleepMs))!,
    }))
    .sort((a, b) => a.toSleepMs - b.toSleepMs);
}
