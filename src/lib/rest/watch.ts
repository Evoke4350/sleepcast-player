// Sleep from the watch, matched to the nights.
//
// A web page can't read Apple Health, but a Shortcut on the phone can: it
// reads the night's Sleep Analysis samples and hands them over as text, in a
// link (#watch=…, after the #, so it never reaches the server) or on the
// clipboard. Each sample is "start|end|value", samples joined by ";":
//
//   2026-10-22T23:04:00-07:00|2026-10-22T23:31:30-07:00|Core;…
//
// The watch's onset replaces the detector's guess for the night it falls in,
// and the guess is kept (appSleptAtMs) so the two can be compared and the
// detector graded (calibrate.ts). The night's stages are kept too
// (watchSleep), for the Rest tab's chart of the night (NightChart).

import type { RestNight, SleepStage, SleepStretch } from "./types";
import { attributeOnset } from "./session";
import { loadNights, saveNights } from "./ledger";

export type SampleKind = "asleep" | "awake" | "inbed";
export interface SleepSample {
  start: number;
  end: number;
  kind: SampleKind;
  stage: SleepStage;
}

/** How long after a night starts the watch's onset still belongs to it. */
export const WATCH_WINDOW_MS = 4 * 60 * 60 * 1000;
/** An asleep sample starting this soon before the night still counts as
 *  falling asleep at its start (the watch's edges are approximate). */
const LEAD_MS = 5 * 60 * 1000;
/** How far past a night's start its stages are kept: to the morning. */
export const NIGHT_SPAN_MS = 14 * 60 * 60 * 1000;

/** Health's sleep values, as Shortcuts writes them: "In Bed", "Awake",
 *  "Asleep", "Core", "Deep", "REM", "Asleep (Unspecified)"… */
function stageOf(value: string): SleepStage {
  const v = value.toLowerCase().replace(/\s+/g, "");
  if (v.includes("awake")) return "awake";
  if (v.includes("inbed")) return "inbed";
  if (v.includes("deep")) return "deep";
  if (v.includes("rem")) return "rem";
  if (v.includes("core")) return "core";
  return "asleep";
}

function kindOf(stage: SleepStage): SampleKind {
  return stage === "awake" || stage === "inbed" ? stage : "asleep";
}

/** The samples in a Shortcut's text; whatever doesn't parse is skipped. */
export function parseWatchSamples(text: string): SleepSample[] {
  const out: SleepSample[] = [];
  for (const item of text.split(/[;\n]/)) {
    const [a, b, value = ""] = item.split("|").map((s) => s.trim());
    if (!a || !b) continue;
    const start = Date.parse(a);
    const end = Date.parse(b);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const stage = stageOf(value);
    out.push({ start, end, kind: kindOf(stage), stage });
  }
  return out.sort((x, y) => x.start - y.start);
}

/**
 * What the watch says about one night: undefined when it says nothing (no
 * asleep or awake samples in the window, or already asleep when the night
 * began); otherwise when you fell asleep, ms from night start, or null if it
 * saw no sleep within WATCH_WINDOW_MS.
 *
 * "In Bed" doesn't count as the watch having watched: the phone's bedtime
 * schedule writes it with no watch at all, and reading those nights as "no
 * sleep" would mark every one of them awake.
 */
export function watchOnsetMs(n: Pick<RestNight, "startedAt">, samples: readonly SleepSample[]): number | null | undefined {
  const from = n.startedAt;
  const to = from + WATCH_WINDOW_MS;
  const inWindow = samples.filter((s) => s.kind !== "inbed" && s.end > from && s.start < to);
  if (!inWindow.length) return undefined;
  const asleep = inWindow.filter((s) => s.kind === "asleep");
  if (asleep.some((s) => s.start < from - LEAD_MS)) return undefined;
  return asleep.length ? Math.max(0, asleep[0].start - from) : null;
}

/** Where overlapping samples disagree (Health holds every source's, and a
 *  phone's "Asleep" can sit under the watch's stages), the more specific
 *  one shows. */
const STAGE_RANK: Record<SleepStage, number> = { inbed: 0, asleep: 1, core: 2, rem: 3, deep: 4, awake: 5 };

