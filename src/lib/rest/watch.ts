// Apple Watch sleep onsets, brought in by an iOS Shortcut.
//
// The Shortcut reads the night's Sleep Analysis samples from Health and opens
// sleepcast.pro/#watch=<samples>. The fragment never reaches the server, so the
// samples go from Health to this browser's storage and nowhere else. Each
// sample is one line, "start~end~stage", with ISO 8601 dates and the stage as
// Health names it (Core, Deep, REM, Awake, In Bed, ...).
//
// A night's onset is the first asleep sample that begins inside it. That
// replaces the detector's guess (kept as inferredAtMs, to compare) and
// re-attributes the night from its timeline, as RestSession.finish attributes
// the detector's onset.
import type { RestNight } from "./types";
import { attribution } from "./session";
import { updateNights } from "./ledger";
import { fmtOnsetMinutes } from "./sleepscore";

export interface SleepSample {
  start: number;
  asleep: boolean;
}

/** The fragment key the Shortcut writes: #watch=... */
export const WATCH_HASH = "#watch=";

/** How long after a night's start the watch onset may come and still be
 *  that night's: past it, the sleep belongs to no night sleepcast played. */
export const MATCH_WINDOW_MS = 4 * 60 * 60 * 1000;

/** A payload has at most this many lines read (a week of a busy night's
 *  samples is a few hundred): the fragment is anyone's to write. */
export const MAX_SAMPLES = 2000;

/** Health's sleep stage codes (HKCategoryValueSleepAnalysis), for a
 *  Shortcut that hands the value over as a number: in bed 0, asleep
 *  (unspecified) 1, awake 2, core 3, deep 4, REM 5. */
const STAGE_CODES: Record<string, boolean> = { "0": false, "1": true, "2": false, "3": true, "4": true, "5": true };

/** Whether a stage is sleep: by Health's code, or by its English name.
 *  "Asleep" (unspecified, from older watches) counts; Awake and In Bed don't.
 *  Anything else is unrecognised, rather than guessed at: a localised
 *  "In Bed" read as sleep would be a confident wrong onset. */
function stageAsleep(stage: string): boolean | null {
  const s = stage.trim().toLowerCase();
  if (s in STAGE_CODES) return STAGE_CODES[s];
  if (/awake|in ?bed/.test(s)) return false;
  if (/core|deep|rem|asleep|unspecified/.test(s)) return true;
  return null;
}

/** The samples in a Shortcut's payload, and how many lines named a stage
 *  this doesn't recognise. Malformed lines (no time of day, unparseable
 *  dates) are skipped. */
export function parseWatchPayload(text: string): { samples: SleepSample[]; unrecognised: number } {
  const samples: SleepSample[] = [];
  let unrecognised = 0;
  for (const line of text.split(/\r?\n/).slice(0, MAX_SAMPLES)) {
    const [startText, , stage] = line.split("~");
    if (!startText || stage === undefined) continue;
    // A date with no time of day parses as midnight UTC: no onset at all.
    if (!startText.includes("T")) continue;
    const start = Date.parse(startText.trim());
    if (!Number.isFinite(start)) continue;
    const asleep = stageAsleep(stage);
    if (asleep === null) {
      unrecognised++;
      continue;
    }
    samples.push({ start, asleep });
  }
  return { samples, unrecognised };
}

/** The watch's onset for a night, from its start (ms), or null: the first
 *  asleep sample beginning at or after the start, before MATCH_WINDOW_MS
 *  and before the next night's start (a 3am re-anchor is its own night). */
export function watchOnset(
  startedAt: number,
  samples: readonly SleepSample[],
  nextStartedAt = Infinity,
): number | null {
  const limit = Math.min(startedAt + MATCH_WINDOW_MS, nextStartedAt);
  let first: number | null = null;
  for (const s of samples) {
    if (!s.asleep || s.start < startedAt || s.start >= limit) continue;
    if (first === null || s.start < first) first = s.start;
  }
  return first === null ? null : first - startedAt;
}

/** A night re-timed by the watch's onset \`atMs\`. Attribution comes from the
 *  night's timeline when it still has one; an onset after the night ended
 *  credits nothing (the audio had stopped). Without a timeline the
 *  detector's attribution (for a different onset) is dropped, unless the
 *  night was already watch-timed, when it is still this onset's. A "slept"
 *  or "awake" label was on the detector's claim, which the watch replaces. */
