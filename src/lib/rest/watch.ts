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
import { lastOf, loadNights, storeNights, withNight } from "./ledger";
import { median } from "./stats";
import { killedNightToRecord } from "./reconcile";
import { WATCH_HASH } from "./watch-hash";
import { NIGHT_ENDS_HOUR } from "./reanchor";
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
 *  name this doesn't know (another language's, or a known one with words
 *  run on after it: the two can't be told apart, "REM Uykusu" from "Core
 *  thanks", so the notice names both). */
function stageAsleep(raw: string): boolean | "code" | null {
  if (/\p{N}/u.test(raw)) return CODES.get(raw) ?? "code";
  return NAMES.get(raw.toLowerCase().replace(/[^a-z]/g, "")) ?? null;
}

/** A date as a strict parser (Safari's) wants it: "T" before the time
 *  (for a space or a lowercase t, RFC 3339) and "Z" for a lowercase z. */
export function normaliseIso(text: string): string {
  return text
    .trim()
    .replace(/^(\d{4}-\d{2}-\d{2})[ t](?=\d{2}:\d{2})/, "$1T")
    .replace(/z$/, "Z");
}

/** A date with a time of day, in ms, or null. A date alone parses as
 *  midnight UTC: no onset at all. */
function parseTime(text: string): number | null {
  // A time of day as ISO 8601 writes it ("T23:15"): a weekday name has a
  // "T" too, and parses as midnight.
  const iso = normaliseIso(text);
  if (!/T\d{2}:\d{2}/.test(iso)) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** The payload's first line: where the Shortcut's window opens ("window~",
 *  any case, spaces around the "~" allowed). */
const WINDOW_LINE = /^window\s*~\s*/i;


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
  if (fields.length !== 3) return "malformed";
  const [startText, endText, rawStage] = fields;
  const stage = rawStage.trim();
  const start = parseTime(startText);
  const end = parseTime(endText);
  const stageOk = /^[\p{L}\p{M}\p{N} ()_-]+$/u.test(stage) && /[\p{L}\p{N}]/u.test(stage);
  if (start === null || end === null || end < start || !stageOk) return "malformed";
  const asleep = stageAsleep(stage);
  if (asleep === "code") return "malformed";
  if (asleep === null) return "unrecognised";
  return { start, end, asleep };
}

/** A Shortcut's payload: where its window opens (null when the window line
 *  is missing, its date doesn't parse or is after `now`; moved up when lines past
 *  MAX_SAMPLES were dropped), the samples of the lines kept, and, over all
 *  its lines, how many named a stage this doesn't recognise and how many
 *  were malformed (either date without a time of day or unparseable, an
 *  end before the start, other than three fields, or a stage that isn't a
 *  name or code), which most likely means the Shortcut's format is off.
 *  Blank lines are neither. */