/**
 * The night's stages from `samples`, ms from night start: clipped to the
 * night (its start to NIGHT_SPAN_MS on, or `until`, the next night's start),
 * overlaps settled by STAGE_RANK, neighbours of one stage joined. In Bed is
 * left out: it says nothing about sleep (see watchOnsetMs).
 */
export function nightStages(n: Pick<RestNight, "startedAt">, samples: readonly SleepSample[], until = Infinity): SleepStretch[] {
  const from = n.startedAt;
  const to = Math.min(from + NIGHT_SPAN_MS, until);
  const clipped = samples
    .filter((s) => s.stage !== "inbed" && s.end > from && s.start < to)
    .map((s) => ({ start: Math.max(s.start, from), end: Math.min(s.end, to), stage: s.stage }));
  const edges = [...new Set(clipped.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  const out: SleepStretch[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const [a, b] = [edges[i], edges[i + 1]];
    let stage: SleepStage | null = null;
    for (const s of clipped) {
      if (s.start <= a && s.end >= b && (stage === null || STAGE_RANK[s.stage] > STAGE_RANK[stage])) stage = s.stage;
    }
    if (stage === null) continue;
    // Whole seconds: the watch's edges are no finer, and the ledger holds 90 nights.
    const stretch = { from: Math.round((a - from) / 1000) * 1000, to: Math.round((b - from) / 1000) * 1000, stage };
    const prev = out[out.length - 1];
    if (prev && prev.stage === stage && prev.to === stretch.from) prev.to = stretch.to;
    else if (stretch.to > stretch.from) out.push(stretch);
  }
  return out;
}

/** A night with the watch's onset in place of the detector's, and its
 *  stages when there are any. Idempotent: the detector's own guess is taken
 *  only the first time, and the stages are replaced, not added to. */
export function withWatchOnset(n: RestNight, onset: number | null, stages: SleepStretch[] = []): RestNight {
  const appSleptAtMs = n.detector === "hr" ? (n.appSleptAtMs ?? null) : n.sleptAtMs;
  // While the night played: after it, the audio didn't put you to sleep.
  const played = n.playedMs ?? (n.timerMinutes > 0 ? n.timerMinutes * 60_000 : WATCH_WINDOW_MS);
  const slept = onset !== null && onset <= played ? onset : null;
  const { onsetFeedId, onsetEpisodeId, onsetAfterMs, sleptThrough, watchSleep, ...rest } = n;
  // Credit what was playing at the watch's onset. A night from before the
  // episode starts were kept can only keep the detector's credit, and only
  // while there is still an onset to credit.
  const credit = n.episodes
    ? attributeOnset(n.episodes, slept)
    : slept !== null
      ? { onsetFeedId, onsetEpisodeId, onsetAfterMs, sleptThrough }
      : {};
  const kept = Object.fromEntries(Object.entries(credit).filter(([, v]) => v !== undefined));
  return {
    ...rest,
    ...kept,
    sleptAtMs: slept,
    timeToSleepMs: slept,
    detector: "hr",
    watchSleptAfterMs: onset,
    appSleptAtMs,
    ...(stages.length ? { watchSleep: stages } : {}),
  };
}

export interface WatchMatch {
  startedAt: number;
  watchSleptAfterMs: number | null;
  sleptAtMs: number | null;
  appSleptAtMs: number | null;
  playedMs: number | null;
}

/** Match samples to nights; returns the new ledger and the nights changed. */
export function applyWatchSamples(
  nights: readonly RestNight[],
  samples: readonly SleepSample[],
): { nights: RestNight[]; matched: WatchMatch[] } {
  const matched: WatchMatch[] = [];
  const next = nights.map((n, i) => {
    const onset = watchOnsetMs(n, samples);
    if (onset === undefined) return n;
    // A 3am re-anchor is a night of its own: the one before stops where it starts.
    const m = withWatchOnset(n, onset, nightStages(n, samples, nights[i + 1]?.startedAt));
    matched.push({
      startedAt: m.startedAt,
      watchSleptAfterMs: onset,
      sleptAtMs: m.sleptAtMs,
      appSleptAtMs: m.appSleptAtMs ?? null,
      playedMs: m.playedMs ?? null,
    });
    return m;
  });
  return { nights: next, matched };
}

export type WatchImport =
  | { ok: true; matched: WatchMatch[] }
  | { ok: false; error: string };

/** Read a Shortcut's text and write what matched into the ledger. */
export function importWatchSleep(text: string): WatchImport {
  const samples = parseWatchSamples(text);
  if (!samples.length) {
    return { ok: false, error: "No sleep data came through. Check the Shortcut finds Sleep Analysis samples, then run it again." };
  }
  const { nights, matched } = applyWatchSamples(loadNights(), samples);
  if (matched.length) saveNights(nights);
  return { ok: true, matched };
}

/** The #watch=… payload in a URL hash, or null. */
export function watchPayloadFromHash(hash: string): string | null {
  const m = /^#watch=(.*)$/s.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** One line on what an import did, for the screen it lands on. `brief`:
 *  only the count, where the night itself is shown beside it (Rest). */
export function describeImport(r: WatchImport, { brief = false }: { brief?: boolean } = {}): string {
  if (!r.ok) return r.error;
  if (!r.matched.length) {
    return "Your watch's sleep came through, but none of it overlaps a night in Sleepcast. Nights you play here get matched the next morning.";
  }
  const last = r.matched[r.matched.length - 1];
  const n = r.matched.length;
  const head = n === 1 ? "Matched your watch's sleep to 1 night." : `Matched your watch's sleep to ${n} nights.`;
  return brief ? head : `${head} ${describeWatchNight(last)}`;
}

const min = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

/** What the watch said about a night, against Sleepcast's guess. */
export function describeWatchNight(m: Pick<WatchMatch, "watchSleptAfterMs" | "sleptAtMs" | "appSleptAtMs" | "playedMs">): string {
  const guess = m.appSleptAtMs === null ? "Sleepcast didn't call it." : `Sleepcast guessed ${min(m.appSleptAtMs)}.`;
  if (m.watchSleptAfterMs === null) return `Your watch saw no sleep in the 4 hours after you pressed play. ${guess}`;
  if (m.sleptAtMs === null) {
    return `Your watch has you asleep ${min(m.watchSleptAfterMs)} in, after the audio stopped${m.playedMs ? ` at ${min(m.playedMs)}` : ""}. ${guess}`;
  }
  return `Your watch has you asleep ${min(m.watchSleptAfterMs)} in. ${guess}`;
}

export interface WatchSummary {
  /** Asleep, every stage together. */
  asleepMs: number;
  byStage: Partial<Record<SleepStage, number>>;
  /** The first asleep stretch's start and the last one's end, ms from night start. */
  fellAsleepMs: number;
  wokeMs: number;
  /** Awake between falling asleep and waking: how long, and how many times. */
  awakeMs: number;
  wakings: number;
  /** Whether the watch told the stages apart (Core, Deep, REM), or only
   *  asleep from awake, as older watches do. */
  staged: boolean;
}

/** The figures for a night's stages; null with no sleep in them. */
export function summarizeStages(stretches: readonly SleepStretch[]): WatchSummary | null {
  const asleep = stretches.filter((s) => s.stage !== "awake");
  if (!asleep.length) return null;
  const fellAsleepMs = asleep[0].from;
  const wokeMs = asleep[asleep.length - 1].to;
  const byStage: Partial<Record<SleepStage, number>> = {};
  let awakeMs = 0;
  let wakings = 0;
  for (const s of stretches) {
    const len = s.to - s.from;
    if (s.stage === "awake") {
      if (s.from >= fellAsleepMs && s.to <= wokeMs) {
        awakeMs += len;
        wakings++;
      }
      continue;
    }
    byStage[s.stage] = (byStage[s.stage] ?? 0) + len;
  }
  return {
    asleepMs: asleep.reduce((t, s) => t + s.to - s.from, 0),
    byStage,
    fellAsleepMs,
    wokeMs,
    awakeMs,
    wakings,
    staged: asleep.some((s) => s.stage === "core" || s.stage === "deep" || s.stage === "rem"),
  };
}
