import type { Episode, PlayMode } from "./engine";
import { recordHeard, migrateLegacyHistory, type Play } from "./plays";
import { shouldRemember, putPosition, type Positions } from "./positions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeedRef {
  id: string;
  url: string;
  title: string;
  builtin: boolean;
  enabled: boolean;
  skipIntroMin: number;
}

export interface NoiseSettings {
  on: boolean;
  level: number; // gain 0..0.3
}

export interface LastSession {
  endedAt: number; // epoch ms
  timerMinutes: number;
  modeKind: PlayMode["kind"];
}

export interface Settings {
  timerMinutes: number;
  /** Opt-in stimulus control: stop and suggest getting up after a restless
   *  stretch. Off unless the listener asks for it — see rest/quarterhour.ts. */
  quarterHourRule: boolean;
  feedTrim: Record<string, number>; // feedId -> 0.5..1.5; absent = 1.0
  noise: NoiseSettings;
  leveling: boolean; // opt-in auto-compressor probe (§1b) — off avoids the double load
  mode: PlayMode;
  lastSession: LastSession | null;
}

export interface AppState {
  feeds: FeedRef[];
  settings: Settings;
}

// ---------------------------------------------------------------------------
// localStorage keys
// ---------------------------------------------------------------------------

const KEY_STATE = "sleepcast2.state";
const KEY_HISTORY = "sleepcast2.history";
const KEY_TIMER = "sleepcast2.timer";
const CACHE_PREFIX = "sleepcast2.feedcache.";
const KEY_LIVE = "sleepcast2.live";
const KEY_PLAYS = "sleepcast2.plays";

// ---------------------------------------------------------------------------
// BUILTIN_FEEDS — "enabled" is omitted (added at runtime via defaults)
// ---------------------------------------------------------------------------

export const BUILTIN_FEEDS: Omit<FeedRef, "enabled">[] = [
  {
    id: "swm",
    url: "https://feed.sleepwithmepodcast.com/",
    title: "Sleep With Me",
    builtin: true,
    skipIntroMin: 0,
  },
  {
    id: "nmh",
    url: "https://feeds.megaphone.fm/SSM2868305742",
    title: "Nothing Much Happens",
    builtin: true,
    skipIntroMin: 0,
  },
  {
    id: "getsleepy",
    url: "https://feeds.megaphone.fm/SGP8517078272",
    title: "Get Sleepy",
    builtin: true,
    skipIntroMin: 0,
  },
  {
    id: "boringbooks",
    url: "https://rss.libsyn.com/shows/132502/destinations/810167.xml",
    title: "Boring Books for Bedtime",
    builtin: true,
    skipIntroMin: 0,
  },
  {
    id: "sendmetosleep",
    url: "https://rss.pdrl.fm/4a3882/feeds.simplecast.com/ILt_JSHP",
    title: "Send Me To Sleep",
    builtin: true,
    skipIntroMin: 0,
  },
  {
    id: "sleepwhispers",
    url: "https://feeds.feedburner.com/sleepwhispers",
    title: "Sleep Whispers",
    builtin: true,
    skipIntroMin: 0,
  },
];

// ---------------------------------------------------------------------------
// Default state helpers
// ---------------------------------------------------------------------------

function defaultFeedRef(f: Omit<FeedRef, "enabled">): FeedRef {
  return { ...f, enabled: f.id === "swm" };
}

const NOISE_DEFAULT: NoiseSettings = { on: false, level: 0.15 };

function defaultSettings(): Settings {
  return {
    timerMinutes: 45,
    quarterHourRule: false,
    feedTrim: {},
    noise: { ...NOISE_DEFAULT },
    leveling: false,
    mode: { kind: "minutes", minutes: 45 },
    lastSession: null,
  };
}

