// Apple Watch sleep onsets, brought in by an iOS Shortcut.
//
// The Shortcut reads the night's Sleep Analysis samples from Health and opens
// sleepcast.pro/#watch=<samples>. The fragment never reaches the server, so the
// samples go from Health to this browser's storage and nowhere else. Each
// sample is one line, "start~end~stage", with ISO 8601 dates and the stage as
// Health names it (Core, Deep, REM, Awake, In Bed, ...). A first line,
// "window~start", says where the Shortcut's window opens (it reads samples
// ending after it, so sleep already under way when the window opens is
// there, from its own start).
//
// A night's onset is the start of the first stretch of sleep that begins
// inside it (see watchOnset and sleepStretches). That replaces the
// detector's guess (kept as inferredAtMs, to compare) and re-attributes the
// night from its timeline, as RestSession.finish attributes the detector's
// onset.
import type { RestNight } from "./types";
import { retimed } from "./attribution";
import { lastOf, loadNights, pruneTimelines, saveNights, withNight } from "./ledger";
import { median } from "./stats";
import { killedNightToRecord } from "./reconcile";
import { WATCH_HASH } from "./watch-hash";
import { fmtOnsetMinutes, underAMinute } from "./sleepscore";

export interface SleepSample {
  start: number;
  end: number;
  asleep: boolean;
}

/** How long after a night's start the watch onset may come and still be
 *  that night's: past it, the sleep belongs to no night sleepcast played. */
export const MATCH_WINDOW_MS = 4 * 60 * 60 * 1000;

/** A payload has at most its last this-many lines used (a week of a busy
 *  night's samples is a few hundred): the fragment is anyone's to write.
 *  The last, because the Shortcut sorts oldest first and the newest night
 *  is the one a morning import is for. Every line is still read, to refuse
 *  a payload any line of which doesn't read. */
export const MAX_SAMPLES = 2000;

/** Health's sleep stages, by code (HKCategoryValueSleepAnalysis, for a
 *  Shortcut that hands the value over as a number: in bed 0, asleep
 *  (unspecified) 1, awake 2, core 3, deep 4, REM 5) and by English name,
 *  letters only, so "In Bed", "Asleep (Core)" and "REM Sleep" all match.
 *  Whole names only: a substring match read the German "REM-Schlaf" as
 *  sleep while missing "Kern", timing the night from its first REM stage.
 *  Anything else is unrecognised, rather than guessed at. */
const CODES = new Map<string, boolean>([
  ["0", false], ["1", true], ["2", false], ["3", true], ["4", true], ["5", true],
]);
const NAMES = new Map<string, boolean>([
  ["inbed", false], ["awake", false],
  ["asleep", true], ["unspecified", true], ["asleepunspecified", true],
  ["core", true], ["asleepcore", true], ["coresleep", true],
  ["deep", true], ["asleepdeep", true], ["deepsleep", true],
  ["rem", true], ["asleeprem", true], ["remsleep", true],
]);

/** A stage as sleep or not; "code" for a would-be code that isn't one
 *  (any digit: "-1", "(1)", "７" — the format, not a language); null for a
 *  name this doesn't know. */
function stageAsleep(stage: string): boolean | "code" | null {
  const raw = stage.trim();
  if (/\p{N}/u.test(raw)) return CODES.get(raw) ?? "code";
  return NAMES.get(raw.toLowerCase().replace(/[^a-z]/g, "")) ?? null;
}

/** A date with a time of day, in ms, or null. A date alone parses as
 *  midnight UTC: no onset at all. */
function parseTime(text: string | undefined): number | null {
  // A time of day as ISO 8601 writes it ("T23:15"): a weekday name has a
  // "T" too, and parses as midnight.
  if (!text || !/T\d{2}:\d{2}/.test(text)) return null;
  const t = Date.parse(text.trim());
  return Number.isFinite(t) ? t : null;
}

/** The payload's first line: where the Shortcut's window opens. */
const WINDOW_LINE = "window~";

/** One sample line, read: a sample, or why it isn't one. A bad end matters
 *  as much as a bad start: zero-length samples never join into a stretch,
 *  so sleep that began before a night's start would look like falling
 *  asleep at its next stage change. A stage is a name or code: anything
 *  else (a date run into it, when the url-encode step was missed and the
 *  line breaks with it) is the Shortcut's format, not a language. Letters
 *  in any script, with their combining marks (Devanagari and Thai vowel
 *  signs): a localised name is a language matter (the "english only"
 *  notice), not a format one. */