export function parseWatchPayload(text: string, now = Infinity): {
  windowStart: number | null;
  badWindow: boolean;
  samples: SleepSample[];
  unrecognised: number;
  malformed: number;
} {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let windowStart: number | null = null;
  let badWindow = false;
  if (WINDOW_LINE.test(lines[0] ?? "")) {
    windowStart = parseTime(lines.shift()!.replace(WINDOW_LINE, ""));
    // There, but its date doesn't read, or opens in the future (the
    // Shortcut's adjust-date step adding where it should subtract): the
    // window line is wrong, not missing.
    if (windowStart !== null && windowStart > now) windowStart = null;
    badWindow = windowStart === null;
  }
  // One pass. Refusals count over every line, dropped ones too (a dropped
  // line that doesn't read is still a payload that doesn't); samples come
  // from the newest MAX_SAMPLES. With lines dropped off the front, the
  // window opens where what's kept begins (the Shortcut sorts oldest
  // first), not where the window line said, or a night whose first stages
  // were dropped would look whole; and no earlier than the end of any dropped
  // sleep (only sleep joins: a dropped Awake or In Bed sample doesn't), the
  // margin a kept sample could join across being timeableFrom's. A first
  // kept line that doesn't parse is malformed, refused anyway.
  const firstKept = Math.max(0, lines.length - MAX_SAMPLES);
  const samples: SleepSample[] = [];
  let malformed = 0;
  let unrecognised = 0;
  lines.forEach((line, i) => {
    const p = parseLine(line);
    if (p === "malformed") malformed++;
    else if (p === "unrecognised") unrecognised++;
    else if (i >= firstKept) {
      samples.push(p);
      if (i === firstKept && firstKept > 0 && windowStart !== null) windowStart = Math.max(windowStart, p.start);
    } else if (p.asleep && windowStart !== null) {
      windowStart = Math.max(windowStart, p.end);
    }
  });
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

/** The watch's onset for a night, from its start (ms): the start of the
 *  first stretch of sleep (sleepStretches) that begins at or after the
 *  night's start, before MATCH_WINDOW_MS and before the next night's start
 *  (a 3am re-anchor is its own night) and the night's end: `until`, the
 *  caller's limit (applyWatch passes the next night's start or the end plus
 *  AFTER_END_MS, whichever comes first); null when none does. "asleep" when a
 *  stretch was under way at the night's start: the watch had the listener
 *  asleep as they pressed start, so it can't say when they fell asleep (a
 *  stretch after a later wake would pass for it). The watch can be wrong
 *  there (lying still, reading, scored as sleep; the night's own touches
 *  may say otherwise), so the night keeps what it has. "pending" when no
 *  sleep has been handed over past the night's start yet (Awake or In Bed
 *  samples there don't count: the watch may have synced the morning's wake
 *  before the night's sleep), which a later run can still time. */
export function watchOnset(
  startedAt: number,
  stretches: readonly { start: number; end: number }[],
  until = Infinity,
): number | "asleep" | "pending" | null {
  // The first stretch to end past the start (they're in time order and
  // don't overlap): none yet, under way at it, or the first to begin in it.
  const first = stretches.find((s) => s.end > startedAt);
  if (!first) return "pending";
  if (first.start < startedAt) return "asleep";
  return first.start < Math.min(startedAt + MATCH_WINDOW_MS, until) ? first.start - startedAt : null;
}

/** How long after a night ended sleep can still be its onset: drifting
 *  off in the quiet after the fade. Later sleep began without sleepcast
 *  (a night stopped after three minutes isn't timed by sleep hours on). */
export const AFTER_END_MS = 30 * 60_000;

export interface WatchTiming {
  startedAt: number;
  atMs: number;
  inferredAtMs: number | null;
}

/** The earliest start a night can have and still be timed by a payload
 *  whose window opens at `windowStart`: strictly more than CONTIGUOUS_MS
 *  after it, as a sample left out just before the window (by the
 *  Shortcut's filter, or dropped past MAX_SAMPLES) could have joined the
 *  first one kept (stretches join at <= CONTIGUOUS_MS). */
export function timeableFrom(windowStart: number): number {
  return windowStart + CONTIGUOUS_MS + 1;
}

/** Every night the samples time, re-timed; the rest as they were, in the
 *  same order. `timed` lists the nights whose time this changed;
 *  `unchanged` counts those the watch had already timed and keep that time:
 *  timed the same again (the Shortcut reads two days, so each morning
 *  re-reads the night before), or not timed by this run at all (a timed
 *  night stays timed). `asleepAtStart` lists the others the watch had the
 *  listener asleep at the start of, which keep what they have; `pending`
 *  the others watchOnset found "pending", which a later run can still time.
 *  Only nights from timeableFrom(windowStart): for an earlier one the
 *  window may have cut its sleep off (whether it began before the night's
 *  start is unknown, and a stage change after a brief wake would pass for
 *  its onset), so it keeps what it has. A later night has every sample
 *  under way at or after its start (the Shortcut filters by end date), its
 *  first-ever one included. */
export function applyWatch(
  nights: readonly RestNight[],
  samples: readonly SleepSample[],
  windowStart: number,
): { nights: RestNight[]; timed: WatchTiming[]; unchanged: number; asleepAtStart: number[]; pending: number[] } {
  const stretches = sleepStretches(samples);
  const from = timeableFrom(windowStart);
  const starts = nights.map((n) => n.startedAt).sort((a, b) => a - b); // unique (loadNights)
  const next = new Map(starts.map((s, i) => [s, starts[i + 1] ?? Infinity]));
  const timed: WatchTiming[] = [];
  let unchanged = 0;
  const atStart: number[] = [];
  const pending: number[] = [];
  const out = nights.map((n) => {
    if (n.startedAt < from) return n;
    // Before the next night's start, and not long after this one ended.
    // (An end before the start, from a clock set back, counts as the start:
    // finish clamps it, but a ledger may hold one written before it did.)
    const end = n.endedAt === undefined ? Infinity : Math.max(n.startedAt, n.endedAt) + AFTER_END_MS;
    const until = Math.min(next.get(n.startedAt) ?? Infinity, end);
    const at = watchOnset(n.startedAt, stretches, until);
    // Not timed anew: the night keeps what it has. One the watch timed
    // before stays timed, unchanged; one it had the listener asleep at the
    // start of is said.
    if (typeof at !== "number" || (n.detector === "watch" && n.sleptAtMs === at)) {
      if (n.detector === "watch") unchanged++;
      else if (at === "asleep") atStart.push(n.startedAt);
      else if (at === "pending") pending.push(n.startedAt);
      return n;
    }
    const r = retimed(n, at);
    timed.push({ startedAt: n.startedAt, atMs: at, inferredAtMs: r.inferredAtMs ?? null });
    return r;
  });
  return {
    nights: out,
    timed: timed.sort((a, b) => a.startedAt - b.startedAt),
    unchanged,
    asleepAtStart: atStart,
    pending,
  };
}

/** Every reason a payload is refused for its content, in one place. */
function refusedFor(r: Pick<WatchImport, "noWindow" | "badWindow" | "unrecognised" | "malformed">): boolean {
  return r.noWindow || r.badWindow || r.unrecognised > 0 || r.malformed > 0;
}

/** Whether an import changed nothing: refused for its content, or not
 *  saved (a killed tab's night included), so a paste is worth keeping to
 *  look at. */
export function isRefused(r: WatchImport): boolean {
  return refusedFor(r) || r.unsaved;
}

export interface WatchImport {
  timed: WatchTiming[];
  /** The latest re-timed night isn't the newest night (that had no sleep
   *  the watch saw): the notice names it. */
  latestIsOlder?: boolean;
  /** Nights stored without a watch time the notice names, one reason each,
   *  oldest first: "later", the newest night or a killed tab's recorded,
   *  that watchOnset found "pending" (a later run can time it); "recorded", a killed tab's night
   *  no later run can time (its sleep synced past its start, or it began at
   *  the window's edge), said as its resume offer is gone; "asleep", a
   *  night the watch had the listener asleep at the start of, which keeps
   *  what it had. */
  untimed?: { startedAt: number; why: "later" | "recorded" | "asleep" }[];
  /** How many of the samples were sleep: none yet means the watch hadn't
   *  handed the night over, whatever In Bed or Awake samples came. */
  slept: number;
  unchanged: number;
  /** The nights couldn't be stored (storage full): nothing changed. */
  unsaved: boolean;
  /** The nights as stored, when anything was (re-timed nights, or a killed
   *  tab's night recorded): what the rest view shows next. */
  nights?: RestNight[];
  /** No window line (a Shortcut built before it was added): refused. */
  noWindow: boolean;
  /** A window line whose date didn't read, or that opens in the future:
   *  refused. */
  badWindow: boolean;
  unrecognised: number;
  malformed: number;
}

/** Whether text still holds a url-encoded escape. */
function hasEscape(s: string): boolean {
  return /%[0-9a-f]{2}/i.test(s);
}

/** A pasted payload: the lines themselves, still url-encoded or not (the
 *  paste variant of the Shortcut may keep its url-encode step), or a whole
 *  #watch= link, itself perhaps percent-encoded. Plain text never holds an
 *  escape (dates and stage names have no "%"), so any escape means it is
 *  still encoded. Read by the payload's own grammar only: whatever else
 *  comes with it (a message's words, a quote marker) refuses the import,
 *  which changes nothing, rather than being guessed away. */
export function payloadFromPaste(text: string): string {
  const i = text.indexOf(WATCH_HASH);
  if (i < 0) {
    // A link percent-encoded whole: decoded by itself, so the words around
    // it stay as they were, and read as any link is.
    const j = text.search(/%23watch%3D/i);
    if (j >= 0) {
      const start = text.slice(0, j).search(/\S*$/);
      const end = j + text.slice(j).search(/\s|$/);
      return payloadFromPaste(text.slice(0, start) + decodeLeniently(text.slice(start, end)) + text.slice(end));
    }
    return (hasEscape(text) ? decodeLeniently(text) : text).trim();
  }
  const after = text.slice(i + WATCH_HASH.length);
  // Encoded whole (every ":" escaped, as url-encode leaves it): the link is
  // one token, ending at the first whitespace, less what a message put
  // after it. Unless the next word goes on with the payload (a "~" or an
  // escape in it: the link wrapped), or the link was encoded only in part:
  // then the rest is read with it.
  const [first, next = ""] = after.trim().split(/\s+/);
  const token = unpunctuated(first);
  if (hasEscape(token) && !token.includes(":") && !(next.includes("~") || hasEscape(next))) return decodeLeniently(token).trim();
  // Otherwise (the url-encode step missed) the rest of the paste, decoded
  // as the link would be.
  const tail = unpunctuated(after);
  return (hasEscape(tail) ? decodeLeniently(tail) : tail).trim();
}

/** Less any punctuation or symbol a message put after a link (a full
 *  stop, an ellipsis, a closing quote, an autolink's >, **), but not a
 *  "~" or ")", which a payload's last line may end with. */
function unpunctuated(s: string): string {
  return s.trim().replace(/(?:(?![~)])[\p{P}\p{S}])+$/u, "");
}