function sanitizeMode(raw: unknown, timerMinutes: number): PlayMode {
  if (raw && typeof raw === "object" && "kind" in raw) {
    const kind = (raw as { kind: unknown }).kind;
    if (kind === "one-episode") return { kind: "one-episode" };
    if (kind === "all-night") return { kind: "all-night" };
    if (kind === "minutes") {
      const m = (raw as { minutes?: unknown }).minutes;
      if (typeof m === "number" && Number.isFinite(m) && m >= 1) {
        return { kind: "minutes", minutes: clampTimerMinutes(m) };
      }
    }
  }
  return { kind: "minutes", minutes: timerMinutes };
}

function sanitizeNoise(raw: unknown): NoiseSettings {
  // Per-field, like sanitizeTrim: a range input can emit values like
  // 0.30000000000000004, which used to fail a combined `level <= 0.3` check
  // and silently reset `on` to false too. Judge each field on its own.
  const out: NoiseSettings = { ...NOISE_DEFAULT };
  if (raw && typeof raw === "object") {
    const on = (raw as { on?: unknown }).on;
    const level = (raw as { level?: unknown }).level;
    if (typeof on === "boolean") out.on = on;
    if (typeof level === "number" && Number.isFinite(level)) {
      out.level = Math.min(0.3, Math.max(0, level));
    }
  }
  return out;
}

function sanitizeTrim(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && v >= 0.5 && v <= 1.5) out[k] = v;
    }
  }
  return out;
}

function sanitizeLastSession(raw: unknown): LastSession | null {
  if (raw && typeof raw === "object") {
    const { endedAt, timerMinutes, modeKind } = raw as Record<string, unknown>;
    if (
      typeof endedAt === "number" &&
      typeof timerMinutes === "number" &&
      (modeKind === "minutes" || modeKind === "one-episode" || modeKind === "all-night")
    ) {
      return { endedAt, timerMinutes, modeKind };
    }
  }
  return null;
}

function defaultState(): AppState {
  return {
    feeds: BUILTIN_FEEDS.map(defaultFeedRef),
    settings: defaultSettings(),
  };
}

// ---------------------------------------------------------------------------
// loadState / saveState
// ---------------------------------------------------------------------------

export function loadState(): AppState {
  const raw = localStorage.getItem(KEY_STATE);
  if (!raw) return defaultState();

  let saved: Partial<AppState>;
  try {
    saved = JSON.parse(raw) as Partial<AppState>;
  } catch {
    return defaultState();
  }

  const savedFeeds: FeedRef[] = Array.isArray(saved.feeds) ? saved.feeds : [];

  // Build a lookup from saved feeds by id for fast merging
  const savedById = new Map<string, FeedRef>(savedFeeds.map((f) => [f.id, f]));

  // Merge: start with builtins (applying any saved overrides), then append
  // any saved non-builtin feeds (custom or unknown-builtin).
  const builtinIds = new Set(BUILTIN_FEEDS.map((f) => f.id));

  const mergedFeeds: FeedRef[] = BUILTIN_FEEDS.map((bf) => {
    const override = savedById.get(bf.id);
    if (override) {
      // Keep the canonical url/title/builtin from BUILTIN_FEEDS; user prefs from saved.
      return {
        ...defaultFeedRef(bf),
        enabled: override.enabled ?? (bf.id === "swm"),
        skipIntroMin: override.skipIntroMin ?? 0,
      };
    }
    return defaultFeedRef(bf);
  });

  // Append saved feeds that are not in BUILTIN_FEEDS (custom + old builtins)
  for (const sf of savedFeeds) {
    if (!builtinIds.has(sf.id)) {
      mergedFeeds.push(sf);
    }
  }

  const savedTimer = saved.settings?.timerMinutes;
  const timerMinutes =
    typeof savedTimer === "number" && Number.isFinite(savedTimer)
      ? clampTimerMinutes(savedTimer)
      : defaultSettings().timerMinutes; // same as a fresh install
  const rawSettings = (saved.settings ?? {}) as Record<string, unknown>;
  const settings: Settings = {
    timerMinutes,
    feedTrim: sanitizeTrim(rawSettings.feedTrim),
    noise: sanitizeNoise(rawSettings.noise),
    leveling: typeof rawSettings.leveling === "boolean" ? rawSettings.leveling : false,
    mode: sanitizeMode(rawSettings.mode, timerMinutes),
    lastSession: sanitizeLastSession(rawSettings.lastSession),
    quarterHourRule: rawSettings.quarterHourRule === true,
  };

  return { feeds: mergedFeeds, settings };
}

