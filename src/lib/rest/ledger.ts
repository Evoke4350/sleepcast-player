import type { RestNight, RestRollup, DetectorParams } from "./types";

const KEY = "sleepcast2.rest";
const MAX_NIGHTS = 90;

export function loadNights(): RestNight[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as RestNight[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(nights: RestNight[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(nights.slice(-MAX_NIGHTS)));
  } catch {
    /* quota / private mode: a lost stat is not worth throwing */
  }
}

export function appendNight(n: RestNight): void {
  save([...loadNights(), n]);
}

export function setSelfLabel(startedAt: number, label: "slept" | "awake"): RestNight | null {
  const nights = loadNights();
  const i = nights.findIndex((n) => n.startedAt === startedAt);
  if (i === -1) return null;
  nights[i] = { ...nights[i], selfLabel: label };
  save(nights);
  return nights[i];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Floor on a believable onset: ~30 quiet ticks to reach the decision bound. */
export const MIN_PLAUSIBLE_ONSET_MS = 7 * 60_000;

export function rollup(nights: RestNight[]): RestRollup {
  const slept = nights.filter((n) => n.sleptAtMs !== null && n.timeToSleepMs !== null);
  // Onsets below this are pre-fix artifacts. The detector used to anchor onset
  // at the first quiet tick, so a night nobody touched recorded ~0ms and the
  // rest screen reported "you drifted off in 1 minute". The fixed detector
  // anchors at the decision bound, which cannot be reached in under ~7 min of
  // quiet, so nothing legitimate can land here.
  //
  // The nights themselves still count as slept — the sleep was real, only the
  // figure was wrong — so this filters the time statistics, not the ledger.
  const tts = slept
    .map((n) => n.timeToSleepMs as number)
    .filter((ms) => ms >= MIN_PLAUSIBLE_ONSET_MS);
  const last7 = nights.slice(-7);
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
  try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch { /* ignore */ }
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
