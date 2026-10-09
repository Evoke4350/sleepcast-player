import type { RestNight, RestRollup, DetectorParams } from "./types";
import { retimed } from "./attribution";
import { median } from "./stats";
import { writeMakingRoom } from "../store";
import { DEFAULT_PARAMS, LAMBDA_MAX, TICK_MS, quietTicksToDecide } from "./detector";

const KEY = "sleepcast2.rest";
const MAX_NIGHTS = 90;

/** The newest `n` nights by start, oldest first: the one ordering rollup,
 *  step-back, the cap and lastOf all share (the ledger is in recording
 *  order, which an upsert in place or a clock stepped back can make differ;
 *  two that started together keep their recording order). */
export function newestByStart(nights: readonly RestNight[], n: number): RestNight[] {
  if (n <= 0) return []; // (slice(-0) would be every night)
  return [...nights].sort((a, b) => a.startedAt - b.startedAt).slice(-n);
}

/** The newest night by start (the later-recorded of two that started
 *  together), or null. */
export function lastOf(nights: readonly RestNight[]): RestNight | null {
  // One pass (a render's worth of calls): the same order as newestByStart.
  let newest: RestNight | null = null;
  for (const n of nights) if (!newest || n.startedAt >= newest.startedAt) newest = n;
  return newest;
}

/** Whether a stored entry has the shape the readers rely on: a start, the
 *  onset fields (a number or null), a touch count, and its lists (timeline,
 *  sleptThrough, skipped) as lists when there. */
function isNight(x: unknown): x is RestNight {
  if (!x || typeof x !== "object") return false;
  const n = x as Record<string, unknown>;
  const numOrNull = (v: unknown) => v === null || typeof v === "number";
  const arrayOrAbsent = (v: unknown) => v === undefined || Array.isArray(v);
  return (
    typeof n.startedAt === "number" &&
    numOrNull(n.sleptAtMs) &&
    numOrNull(n.timeToSleepMs) &&
    typeof n.interactions === "number" &&
    arrayOrAbsent(n.timeline) &&
    arrayOrAbsent(n.sleptThrough) &&
    arrayOrAbsent(n.skipped)
  );
}