export function saveState(s: AppState): void {
  writeMakingRoom(KEY_STATE, JSON.stringify(s));
}

// ---------------------------------------------------------------------------
// Live session — a snapshot of the night in progress, so it survives a full
// reload (an iOS PWA reclaiming the backgrounded tab is the case that matters:
// the <audio> element keeps playing while locked, but if the OS kills the tab
// the night is gone). We persist remaining time (not an absolute end) so a
// paused stretch doesn't burn the timer, and a bounded slice of the pool so a
// full-archive night can't overflow localStorage.
// ---------------------------------------------------------------------------

export interface LiveSession {
  savedAt: number;
  remainingMs: number;
  totalSeconds: number;
  position: number; // currentTime of the playing episode
  current: Episode;
  playedIds: string[]; // which of the spread you've already heard
  pool: Episode[];
  skipIntroByFeedId: Record<string, number>;
  feedTitles: Record<string, string>;
  artworkByFeedId: Record<string, string>;
  /** When the night began and its timer length, for reconciling a killed tab
   *  into the rest ledger (rest/reconcile.ts). Absent on snapshots written
   *  before these existed; reconcile estimates them. */
  nightStartedAt?: number;
  timerMinutes?: number;
  /** The night's play mode. A one-episode or all-night night has no clock
   *  (remainingMs is 0), so without this a reload could neither tell it from a
   *  finished timed night nor revive it in the right mode. */
  modeKind?: PlayMode["kind"];
  /** Transport touches before the snapshot, carried into a revived session. */
  interactions?: number;
  /** Player only (the quarter-hour rule's input): the same, unmerged
   *  (wakefulness counts every touch), and whether the rule was spent. */
  touches?: number;
  ruleSpent?: boolean;
  /** Timer extensions used (capped per night, reloads included). */
  extensions?: number;
  /** Whether the night was a varied mix (lastNight, and the re-anchor's
   *  follow-on night, carry it). */
  wasVaried?: boolean;
}

/** What a revived night resumes from: the snapshot, as the players take it.
 *  Derived from LiveSession (see resumeFrom), so a per-night field added
 *  there can't be dropped on the way. */
export type ResumeDescriptor = ResumeFields & { episode: Episode };
/** The snapshot's fields a revived night takes through `resume`. */
type ResumeFields = Omit<LiveSession, "current" | NightSessionField>;

/** Snapshot fields a revived night takes through its session and mode (the
 *  pool, the feeds' settings, the mix, the timer and the mode), not through
 *  `resume`: one copy of each. One list, for the type and for resumeFrom. */
const NIGHT_SESSION_FIELDS = [
  "pool", "skipIntroByFeedId", "feedTitles", "artworkByFeedId", "wasVaried", "timerMinutes", "modeKind",
] as const satisfies readonly (keyof LiveSession)[];
type NightSessionField = (typeof NIGHT_SESSION_FIELDS)[number];

/** The snapshot as a ResumeDescriptor: all of it but the session's fields,
 *  the playing episode as `episode`. */
export function resumeFrom(l: LiveSession): ResumeDescriptor {
  const sessionField = new Set<string>(NIGHT_SESSION_FIELDS);
  const fields = Object.fromEntries(
    Object.entries(l).filter(([k]) => k !== "current" && !sessionField.has(k)),
  ) as ResumeFields;
  return { ...fields, episode: l.current, playedIds: l.playedIds ?? [] };
}

/** The night's own timer length: the snapshot's, else estimated from its
 *  total (which includes extensions) for a snapshot from before it was kept. */
export function nightTimerMinutes(l: LiveSession): number {
  return l.timerMinutes ?? Math.max(1, Math.round(l.totalSeconds / 60));
}