/** Reads a payload into the rest ledger. A payload without its window
 *  line is refused (applyWatch needs it). Any unrecognised stage refuses
 *  the whole import: in several languages REM is still "REM" while the
 *  other stages aren't English, so the recognised part alone would time
 *  the night from its first REM stage, an hour or more late. So does any
 *  malformed line: a sample missing from inside a stretch splits it, and
 *  its next stage change would pass for falling asleep. */
export function importWatch(text: string, now = Date.now()): WatchImport {
  const { windowStart, badWindow, samples, unrecognised, malformed } = parseWatchPayload(text, now);
  // No window line, samples or not: a Shortcut built before it was added
  // (or not this Shortcut's text at all) is told to use the updated steps.
  const noWindow = windowStart === null && !badWindow;
  const refusedContent = refusedFor({ noWindow, badWindow, unrecognised, malformed });
  let timed: WatchTiming[] = [];
  let unchanged = 0;
  let unsaved = false;
  let latestIsOlder = false;
  const untimed: NonNullable<WatchImport["untimed"]> = [];
  let saved: RestNight[] | undefined;
  // A window line and nothing refused: the import goes ahead, even with no
  // samples (the watch hadn't synced yet), as the night it closes is over.
  if (windowStart !== null && !refusedContent) {
    // The night a killed tab left unrecorded is the one the import is for,
    // by link or by paste alike: added here and written with the re-timed
    // nights in one save, then its snapshot cleared (commit) only once that
    // took. An import that is refused, or not saved, changes nothing.
    const killed = killedNightToRecord(now);
    // (loadNights reads an older ledger's copies of a night as one.)
    const nights = killed ? withNight(loadNights(), killed.night) : loadNights();
    const newest = lastOf(nights)?.startedAt;
    const r = applyWatch(nights, samples, windowStart);
    const worthWriting = r.timed.length > 0 || killed !== null;
    const latest = r.timed.at(-1);
    unchanged = r.unchanged;
    // Nothing to write, nothing written (a full store would evict cached
    // feeds to make room for no change).
    if (worthWriting) {
      const stored = storeNights(r.nights, now);
      if (stored) {
        // Recorded, so its snapshot goes (one older than every night the cap
        // keeps isn't kept, as with appendNight: the ledger holds the newest).
        killed?.commit();
        timed = r.timed;
        saved = stored;
        latestIsOlder = latest !== undefined && newest !== undefined && latest.startedAt < newest;
      } else unsaved = true;
    }
    // The nights the notice names without a watch time, one reason each, in
    // one place. Asleep at the start: said on every run that finds it (at
    // most two mornings, the Shortcut reading two days; true each time),
    // written or not, as nothing about it changes.
    for (const startedAt of r.asleepAtStart) untimed.push({ startedAt, why: "asleep" });
    // Pending (its sleep not handed over yet, a later run can time it): said
    // of the newest night and the killed tab's as stored, so the listener
    // runs it again.
    const kStart = killed?.night.startedAt;
    const kept = saved?.find((n) => n.startedAt === kStart);
    for (const startedAt of r.pending) {
      if (startedAt === newest || (startedAt === kStart && kept)) untimed.push({ startedAt, why: "later" });
    }
    // The killed tab's night, stored untimed and not by the watch (one merged
    // into a night the watch had timed keeps that time), is said either way,
    // as the resume offer it had is gone: else "recorded" (its sleep came and
    // still didn't time it, or it began at the window's edge: no run will).
    if (kept && kept.detector !== "watch" && !untimed.some((u) => u.startedAt === kStart)) {
      untimed.push({ startedAt: kept.startedAt, why: "recorded" });
    }
  }
  return {
    timed,
    unchanged,
    unsaved,
    ...(saved ? { nights: saved } : {}),
    noWindow,
    badWindow,
    ...(latestIsOlder ? { latestIsOlder } : {}),
    ...(untimed.length && !unsaved ? { untimed: untimed.sort((a, b) => a.startedAt - b.startedAt) } : {}),
    slept: samples.filter((s) => s.asleep).length,
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

/** When a session was, in English like the rest of the copy: "monday
 *  night", "monday morning" / "afternoon", or "the early hours of tuesday"
 *  for one started before NIGHT_ENDS_HOUR. */
function nightName(startedAt: number): string {
  const d = new Date(startedAt);
  const day = d.toLocaleDateString("en", { weekday: "long" }).toLowerCase();
  // By the local hour, not 6 h of absolute time, which a DST change skews.
  // The small hours get their own name: a session started then (a 3am
  // re-anchor) is a night of its own, beside the evening's.
  const h = d.getHours();
  if (h < NIGHT_ENDS_HOUR) return `the early hours of ${day}`;
  return `${day} ${h < 12 ? "morning" : h < 18 ? "afternoon" : "night"}`;
}

/** Where the Shortcut's steps are, as a notice names it (WatchLine makes
 *  it a link). */
export const WATCH_STEPS = "sleepcast.pro/watch";

/** What the notice says of a night stored without the watch's time. */
const UNTIMED_WHY = {
  later: "is recorded without the watch's time: run it again later",
  recorded: "is recorded without the watch's time",
  asleep: "has no watch time: your watch had you asleep before sleepcast started",
} as const;

/** Names for the nights a notice names (its lead's, last night's or an
 *  older one's, among them): nightName, with the start's time added where
 *  two would share a name (a restart the same evening). */
function nightNamer(starts: readonly number[]): (startedAt: number) => string {
  const names = new Map([...new Set(starts)].map((s) => [s, nightName(s)]));
  const counts = new Map<string, number>();
  for (const name of names.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  return (s) => {
    const name = names.get(s) ?? nightName(s);
    if ((counts.get(name) ?? 0) < 2) return name;
    const time = new Date(s).toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" });
    return `${name} (from ${time.toLowerCase().replace(/\s/g, "")})`;
  };
}

/** What an import did, in a line for the listener. */
export function watchNotice(r: WatchImport): string {
  if (r.badWindow) {
    return "the watch data's window line didn't read, or opens in the future, so nothing was changed: in the shortcut, the adjusted date should subtract 2 days, in iso 8601 with the time included, and a link's text should be url-encoded before it's opened.";
  }
  // Before the other format checks: a missing (or misplaced) window line is
  // the structural problem, and a misplaced one also reads as a bad line.
  if (r.noWindow) {
    return `the watch shortcut needs its window line first, so nothing was changed: see the updated steps at ${WATCH_STEPS}.`;
  }
  if (r.unsaved) return "nothing could be saved: this browser's storage for sleepcast is full.";
  if (r.malformed) {
    const lines = r.malformed === 1 ? "a line" : `${r.malformed} lines`;
    return `${lines} of the watch data didn't read, so nothing was changed: in the shortcut, check the text is start date~end date~value, with both dates iso 8601 and the time included.`;
  }
  if (r.unrecognised) {
    return "your watch's sleep stages didn't read, so nothing was changed: sleepcast reads them in english only for now, and each line should end with the stage alone.";
  }
  // Each night stored without the watch's time, named with why, whatever
  // else the line says (it may be last night).
  const last = r.timed.at(-1);
  const name = nightNamer([...(r.untimed ?? []), ...r.timed].map((x) => x.startedAt));
  const notes = (r.untimed ?? []).map(({ startedAt, why }) => ` ${name(startedAt)} ${UNTIMED_WHY[why]}.`).join("");
  if (!last) {
    // Nights the watch had someone asleep at the start of: why, said, first
    // (it is news), then that the rest is as it was.
    if (r.untimed?.some((u) => u.why === "asleep")) {
      return `${notes.trim()}${r.unchanged ? " nothing else new from your watch since it last ran." : ""}`;
    }
    // (With no sleep at all handed over, the hint below says more.)
    if (r.unchanged && r.slept) return `nothing new from your watch since it last ran.${notes}`;
    if (notes) return `${r.slept ? "no sleep from your watch inside a sleepcast night yet." : "nothing from your watch yet (check sleep tracking is on)."}${notes}`;
    return r.slept
      ? "your watch's sleep didn't start inside a sleepcast night."
      : "nothing from your watch yet: check sleep tracking is on.";
  }
  const guess = last.inferredAtMs === null ? "" : `; sleepcast guessed ${fmtOnsetMinutes(last.inferredAtMs)}`;
  // Not last night's (it had no sleep the watch saw): say which night, or it
  // reads as last night's beside the goodbye.
  const older = r.latestIsOlder ? ` for ${name(last.startedAt)}` : "";
  const lead = r.timed.length === 1 ? `your watch${older}` : `your watch timed ${r.timed.length} nights. the latest${older}`;
  // "asleep under a minute in" doesn't read: the fast case gets its own words.
  const when = underAMinute(last.atMs) ? "asleep within a minute" : `asleep ${fmtOnsetMinutes(last.atMs)} in`;
  return `${lead}: ${when}${guess}.${notes}`;
}

/** How the detector's guesses compare with the watch: nights the watch
 *  timed, how many of those the detector had also timed, and the median gap
 *  between the two, or null with none to compare. */
export function watchAgreement(nights: readonly RestNight[]): {
  watchNights: number;
  compared: number;
  medianOffMs: number | null;
} {
  type Timed = RestNight & { sleptAtMs: number };
  const watched = nights.filter((n): n is Timed => n.detector === "watch" && n.sleptAtMs !== null);
  const gaps = watched
    .filter((n): n is Timed & { inferredAtMs: number } => typeof n.inferredAtMs === "number")
    .map((n) => Math.abs(n.inferredAtMs - n.sleptAtMs));
  const m = median(gaps);
  return {
    watchNights: watched.length,
    compared: gaps.length,
    medianOffMs: m === null ? null : Math.round(m),
  };
}
