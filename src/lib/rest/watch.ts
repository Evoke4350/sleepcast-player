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
// detector graded (calibrate.ts).

import type { RestNight } from "./types";
import { attributeOnset } from "./session";
import { loadNights, saveNights } from "./ledger";

export type SampleKind = "asleep" | "awake" | "inbed";
export interface SleepSample {
  start: number;
  end: number;
  kind: SampleKind;
}

/** How long after a night starts the watch's onset still belongs to it. */
export const WATCH_WINDOW_MS = 4 * 60 * 60 * 1000;
/** An asleep sample starting this soon before the night still counts as
 *  falling asleep at its start (the watch's edges are approximate). */
const LEAD_MS = 5 * 60 * 1000;

/** Health's sleep values, as Shortcuts writes them: "In Bed", "Awake",
 *  "Asleep", "Core", "Deep", "REM", "Asleep (Unspecified)"… */
function kindOf(value: string): SampleKind {
  const v = value.toLowerCase().replace(/\s+/g, "");
  if (v.includes("awake")) return "awake";
  if (v.includes("inbed")) return "inbed";
  return "asleep";
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
    out.push({ start, end, kind: kindOf(value) });
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

/** A night with the watch's onset in place of the detector's. Idempotent:
 *  the detector's own guess is taken only the first time. */
export function withWatchOnset(n: RestNight, onset: number | null): RestNight {
  const appSleptAtMs = n.detector === "hr" ? (n.appSleptAtMs ?? null) : n.sleptAtMs;
  // While the night played: after it, the audio didn't put you to sleep.
  const played = n.playedMs ?? (n.timerMinutes > 0 ? n.timerMinutes * 60_000 : WATCH_WINDOW_MS);
  const slept = onset !== null && onset <= played ? onset : null;
  const { onsetFeedId, onsetEpisodeId, onsetAfterMs, sleptThrough, ...rest } = n;
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
  const next = nights.map((n) => {
    const onset = watchOnsetMs(n, samples);
    if (onset === undefined) return n;
    const m = withWatchOnset(n, onset);
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