const LIVE_POOL_CAP = 80;

/** A snapshot's played episodes, the current one included. */
export function withCurrentPlayed(l: Pick<LiveSession, "playedIds" | "current">): string[] {
  return l.playedIds.includes(l.current.id) ? l.playedIds : [...l.playedIds, l.current.id];
}

/** Snapshots are written every this many ticks while an episode plays. */
export const SNAPSHOT_EVERY_TICKS = 10;

/** Whether it was written. */
export function saveLive(s: LiveSession): boolean {
  // Keep the current episode plus a bounded remainder — enough to keep the
  // shuffle going after a resume without serialising thousands of episodes.
  const rest = s.pool.filter((e) => e.id !== s.current.id).slice(0, LIVE_POOL_CAP - 1);
  // The current episode counts as played (the state that adds it may not
  // have reached the writer yet).
  const bounded: LiveSession = { ...s, playedIds: withCurrentPlayed(s), pool: [s.current, ...rest] };
  try {
    return writeMakingRoom(KEY_LIVE, JSON.stringify(bounded));
  } catch {
    // Quota or private mode: a lost resume is not worth throwing over.
    return false;
  }
}

export function loadLive(): LiveSession | null {
  try {
    const raw = localStorage.getItem(KEY_LIVE);
    if (!raw) return null;
    const s = JSON.parse(raw) as LiveSession;
    if (!s || !s.current || typeof s.remainingMs !== "number") return null;
    return s;
  } catch {
    return null;
  }
}

/** A snapshot older than this belongs to a night the listener has already
 *  woken from, not the one they're trying to get back to. The same span as
 *  the re-arm and re-anchor windows. */
export const LIVE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Whether a snapshotted night is worth offering to revive: enough of it left
 *  to matter, and recent. Without the age check, a tab the browser killed at
 *  11 pm offered to revive that night the next evening, and because a live
 *  snapshot outranks the 3am re-anchor, it hid that too. */
function isTimerless(l: LiveSession): boolean {
  return l.modeKind === "one-episode" || l.modeKind === "all-night";
}

export function isRevivable(l: LiveSession | null, now: number): boolean {
  if (!l || typeof l.savedAt !== "number") return false;
  // A timerless night snapshots no remaining time; only a timed one can run out.
  if (!isTimerless(l) && l.remainingMs <= 60_000) return false;
  const age = now - l.savedAt;
  return age >= 0 && age < LIVE_MAX_AGE_MS;
}

export function clearLive(): void {
  try {
    localStorage.removeItem(KEY_LIVE);
  } catch {
    /* nothing to do */
  }
}

// ---------------------------------------------------------------------------
// Last episode — the one the returning listener drifted off to, so we can
// offer "the exact one again" (the toddler-same-story comfort). Local only.
// ---------------------------------------------------------------------------
const KEY_LASTEP = "sleepcast2.lastep";

export function saveLastEpisode(ep: Episode): void {
  try {
    writeMakingRoom(KEY_LASTEP, JSON.stringify(ep));
  } catch {
    /* ignore */
  }
}

/** Never one the listener has since said "never again" to: the lead path
 *  plays it directly, without consulting the blocked list. Filtered here, on
 *  read, so an episode unblocked later is offered again. */