export function retimed(n: RestNight, atMs: number): RestNight {
  const inferredAtMs = n.detector === "watch" ? (n.inferredAtMs ?? null) : n.sleptAtMs;
  const {
    onsetFeedId: _f,
    onsetEpisodeId: _e,
    onsetAfterMs: _a,
    sleptThrough: _s,
    selfLabel: _l,
    ...base
  } = n;
  const afterEnd = n.endedAt !== undefined && n.startedAt + atMs > n.endedAt;
  const credited = afterEnd
    ? {}
    : n.timeline
      ? attribution(n.timeline, atMs)
      : n.detector === "watch"
        ? {
            ...(n.onsetFeedId !== undefined ? { onsetFeedId: n.onsetFeedId } : {}),
            ...(n.onsetEpisodeId !== undefined ? { onsetEpisodeId: n.onsetEpisodeId } : {}),
            ...(n.onsetAfterMs !== undefined ? { onsetAfterMs: n.onsetAfterMs } : {}),
            ...(n.sleptThrough !== undefined ? { sleptThrough: n.sleptThrough } : {}),
          }
        : {};
  return {
    ...base,
    sleptAtMs: atMs,
    timeToSleepMs: atMs,
    detector: "watch",
    inferredAtMs,
    ...credited,
  };
}

export interface WatchTiming {
  startedAt: number;
  atMs: number;
  inferredAtMs: number | null;
}

/** Every night the samples time, re-timed; the rest as they were, in the
 *  same order. */
export function applyWatch(
  nights: readonly RestNight[],
  samples: readonly SleepSample[],
): { nights: RestNight[]; timed: WatchTiming[] } {
  const starts = nights.map((n) => n.startedAt).sort((a, b) => a - b);
  const nextAfter = (t: number) => starts.find((s) => s > t) ?? Infinity;
  const timed: WatchTiming[] = [];
  const out = nights.map((n) => {
    const at = watchOnset(n.startedAt, samples, nextAfter(n.startedAt));
    if (at === null) return n;
    const r = retimed(n, at);
    timed.push({ startedAt: n.startedAt, atMs: at, inferredAtMs: r.inferredAtMs ?? null });
    return r;
  });
  return { nights: out, timed: timed.sort((a, b) => a.startedAt - b.startedAt) };
}

export interface WatchImport {
  timed: WatchTiming[];
  samples: number;
  unrecognised: number;
}

/** A pasted payload: the lines themselves, or a whole #watch= link. */
export function payloadFromPaste(text: string): string {
  const i = text.indexOf(WATCH_HASH);
  return i >= 0 ? (watchPayloadFromHash(text.slice(i).trim()) ?? "") : text.trim();
}

/** Reads a payload into the rest ledger. */
export function importWatch(text: string): WatchImport {
  const { samples, unrecognised } = parseWatchPayload(text);
  let timed: WatchTiming[] = [];
  if (samples.length) {
    updateNights((nights) => {
      const r = applyWatch(nights, samples);
      timed = r.timed;
      return r.nights;
    });
  }
  return { timed, samples: samples.length, unrecognised };
}

/** The payload in a location hash, or null when it isn't a watch import. */
export function watchPayloadFromHash(hash: string): string | null {
  if (!hash.startsWith(WATCH_HASH)) return null;
  try {
    return decodeURIComponent(hash.slice(WATCH_HASH.length));
  } catch {
    return null;
  }
}

/** What an import did, in a line for the listener. */
export function watchNotice(r: WatchImport): string {
  if (!r.samples) {
    return r.unrecognised
      ? "your watch's sleep stages came in a language sleepcast can't read yet (english only)."
      : "nothing from your watch to read: is sleep tracking on?";
  }
  if (!r.timed.length) return "your watch's sleep didn't start inside a sleepcast night.";
  const last = r.timed[r.timed.length - 1];
  const guess = last.inferredAtMs === null ? "" : `; sleepcast guessed ${fmtOnsetMinutes(last.inferredAtMs)}`;
  const lead = r.timed.length === 1 ? "your watch" : `your watch timed ${r.timed.length} nights. the latest`;
  return `${lead}: asleep ${fmtOnsetMinutes(last.atMs)} in${guess}.`;
}

/** How the detector's guesses compare with the watch: nights the watch
 *  timed, how many of those the detector had also timed, and the median gap
 *  between the two (rounded to the second), or null with none to compare. */
export function watchAgreement(nights: readonly RestNight[]): {
  watchNights: number;
  compared: number;
  medianOffMs: number | null;
} {
  const watched = nights.filter((n) => n.detector === "watch" && n.sleptAtMs !== null);
  const gaps = watched
    .filter((n) => n.inferredAtMs !== undefined && n.inferredAtMs !== null)
    .map((n) => Math.abs((n.inferredAtMs as number) - (n.sleptAtMs as number)))
    .sort((a, b) => a - b);
  const m = Math.floor(gaps.length / 2);
  const median = !gaps.length ? null : gaps.length % 2 ? gaps[m] : (gaps[m - 1] + gaps[m]) / 2;
  return {
    watchNights: watched.length,
    compared: gaps.length,
    medianOffMs: median === null ? null : Math.round(median / 1000) * 1000,
  };
}
