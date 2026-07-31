import type { Episode } from "./engine";
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

export interface Settings {
  timerMinutes: number;
  /** Opt-in stimulus control: stop and suggest getting up after a restless
   *  stretch. Off unless the listener asks for it — see rest/quarterhour.ts. */
  quarterHourRule: boolean;
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

function defaultState(): AppState {
  return {
    feeds: BUILTIN_FEEDS.map(defaultFeedRef),
    settings: { timerMinutes: 45, quarterHourRule: false },
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

  const settings: Settings = {
    timerMinutes:
      typeof saved.settings?.timerMinutes === "number"
        ? saved.settings.timerMinutes
        : 45,
    quarterHourRule: saved.settings?.quarterHourRule === true,
  };

  return { feeds: mergedFeeds, settings };
}

export function saveState(s: AppState): void {
  localStorage.setItem(KEY_STATE, JSON.stringify(s));
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
}

const LIVE_POOL_CAP = 80;

export function saveLive(s: LiveSession): void {
  // Keep the current episode plus a bounded remainder — enough to keep the
  // shuffle going after a resume without serialising thousands of episodes.
  const rest = s.pool.filter((e) => e.id !== s.current.id).slice(0, LIVE_POOL_CAP - 1);
  const bounded: LiveSession = { ...s, pool: [s.current, ...rest] };
  try {
    localStorage.setItem(KEY_LIVE, JSON.stringify(bounded));
  } catch {
    // Quota or private mode: a lost resume is not worth throwing over.
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
    localStorage.setItem(KEY_LASTEP, JSON.stringify(ep));
  } catch {
    /* ignore */
  }
}

export function loadLastEpisode(): Episode | null {
  try {
    const raw = localStorage.getItem(KEY_LASTEP);
    if (!raw) return null;
    const ep = JSON.parse(raw) as Episode;
    return ep && ep.url ? ep : null;
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
    localStorage.setItem(KEY_LASTNIGHT, JSON.stringify(bounded));
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
  title?: string
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
    enabled: true,
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
    localStorage.setItem(KEY_PLAYS, JSON.stringify(plays));
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
    localStorage.setItem(
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
    localStorage.setItem(KEY_POSITIONS, JSON.stringify(p));
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
    localStorage.setItem(KEY_BLOCKED, JSON.stringify(b.slice(-BLOCKED_CAP)));
  } catch { /* ignore */ }
}

export function unblockEpisode(id: string): void {
  try {
    localStorage.setItem(KEY_BLOCKED, JSON.stringify(loadBlocked().filter((x) => x !== id)));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Sleep timer persistence
// ---------------------------------------------------------------------------

const TIMER_MIN = 5;
const TIMER_MAX = 480;
const TIMER_DEFAULT = 30;

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
  const clamped = Math.min(TIMER_MAX, Math.max(TIMER_MIN, minutes));
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