export function loadLastEpisode(): Episode | null {
  try {
    const raw = localStorage.getItem(KEY_LASTEP);
    if (!raw) return null;
    const ep = JSON.parse(raw) as Episode;
    return ep && ep.url && !isBlocked(ep.id) ? ep : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Last night — the spread of the night that just faded, kept so the 3am
// re-anchor can offer the next episode without a fresh spin. Separate from
// KEY_LIVE (which is cleared when the night ends) and bounded like it.
// ---------------------------------------------------------------------------
const KEY_LASTNIGHT = "sleepcast2.lastnight";
const LASTNIGHT_POOL_CAP = 80;

export interface LastNight {
  pool: Episode[];
  playedIds: string[];
  feedTitles: Record<string, string>;
  artworkByFeedId: Record<string, string>;
  skipIntroByFeedId: Record<string, number>;
  endedVia: "faded" | "ended" | "abandoned";
  endedAt: number;
  wasVaried: boolean;
}

export function saveLastNight(n: LastNight): void {
  const bounded: LastNight = { ...n, pool: n.pool.slice(0, LASTNIGHT_POOL_CAP) };
  try {
    writeMakingRoom(KEY_LASTNIGHT, JSON.stringify(bounded));
  } catch {
    /* quota / private mode: a lost re-anchor is not worth throwing over */
  }
}

export function loadLastNight(): LastNight | null {
  try {
    const raw = localStorage.getItem(KEY_LASTNIGHT);
    if (!raw) return null;
    const n = JSON.parse(raw) as LastNight;
    if (!n || !Array.isArray(n.pool) || typeof n.endedAt !== "number") return null;
    return n;
  } catch {
    return null;
  }
}

export function clearLastNight(): void {
  try {
    localStorage.removeItem(KEY_LASTNIGHT);
  } catch {
    /* nothing to do */
  }
}

// ---------------------------------------------------------------------------
// addCustomFeed
// ---------------------------------------------------------------------------

export function addCustomFeed(
  s: AppState,
  url: string,
  title?: string,
  enabled = true
): AppState {
  // Validate: must be a valid https URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Only https:// URLs are allowed, got: "${url}"`);
  }

  // Dedupe by URL
  if (s.feeds.some((f) => f.url === url)) {
    return { ...s, feeds: [...s.feeds] };
  }

  const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const newFeed: FeedRef = {
    id,
    url,
    title: title ?? url,
    builtin: false,
    enabled,
    skipIntroMin: 0,
  };

  return { ...s, feeds: [...s.feeds, newFeed] };
}

// ---------------------------------------------------------------------------
// removeCustomFeed
// ---------------------------------------------------------------------------

export function removeCustomFeed(s: AppState, id: string): AppState {
  // No-op for builtin feeds
  const feed = s.feeds.find((f) => f.id === id);
  if (!feed || feed.builtin) {
    return { ...s, feeds: [...s.feeds] };
  }
  return { ...s, feeds: s.feeds.filter((f) => f.id !== id) };
}

// ---------------------------------------------------------------------------
// Play history
// ---------------------------------------------------------------------------

/** Legacy 25-id history. Read only by the getPlays migration below; nothing
 *  writes it any more. */
export function getHistory(): string[] {
  const raw = localStorage.getItem(KEY_HISTORY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

/**
 * The play ledger (see plays.ts). Replaces getHistory/recordPlay, which are
 * kept only so an old snapshot can still be migrated.
 *
 * On first read after the upgrade the legacy 25 ids are converted in place and
 * the old key is dropped, so the migration runs once and a listener keeps
 * whatever anti-repeat they already had.
 */
export function getPlays(): Play[] {
  const raw = localStorage.getItem(KEY_PLAYS);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Play[]) : [];
    } catch {
      return [];
    }
  }
  const legacy = getHistory();
  if (!legacy.length) return [];
  const migrated = migrateLegacyHistory(legacy);
  savePlays(migrated);
  try { localStorage.removeItem(KEY_HISTORY); } catch { /* ignore */ }
  return migrated;
}

function savePlays(plays: Play[]): void {
  try {
    if (!writeMakingRoom(KEY_PLAYS, JSON.stringify(plays))) throw new Error("full");
  } catch {
    // Quota exceeded: drop the oldest half rather than losing the ledger.
    try {
      localStorage.setItem(KEY_PLAYS, JSON.stringify(plays.slice(-Math.floor(plays.length / 2))));
    } catch { /* give up; anti-repeat degrades, playback does not */ }
  }
}

export function recordHeardPlay(p: Play): void {
  savePlays(recordHeard(getPlays(), p));
}

// ---------------------------------------------------------------------------
// Per-episode resume positions (see positions.ts)
// ---------------------------------------------------------------------------