function parseLine(line: string): SleepSample | "malformed" | "unrecognised" {
  const fields = line.split("~");
  const [startText, endText, stage] = fields;
  const start = parseTime(startText);
  const end = parseTime(endText);
  const stageOk = stage !== undefined && /^[\p{L}\p{M}\p{N} ()_-]+$/u.test(stage.trim()) && /[\p{L}\p{N}]/u.test(stage);
  if (fields.length !== 3 || start === null || end === null || end < start || !stageOk) return "malformed";
  const asleep = stageAsleep(stage);
  if (asleep === "code") return "malformed";
  if (asleep === null) return "unrecognised";
  return { start, end, asleep };
}

/** A Shortcut's payload: where its window opens (null when the window line
 *  is missing or its date doesn't parse; moved up when lines past
 *  MAX_SAMPLES were dropped), the samples of the lines kept, and, over all
 *  its lines, how many named a stage this doesn't recognise and how many
 *  were malformed (either date without a time of day or unparseable, an
 *  end before the start, other than three fields, or a stage that isn't a
 *  name or code), which most likely means the Shortcut's format is off.
 *  Blank lines are neither. */
export function parseWatchPayload(text: string): {
  windowStart: number | null;
  badWindow: boolean;
  samples: SleepSample[];
  unrecognised: number;
  malformed: number;
} {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let windowStart: number | null = null;
  let badWindow = false;
  if (lines[0]?.toLowerCase().startsWith(WINDOW_LINE)) {
    windowStart = parseTime(lines.shift()!.slice(WINDOW_LINE.length));
    // There, but its date doesn't read: the format, not a missing line.
    badWindow = windowStart === null;
  }
  const parsed = lines.map(parseLine);
  const kept = parsed.slice(-MAX_SAMPLES);
  // Lines dropped off the front: the window now opens where what's kept
  // begins (the Shortcut sorts oldest first), not where the window line
  // said, or a night whose first stages were dropped would look whole;
  // and strictly past any dropped sleep a kept sample could have joined
  // onto (only sleep joins: a dropped Awake or In Bed sample doesn't).
  if (kept.length < parsed.length && windowStart !== null) {
    // (A first kept line that doesn't parse is malformed, refused anyway.)
    const first = kept[0];
    if (typeof first === "object") windowStart = Math.max(windowStart, first.start);
    for (const p of parsed.slice(0, parsed.length - kept.length)) {
      if (typeof p === "object" && p.asleep) windowStart = Math.max(windowStart, p.end + CONTIGUOUS_MS + 1);
    }
  }
  // Samples from the kept lines; the refusals from every line, dropped ones
  // too: a dropped line that doesn't read is still a payload that doesn't.
  const samples: SleepSample[] = [];
  for (const p of kept) if (typeof p === "object") samples.push(p);
  let malformed = 0;
  let unrecognised = 0;
  for (const p of parsed) {
    if (p === "malformed") malformed++;
    else if (p === "unrecognised") unrecognised++;
  }
  return { windowStart, badWindow, samples, unrecognised, malformed };
}

/** Asleep samples closer than this are one stretch of sleep: the watch's
 *  stages abut, give or take a rounding second. */
const CONTIGUOUS_MS = 60_000;

/** Each unbroken stretch of sleep, in time order: asleep samples merged
 *  where one begins within CONTIGUOUS_MS of the stretch's end so far. A
 *  stage change within a stretch is not falling asleep. */
