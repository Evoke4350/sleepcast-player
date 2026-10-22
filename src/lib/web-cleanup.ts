// Clears what the web player's removed features left in storage (redesign
// phase 2: YouTube and mixed nights, skip-intro, varied mix, Drift), once,
// as the player loads, before anything reads it:
//
//   - YouTube feeds go from the feed list (they parse to no episodes now),
//     and YouTube episodes from the saved night, last night and the last
//     episode (the player can't play them);
//   - skip-intro minutes go everywhere they were stored (the setting is gone,
//     and nothing could clear them);
//   - the title vectors and Drift's keys go (nothing reads them, and they
//     hold quota the night's own writes need).
//
// Web only: the native app keeps its own storage and its own YouTube night.

const DONE_KEY = "sleepcast2.cleanup";
const DONE = "2026-10-phase2";

type Json = Record<string, unknown>;

function read(key: string): Json | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

function write(key: string, v: Json): void {
  localStorage.setItem(key, JSON.stringify(v));
}

/** Whether a feed URL is a YouTube channel or playlist (as it was added). */
export function isYouTubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

const isVideo = (e: unknown) => !!e && typeof e === "object" && "youtubeId" in e && !!(e as Json).youtubeId;

/** A stored night (live snapshot or last night) without its videos or its
 *  skip-intro map; null when nothing playable is left. */
function cleanNight(n: Json): Json | null {
  const pool = Array.isArray(n.pool) ? n.pool.filter((e) => !isVideo(e)) : n.pool;
  if (Array.isArray(pool) && pool.length === 0) return null;
  if (isVideo(n.current)) return null;
  return { ...n, pool, skipIntroByFeedId: {} };
}

export function cleanStoredWebData(): void {
  try {
    if (localStorage.getItem(DONE_KEY) === DONE) return;
    const state = read("sleepcast2.state");
    if (state && Array.isArray(state.feeds)) {
      const feeds = state.feeds
        .filter((f) => !(f && typeof f === "object" && typeof (f as Json).url === "string" && isYouTubeUrl((f as Json).url as string)))
        .map((f) => (f && typeof f === "object" ? { ...(f as Json), skipIntroMin: 0 } : f));
      write("sleepcast2.state", { ...state, feeds });
    }
    for (const key of ["sleepcast2.live", "sleepcast2.lastnight"]) {
      const night = read(key);
      if (!night) continue;
      const cleaned = cleanNight(night);
      if (cleaned) write(key, cleaned);
      else localStorage.removeItem(key);
    }
    const lastEpisode = read("sleepcast2.lastep");
    if (lastEpisode && isVideo(lastEpisode)) localStorage.removeItem("sleepcast2.lastep");
    for (const key of ["sleepcast2.titlevecs", "drift.best", "drift.bowl"]) localStorage.removeItem(key);
    localStorage.setItem(DONE_KEY, DONE);
  } catch {
    /* blocked or full storage: tried again on the next load */
  }
}