const KEY_POSITIONS = "sleepcast2.positions";

export function loadPositions(): Positions {
  try {
    const raw = localStorage.getItem(KEY_POSITIONS);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Positions) : {};
  } catch {
    return {};
  }
}

/** Store where the listener drifted off, if it's a point worth returning to. */
export function rememberPosition(id: string, positionSec: number, durationSec: number): void {
  if (!shouldRemember(positionSec, durationSec)) return;
  try {
    writeMakingRoom(
      KEY_POSITIONS,
      JSON.stringify(putPosition(loadPositions(), id, Math.floor(positionSec))),
    );
  } catch { /* a lost resume point is not worth throwing over */ }
}

/** Called when an episode plays to its end — there is nothing left to resume. */
export function forgetPosition(id: string): void {
  try {
    const p = loadPositions();
    if (!(id in p)) return;
    delete p[id];
    writeMakingRoom(KEY_POSITIONS, JSON.stringify(p));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Blocked episodes — "never again". The only negative control used to be
// disabling a whole feed, so one jarring episode in an archive of a thousand
// meant either tolerating it forever or losing the show.
// ---------------------------------------------------------------------------

const KEY_BLOCKED = "sleepcast2.blocked";
const BLOCKED_CAP = 500;

export function loadBlocked(): string[] {
  try {
    const raw = localStorage.getItem(KEY_BLOCKED);
    if (!raw) return [];
    const b = JSON.parse(raw);
    return Array.isArray(b) ? (b as string[]) : [];
  } catch {
    return [];
  }
}

export function isBlocked(id: string): boolean {
  return loadBlocked().includes(id);
}

export function blockEpisode(id: string): void {
  try {
    const b = loadBlocked();
    if (b.includes(id)) return;
    b.push(id);
    writeMakingRoom(KEY_BLOCKED, JSON.stringify(b.slice(-BLOCKED_CAP)));
  } catch { /* ignore */ }
}

export function unblockEpisode(id: string): void {
  try {
    writeMakingRoom(KEY_BLOCKED, JSON.stringify(loadBlocked().filter((x) => x !== id)));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Sleep timer persistence
// ---------------------------------------------------------------------------

export const TIMER_MIN = 5;
export const TIMER_MAX = 480;
const TIMER_DEFAULT = 30;

/** Keep a timer in the range the setup screen offers, in whole minutes. The
 *  one definition of that range: settings, the custom box and the legacy
 *  timer key all go through it. */
export function clampTimerMinutes(n: number): number {
  return Math.min(TIMER_MAX, Math.max(TIMER_MIN, Math.round(n)));
}

export function loadTimerMinutes(): number {
  try {
    const raw = localStorage.getItem(KEY_TIMER);
    if (!raw) return TIMER_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < TIMER_MIN || n > TIMER_MAX) {
      return TIMER_DEFAULT;
    }
    return n;
  } catch {
    // localStorage unavailable (privacy mode etc.)
    return TIMER_DEFAULT;
  }
}

export function saveTimerMinutes(minutes: number): void {
  const clamped = clampTimerMinutes(minutes);
  try {
    localStorage.setItem(KEY_TIMER, String(clamped));
  } catch {
    // localStorage unavailable or full — persisting the timer is a nicety
  }
}

// ---------------------------------------------------------------------------
// Feed XML cache — max 5 entries, evict oldest by stored timestamp
// ---------------------------------------------------------------------------

const CACHE_MAX = 5;

interface CacheEntry {
  at: number;
  xml: string;
}

function cacheKey(feedId: string): string {
  return `${CACHE_PREFIX}${feedId}`;
}

function allCacheKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(CACHE_PREFIX)) {
      keys.push(k);
    }
  }
  return keys;
}