export function loadNights(): RestNight[] {
  let arr: unknown;
  try {
    const raw = localStorage.getItem(KEY);
    arr = raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  // A ledger from before could hold a night twice: read as one, so every
  // reader (counts, scores, the step-back, the watch import) agrees. An
  // entry that isn't a night is passed over, not allowed to blank the rest
  // (which the next save would then overwrite).
  return collapsed(arr.filter(isNight));
}

/** Stores the nights, the newest MAX_NIGHTS of them, and returns what it
 *  stored; null when it couldn't (quota, private mode: a lost stat is not
 *  worth throwing over, but a caller reporting a change needs to know). */
export function saveNights(nights: RestNight[]): RestNight[] | null {
  // Over the cap, the oldest by start go, not the first recorded: a killed
  // night recorded late sits last but may be older than what it displaces.
  const kept = nights.length > MAX_NIGHTS ? newestByStart(nights, MAX_NIGHTS) : nights;
  try {
    return writeMakingRoom(KEY, JSON.stringify(kept)) ? kept : null;
  } catch {
    return null;
  }
}

/** How long a night keeps its timeline: long enough for a watch import a
 *  few mornings late to still attribute it, short enough that 90 nights of
 *  episode ids don't crowd local storage. */
export const TIMELINE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Records a night; whether the save took. A night older than every one
 *  the cap keeps is, like any night past the cap, not kept: recorded all the
 *  same (its snapshot then goes), as the ledger only ever holds the newest.
 *  `now` (for pruning timelines) is passed by every caller here, and
 *  defaults for the host app's calls, which leave it out. A night with the
 *  same start already there is the same night recorded twice, and this one
 *  replaces it: a watch import records a suspended tab's snapshot (it can't
 *  tell one from a killed tab's), and the tab may wake and record its night
 *  again, by ending it or by being reconciled. The night keeps the watch's
 *  time if it had one. */
export function appendNight(n: RestNight, now = Date.now()): boolean {
  return storeNights(withNight(loadNights(), n), now) !== null;
}

/** Stores a night set the way every night write does: timelines pruned
 *  against `now`, then saved (capped). The stored nights, or null. */
export function storeNights(nights: RestNight[], now: number): RestNight[] | null {
  return saveNights(pruneTimelines(nights, now));
}

/** `nights` with `n` added, or merged into the night with its start (see
 *  appendNight), for a caller that saves them itself. */
export function withNight(nights: readonly RestNight[], n: RestNight): RestNight[] {
  const i = nights.findIndex((x) => x.startedAt === n.startedAt);
  if (i === -1) return [...nights, n];
  const out = [...nights];
  out[i] = merge(out[i], n);
  return out;
}

/** A night recorded again (`n`, the later) merged with what was there: the
 *  later wins, keeping the watch's time from the earlier unless the later
 *  has a watch time of its own. */
function merge(earlier: RestNight, n: RestNight): RestNight {
  if (n.detector === "watch" || earlier.detector !== "watch" || earlier.sleptAtMs === null) return n;
  return keepWatch(n, earlier);
}

/** `n`, recorded again, keeping the watch's time from `watched`: re-timed
 *  as the watch import re-times (retimed), from `n`'s timeline or, where it
 *  has none (a killed snapshot's night), the watched copy's, so its credit
 *  is re-checked against `n`'s end; and the detector's guess from the
 *  watched copy where `n` has none. */
function keepWatch(n: RestNight, watched: RestNight): RestNight {
  const withTimeline = n.timeline || !watched.timeline ? n : { ...n, timeline: watched.timeline };
  const r = retimed(withTimeline, watched.sleptAtMs as number);
  return r.inferredAtMs === null && watched.inferredAtMs != null ? { ...r, inferredAtMs: watched.inferredAtMs } : r;
}

/** The nights with every night recorded more than once collapsed into one
 *  (merge), where its first copy was, in one pass. */
function collapsed(nights: readonly RestNight[]): RestNight[] {
  const out: RestNight[] = [];
  const at = new Map<number, number>();
  for (const n of nights) {
    const i = at.get(n.startedAt);
    if (i === undefined) {
      at.set(n.startedAt, out.length);
      out.push(n);
    } else out[i] = merge(out[i], n);
  }
  return out;
}

/** Drops the timeline of any night that began more than TIMELINE_KEEP_MS
 *  before `now`. */
export function pruneTimelines(nights: RestNight[], now: number): RestNight[] {
  return nights.map((n) => {
    if (!n.timeline || now - n.startedAt <= TIMELINE_KEEP_MS) return n;
    const { timeline: _drop, ...rest } = n;
    return rest;
  });
}

/** Labels a night, and returns it; null when there is none, or when it is
 *  watch-timed (measured, so there is nothing to confirm: a screen still
 *  showing the offer from before an import, in another tab, mustn't label
 *  it, nor tighten the detector for a call it didn't make). */
export function setSelfLabel(startedAt: number, label: "slept" | "awake"): RestNight | null {
  const nights = loadNights();
  // (loadNights reads any copies of a night as one.)
  const i = nights.findIndex((n) => n.startedAt === startedAt);
  if (i === -1 || nights[i].detector === "watch") return null;
  nights[i] = { ...nights[i], selfLabel: label };
  // A label that didn't store (storage full) didn't take: callers count and
  // act on it only when it did.
  return saveNights(nights) ? nights[i] : null;
}

/** Whether to ask if the listener really slept on a night: it claims an
 *  onset nobody has confirmed or denied, and the onset was the detector's
 *  guess. A watch-timed night was measured, so there is nothing to confirm
 *  (and an "awake" would tighten the detector for a call it didn't make). */
export function offerForLabel(n: RestNight): boolean {
  return n.sleptAtMs !== null && n.selfLabel === undefined && n.detector !== "watch";
}

/** Floor on a believable onset: the fastest the detector can reach its
 *  decision bound at the most sensitive calibration (LAMBDA_MAX), counted from
 *  a first tick at t=0. It used to be 7 min, which assumed the default rate
 *  (~30 ticks) and so hid real fast nights of listeners calibrated higher.
 *  Pre-fix artifacts (onset at the first quiet tick, "1 minute") still fall
 *  below it. */
export const MIN_PLAUSIBLE_ONSET_MS =
  (quietTicksToDecide({ ...DEFAULT_PARAMS, lambdaAwake: LAMBDA_MAX }) - 1) * TICK_MS;

/** Nights started before this may predate the detector fix, whose onsets were
 *  anchored at the first quiet tick after the last touch and so can land
 *  anywhere below ~7 min. The fix predates this repository (first commit
 *  2026-07-30), so that is the cutoff. Those nights keep the old floor. */
export const PRE_FIX_BEFORE_MS = Date.UTC(2026, 6, 31);
const LEGACY_FLOOR_MS = 7 * 60_000;

/** A watch onset is measured, not inferred, so no detector floor applies:
 *  falling asleep in 3 minutes is a real night, not an artifact. */
function plausibleFloor(n: RestNight): number {
  if (n.detector === "watch") return 0;
  return n.startedAt < PRE_FIX_BEFORE_MS ? LEGACY_FLOOR_MS : MIN_PLAUSIBLE_ONSET_MS;
}

/** One side of leanComparison: its timed nights and their median. */
export interface LeanSide {
  timedNights: number;
  medianMs: number | null;
}

/** Leaned nights against plain ones (RestNight.shuffle), by the same rules
 *  as the headline median: null until there is a leaned night and either
 *  side has a timed one, so there is something to compare. */
export function leanComparison(
  nights: readonly RestNight[],
): { leaned: LeanSide; plain: LeanSide } | null {
  const leaned: RestNight[] = [];
  const plain: RestNight[] = [];
  for (const n of nights) (n.shuffle === "leaned" ? leaned : plain).push(n);
  if (!leaned.length) return null;
  // The count the median rests on, not every night on the side. (Rounded:
  // a median of an even count can fall on a half millisecond.)
  const side = (ns: RestNight[]): LeanSide => {
    const tts = believableOnsets(ns.filter(isSlept));
    const m = median(tts);
    return { timedNights: tts.length, medianMs: m === null ? null : Math.round(m) };
  };
  const c = { leaned: side(leaned), plain: side(plain) };
  return c.leaned.timedNights > 0 || c.plain.timedNights > 0 ? c : null;
}

/** A night that was slept: an onset, and not marked "awake" (see rollup). */
export function isSlept(n: RestNight): boolean {
  return n.sleptAtMs !== null && n.timeToSleepMs !== null && n.selfLabel !== "awake";
}

/** Of slept nights, the believable times to sleep (see rollup). */
function believableOnsets(slept: readonly RestNight[]): number[] {
  return slept
    .filter((n) => (n.timeToSleepMs as number) >= plausibleFloor(n))
    .map((n) => n.timeToSleepMs as number);
}

export function rollup(nights: RestNight[]): RestRollup {
  // A night the listener marked "awake" was a detector false positive: it was
  // not slept, and its onset time is not a time-to-sleep. stepback.ts (through
  // isSlept) and scoreFeeds discard these too; the headline stats must agree.
  const slept = nights.filter(isSlept);
  // Onsets below this are pre-fix artifacts. The detector used to anchor onset
  // at the first quiet tick, so a night nobody touched recorded ~0ms and the
  // rest screen reported "you drifted off in 1 minute". The fixed detector
  // anchors at the decision bound, which no calibration reaches faster than
  // MIN_PLAUSIBLE_ONSET_MS, so nothing legitimate can land here.
  //
  // The nights themselves still count as slept — the sleep was real, only the
  // figure was wrong — so this filters the time statistics, not the ledger.
  const tts = believableOnsets(slept);
  const last7 = newestByStart(nights, 7);
  const avg7 = last7.length
    ? last7.reduce((s, n) => s + n.interactions, 0) / last7.length
    : 0;
  return {
    nights: nights.length,
    nightsSlept: slept.length,
    bestTimeToSleepMs: tts.length ? Math.min(...tts) : null,
    medianTimeToSleepMs: median(tts),
    avgInteractions7: avg7,
  };
}

const PKEY = "sleepcast2.rest.params";
export function loadParams(): DetectorParams | null {
  try { const r = localStorage.getItem(PKEY); return r ? JSON.parse(r) : null; } catch { return null; }
}
export function saveParams(p: DetectorParams): void {
  try { writeMakingRoom(PKEY, JSON.stringify(p)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Quiet mode — the app stepping back at its own suggestion (see stepback.ts).
// While quiet, the 3am re-anchor and the goodbye line are both suppressed.
// ---------------------------------------------------------------------------

const QUIET_KEY = "sleepcast2.rest.quiet";
const ASKED_KEY = "sleepcast2.rest.stepback";

export function loadQuietUntil(): number | null {
  try {
    const r = localStorage.getItem(QUIET_KEY);
    const n = r === null ? NaN : Number(r);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

export function saveQuietUntil(ts: number): void {
  try { localStorage.setItem(QUIET_KEY, String(ts)); } catch { /* ignore */ }
}

/** When we last put the question. Asking repeatedly would be exactly the
 *  nagging the offer exists to remove. */
export function loadStepBackAsked(): number | null {
  try {
    const r = localStorage.getItem(ASKED_KEY);
    const n = r === null ? NaN : Number(r);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

export function markStepBackAsked(ts: number): void {
  try { localStorage.setItem(ASKED_KEY, String(ts)); } catch { /* ignore */ }
}
