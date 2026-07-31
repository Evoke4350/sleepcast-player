// The play ledger — what you actually listened to, and for how long.
//
// Replaces the old `sleepcast2.history`: 25 bare episode ids, shared across
// every feed, written the instant a track *started*. Against a Sleep With Me
// archive of ~1000 episodes that filtered about 2.5% of the pool, so a nightly
// listener heard repeats constantly, and a track skipped after three seconds
// burned one of the 25 slots.
//
// Everything here is local. Titles are stored so the app can show you what
// played last night; nothing in this file leaves the device or touches the
// aggregate server counters.

export interface Play {
  id: string; // episode guid or url
  title: string;
  feedId: string;
  startedAt: number; // epoch ms
  heardSec: number; // real playback, not wall clock
}

/** Playback needed before an episode counts as heard. Long enough that a
 *  skipped intro or a jarring ad-read doesn't retire the episode, short enough
 *  that anything you drifted into is remembered. */
export const HEARD_SEC = 120;

/** ~200KB at this size. localStorage allows 5-10MB, and the title-vector cache
 *  already holds 6000 entries. At ~3 episodes a night this is ~2 years. */
export const PLAYS_CAP = 2000;

/** Keep at least this share of the pool pickable. Below it, the oldest-heard
 *  episodes are allowed back rather than dead-ending. */
export const FRESH_FLOOR = 0.2;

/**
 * Record an episode as heard, newest last. A repeat listen replaces the earlier
 * entry instead of duplicating it, so the ledger holds distinct episodes and
 * the cap counts episodes rather than listens.
 */
export function recordHeard(plays: Play[], p: Play, cap = PLAYS_CAP): Play[] {
  const next = plays.filter((x) => x.id !== p.id);
  next.push(p);
  return next.slice(-cap);
}

/**
 * Convert the legacy bare-id history. The entries get startedAt 0 so they sort
 * as the oldest thing in the ledger and are the first to be recycled — we don't
 * know when they were heard, and pretending they were recent would suppress
 * episodes for no reason.
 */
export function migrateLegacyHistory(ids: string[]): Play[] {
  return ids.map((id) => ({ id, title: "", feedId: "", startedAt: 0, heardSec: 0 }));
}

/**
 * Choose the next episode: unheard first, and when unheard material runs low,
 * the *oldest*-heard episodes come back before newer ones.
 *
 * The old pickRandomEpisode fell back to the entire pool the moment its filter
 * emptied, which made the episode heard ten minutes ago exactly as likely as
 * one heard a year ago. Degrading through the oldest-heard keeps the night
 * moving without ever feeling like it repeated itself.
 */
export function pickNextEpisode<E extends { id: string }>(
  episodes: E[],
  plays: Play[],
  rand: () => number = Math.random,
): E | null {
  if (!episodes.length) return null;

  const heardAt = new Map(plays.map((p) => [p.id, p.startedAt]));
  const candidates = episodes.filter((e) => !heardAt.has(e.id));

  // Enough of the pool must stay pickable that a full ledger is not a dead end.
  const floor = Math.max(1, Math.ceil(episodes.length * FRESH_FLOOR));
  if (candidates.length < floor) {
    const recycled = episodes
      .filter((e) => heardAt.has(e.id))
      .sort((a, b) => heardAt.get(a.id)! - heardAt.get(b.id)!)
      .slice(0, floor - candidates.length);
    candidates.push(...recycled);
  }

  return candidates[Math.floor(rand() * candidates.length)] ?? null;
}

/** Plays that began at or after a cutoff, oldest first — i.e. one night's worth. */
export function playsSince(plays: Play[], fromMs: number): Play[] {
  return plays.filter((p) => p.startedAt >= fromMs).sort((a, b) => a.startedAt - b.startedAt);
}

/** The play that was running at a given instant, or null if none had started. */
export function playAtMoment(plays: Play[], atMs: number): Play | null {
  let best: Play | null = null;
  for (const p of plays) {
    if (p.startedAt <= atMs && (!best || p.startedAt > best.startedAt)) best = p;
  }
  return best;
}