function evictOldestCacheEntry(keys: string[]): void {
  // Find the entry with the smallest `at` timestamp
  let oldestKey = keys[0];
  let oldestAt = Infinity;
  for (const ck of keys) {
    try {
      const ce = JSON.parse(localStorage.getItem(ck)!) as CacheEntry;
      if (ce.at < oldestAt) {
        oldestAt = ce.at;
        oldestKey = ck;
      }
    } catch {
      // Corrupt entry — treat as eviction candidate with at=0
      oldestKey = ck;
      oldestAt = 0;
    }
  }
  localStorage.removeItem(oldestKey);
}

/**
 * Give up one cached feed to free room for something that matters more.
 * Returns false when there's nothing left to give.
 *
 * The whole origin shares ~5MB, and the feeds are the whale: the default set
 * runs 0.6–8.8MB EACH (Get Sleepy alone is bigger than the entire quota). So
 * a cached feed will happily fill the bucket and leave no room for a generated
 * story — which is the wrong way round. A feed is re-fetchable in seconds; a
 * story was written once, at temperature 0.8, and is gone forever. The cache is
 * an offline nicety and must yield to anything irreplaceable.
 */
export function evictOneFeedCache(): boolean {
  const keys = allCacheKeys();
  if (keys.length === 0) return false;
  evictOldestCacheEntry(keys);
  return true;
}

export function cacheFeedXml(feedId: string, xml: string): void {
  const k = cacheKey(feedId);
  const entry = JSON.stringify({ at: Date.now(), xml } satisfies CacheEntry);

  // Evict oldest if a new entry would pass the count cap
  const isNew = localStorage.getItem(k) === null;
  if (isNew) {
    const keys = allCacheKeys();
    if (keys.length >= CACHE_MAX) evictOldestCacheEntry(keys);
  }

  // The cache is an offline nicety. localStorage holds ~5MB and one big
  // feed can be megabytes, so the count cap alone can't prevent quota
  // errors — and a quota error here must never break feed loading. Evict
  // oldest entries and retry; if nothing is left to evict, skip caching.
  for (;;) {
    try {
      localStorage.setItem(k, entry);
      return;
    } catch {
      const others = allCacheKeys().filter((ck) => ck !== k);
      if (others.length === 0) return; // cache full of non-evictables: give up quietly
      evictOldestCacheEntry(others);
    }
  }
}

export function getCachedFeedXml(feedId: string): string | null {
  const raw = localStorage.getItem(cacheKey(feedId));
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as CacheEntry).xml;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3am re-arm — remember the last natural fade-out so the setup screen can
// offer a quick smaller resume
// ---------------------------------------------------------------------------

export const REARM_WINDOW_MS = 6 * 60 * 60 * 1000;

// Stamp the natural end of a session so the setup screen can offer a
// smaller re-arm to someone who wakes back up.
//
// This load-modify-save is only safe because SleepApp renders Player and
// SleepSetup mutually exclusively: when Player unmounts and SleepSetup
// mounts, SleepSetup re-reads state fresh, so it always sees this write. A
// layout where both were mounted at once could race SleepSetup's own
// in-memory state against this write and lose it.
export function recordSessionEnd(
  timerMinutes: number,
  modeKind: PlayMode["kind"]
): void {
  const s = loadState();
  s.settings.lastSession = { endedAt: Date.now(), timerMinutes, modeKind };
  saveState(s);
}

/** The mode to revive a snapshotted night in: its own timerless mode, or a
 *  timed night of its original length (remainingMs carries the time left). */
export function resumeMode(l: LiveSession): PlayMode {
  if (l.modeKind === "one-episode" || l.modeKind === "all-night") return { kind: l.modeKind };
  return { kind: "minutes", minutes: nightTimerMinutes(l) };
}

/**
 * localStorage.setItem that gives way to what matters. The feed-XML cache
 * fills storage until a write fails, so every other write routinely meets a
 * full quota: saveState threw (and endSession starts with it), while the
 * live snapshot, last night, plays, positions and the rest ledger were
 * silently lost. Cached feeds are re-fetchable; evict them one at a time and
 * retry. Returns false if the value still could not be written.
 */
export function writeMakingRoom(key: string, value: string): boolean {
  for (;;) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      if (!evictOneFeedCache()) return false;
    }
  }
}