export function sleepStretches(samples: readonly SleepSample[]): { start: number; end: number }[] {
  const asleep = samples.filter((s) => s.asleep).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const s of asleep) {
    const cur = out.at(-1);
    if (cur && s.start <= cur.end + CONTIGUOUS_MS) cur.end = Math.max(cur.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

/** The watch's onset for a night, from its start (ms), or null: the start
 *  of the first stretch of sleep (sleepStretches) that begins at or after
 *  the night's start, before MATCH_WINDOW_MS and before the next night's
 *  start (a 3am re-anchor is its own night). A stretch that began before
 *  the night's start doesn't count, nor does a stage change within it: the
 *  listener was awake to press start, whatever the watch scored. */
export function watchOnset(
  startedAt: number,
  stretches: readonly { start: number }[],
  nextStartedAt = Infinity,
): number | null {
  const limit = Math.min(startedAt + MATCH_WINDOW_MS, nextStartedAt);
  const first = stretches.find((s) => s.start >= startedAt);
  return first && first.start < limit ? first.start - startedAt : null;
}

export interface WatchTiming {
  startedAt: number;
  atMs: number;
  inferredAtMs: number | null;
}

/** Every night the samples time, re-timed; the rest as they were, in the
 *  same order. `timed` lists the nights whose time this changed;
 *  `unchanged` counts those the watch had already timed the same (the
 *  Shortcut reads two days, so each morning re-reads the night before).
 *  Only nights that began after the window opened: for an earlier one the
 *  window may have cut its sleep off (whether it began before the night's
 *  start is unknown, and a stage change after a brief wake would pass for
 *  its onset), so it keeps what it has. A night after the window opened has
 *  every sample under way at or after its start (the Shortcut filters by
 *  end date), its first-ever one included. */
export function applyWatch(
  nights: readonly RestNight[],
  samples: readonly SleepSample[],
  windowStart: number,
): { nights: RestNight[]; timed: WatchTiming[]; unchanged: number } {
  const stretches = sleepStretches(samples);
  const starts = [...new Set(nights.map((n) => n.startedAt))].sort((a, b) => a - b);
  const next = new Map(starts.map((s, i) => [s, starts[i + 1] ?? Infinity]));
  const timed: WatchTiming[] = [];
  let unchanged = 0;
  const out = nights.map((n) => {
    if (n.startedAt < windowStart) return n;
    const at = watchOnset(n.startedAt, stretches, next.get(n.startedAt));
    if (at === null) return n;
    if (n.detector === "watch" && n.sleptAtMs === at) {
      unchanged++;
      return n;
    }
    const r = retimed(n, at);
    timed.push({ startedAt: n.startedAt, atMs: at, inferredAtMs: r.inferredAtMs ?? null });
    return r;
  });
  return { nights: out, timed: timed.sort((a, b) => a.startedAt - b.startedAt), unchanged };
}

export interface WatchImport {
  timed: WatchTiming[];
  /** The newest night in the ledger's start, to tell whether the latest
   *  re-timed night is last night or an older one. */
  newestStartedAt?: number;
  unchanged: number;
  /** The nights couldn't be stored (storage full): nothing changed. */
  unsaved: boolean;
  /** The nights as stored, when anything was (re-timed nights, or a killed
   *  tab's night recorded): what the rest view shows next. */
  nights?: RestNight[];
  /** No window line (a Shortcut built before it was added): refused. */
  noWindow: boolean;
  /** A window line whose date didn't read: refused. */
  badWindow: boolean;
  /** Refused for its content (malformed, unrecognised, no or bad window
   *  line), or not saved: either way nothing changed (a killed tab's night
   *  included), and it is worth keeping to look at. */
  refused: boolean;
  samples: number;
  unrecognised: number;
  malformed: number;
}

/** A pasted payload: the lines themselves, still url-encoded or not (the
 *  paste variant of the Shortcut may keep its url-encode step), or a whole
 *  #watch= link. Plain text never holds an escape (dates and stage names
 *  have no "%"), so any escape means it is still encoded. */
export function payloadFromPaste(text: string): string {
  const i = text.indexOf(WATCH_HASH);
  if (i >= 0) return watchPayloadFromHash(text.slice(i).trim()) ?? "";
  return (/%[0-9a-f]{2}/i.test(text) ? decodeLeniently(text) : text).trim();
}

/** Reads a payload into the rest ledger. A payload without its window
 *  line is refused (applyWatch needs it). Any unrecognised stage refuses
 *  the whole import: in several languages REM is still "REM" while the
 *  other stages aren't English, so the recognised part alone would time
 *  the night from its first REM stage, an hour or more late. So does any
 *  malformed line: a sample missing from inside a stretch splits it, and
 *  its next stage change would pass for falling asleep. */
export function importWatch(text: string, now = Date.now()): WatchImport {
  const { windowStart, badWindow, samples, unrecognised, malformed } = parseWatchPayload(text);
  // No window line, samples or not: a Shortcut built before it was added
  // (or not this Shortcut's text at all) is told to use the updated steps.
  const noWindow = windowStart === null && !badWindow;
  const refusedContent = noWindow || badWindow || unrecognised > 0 || malformed > 0;
  let timed: WatchTiming[] = [];
  let unchanged = 0;
  let unsaved = false;
  let newestStartedAt: number | undefined;
  let saved: RestNight[] | undefined;
  // A window line and nothing refused: the import goes ahead, even with no
  // samples (the watch hadn't synced yet), as the night it closes is over.
  if (windowStart !== null && !refusedContent) {
    // The night a killed tab left unrecorded is the one the import is for,
    // by link or by paste alike: added here and written with the re-timed
    // nights in one save, then its snapshot cleared (commit) only once that
    // took. An import that is refused, or not saved, changes nothing.
    const killed = killedNightToRecord(now);
    const nights = killed ? withNight(loadNights(), killed.night) : loadNights();
    newestStartedAt = lastOf(nights)?.startedAt;
    const r = applyWatch(nights, samples, windowStart);
    unchanged = r.unchanged;
    // Nothing to write, nothing written (a full store would evict cached
    // feeds to make room for no change).
    if (r.timed.length || killed) {
      const stored = saveNights(pruneTimelines(r.nights, now));
      if (stored) {
        killed?.commit();
        timed = r.timed;
        saved = stored;
      } else unsaved = true;
    }
  }
  return {
    timed,
    unchanged,
    unsaved,
    ...(saved ? { nights: saved } : {}),
    noWindow,
    badWindow,
    ...(timed.length && newestStartedAt !== undefined ? { newestStartedAt } : {}),
    refused: refusedContent || unsaved,
    samples: samples.length,
    unrecognised,
    malformed,
  };
}

/** The payload in a location hash, or null when it isn't a watch import.
 *  Decoded leniently: a Shortcut missing its url-encode step leaves a bare
 *  "%" that would make decodeURIComponent throw on the whole payload, so
 *  each escape is decoded on its own and a bad one left as it was (its line
 *  then counts as malformed, and the notice says so). */
export function watchPayloadFromHash(hash: string): string | null {
  if (!hash.startsWith(WATCH_HASH)) return null;
  return decodeLeniently(hash.slice(WATCH_HASH.length));
}

function decodeLeniently(text: string): string {
  return text.replace(/(%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      // A bad byte in the run: decode what can be, a character (1 to 4
      // escapes of UTF-8) at a time, leaving only the bad escapes as they
      // were, so a good %0A beside one still breaks the line.
      const esc = run.match(/%[0-9a-f]{2}/gi)!;
      let out = "";
      for (let i = 0; i < esc.length; ) {
        let n = Math.min(4, esc.length - i);
        for (; n > 0; n--) {
          try {
            out += decodeURIComponent(esc.slice(i, i + n).join(""));
            break;
          } catch {
            /* shorter */
          }
        }
        if (n === 0) {
          out += esc[i];
          i += 1;
        } else i += n;
      }
      return out;
    }
  });
}

/** The weekday a night belongs to, in English like the rest of the copy:
 *  one started in the small hours (before 6am) is the evening before's. */
function nightName(startedAt: number): string {
  const d = new Date(startedAt);
  // By the local hour, not 6 h of absolute time, which a DST change skews.
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en", { weekday: "long" }).toLowerCase();
}

/** What an import did, in a line for the listener. */
export function watchNotice(r: WatchImport): string {
  if (r.badWindow) {
    return "the watch data's window line didn't read, so nothing was changed: in the shortcut, set the adjusted date to iso 8601 with the time included.";
  }
  if (r.noWindow && !r.malformed && !r.unrecognised) {
    return "the watch shortcut needs its window line, so nothing was changed: see the updated steps at sleepcast.pro/watch.";
  }
  if (r.unsaved) return "nothing could be saved: this browser's storage for sleepcast is full.";
  if (r.malformed) {
    const lines = r.malformed === 1 ? "a line" : `${r.malformed} lines`;
    return `${lines} of the watch data didn't read, so nothing was changed: in the shortcut, check the text is start date~end date~value, with both dates iso 8601 and the time included.`;
  }
  if (r.unrecognised) return "your watch's sleep stages came in a language sleepcast can't read yet (english only), so nothing was changed.";
  if (!r.samples) {
    // Most likely the watch hadn't handed the night to the phone yet.
    const recorded = r.nights ? "last night is recorded without the watch's time; " : "";
    return `nothing from your watch yet: ${recorded}run it again later (and check sleep tracking is on).`;
  }
  if (!r.timed.length) {
    return r.unchanged ? "nothing new: your watch had already timed these nights." : "your watch's sleep didn't start inside a sleepcast night.";
  }
  const last = r.timed[r.timed.length - 1];
  const guess = last.inferredAtMs === null ? "" : `; sleepcast guessed ${fmtOnsetMinutes(last.inferredAtMs)}`;
  // Not last night's (it had no sleep the watch saw): say which night, or it
  // reads as last night's beside the goodbye.
  const older =
    r.newestStartedAt !== undefined && last.startedAt < r.newestStartedAt
      ? ` for ${nightName(last.startedAt)} night`
      : "";
  const lead = r.timed.length === 1 ? `your watch${older}` : `your watch timed ${r.timed.length} nights. the latest${older}`;
  // "asleep under a minute in" doesn't read: the fast case gets its own words.
  const when = underAMinute(last.atMs) ? "asleep within a minute" : `asleep ${fmtOnsetMinutes(last.atMs)} in`;
  return `${lead}: ${when}${guess}.`;
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
    .map((n) => Math.abs((n.inferredAtMs as number) - (n.sleptAtMs as number)));
  const m = median(gaps);
  return {
    watchNights: watched.length,
    compared: gaps.length,
    medianOffMs: m === null ? null : Math.round(m / 1000) * 1000,
  };
}
