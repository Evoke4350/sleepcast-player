// "2 new": episodes a show has put out since you last opened it.
//
// One mark per show: the date of its newest episode when its page was last
// opened. Anything dated after the mark is new. A show never opened has no
// mark and nothing new: the first look at a library seeds the marks, so a
// fresh install doesn't start with every show shouting.
import type { Episode } from "./engine";
import { writeMakingRoom } from "./store";

const KEY = "sleepcast2.seen";
export type Seen = Record<string, number>;

export function loadSeen(): Seen {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Seen) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function save(seen: Seen): void {
  try {
    writeMakingRoom(KEY, JSON.stringify(seen));
  } catch {
    /* quota / private mode: no badges, nothing worse */
  }
}

const timeOf = (ep: Pick<Episode, "date">): number => {
  const t = Date.parse(ep.date);
  return Number.isFinite(t) ? t : 0;
};

/** The newest episode's time, 0 for none (or none dated). */
export function newestOf(episodes: readonly Pick<Episode, "date">[]): number {
  return episodes.reduce((m, e) => Math.max(m, timeOf(e)), 0);
}

/** How many are newer than the show's mark; 0 for a show without one. */
export function newCount(feedId: string, episodes: readonly Pick<Episode, "date">[], seen: Seen): number {
  const mark = seen[feedId];
  if (mark === undefined) return 0;
  return episodes.filter((e) => timeOf(e) > mark).length;
}

/** Whether one episode is newer than the show's mark. */
export function isNew(ep: Pick<Episode, "date">, mark: number | undefined): boolean {
  return mark !== undefined && timeOf(ep) > mark;
}

/** The show was opened: its newest episode is the mark from now on. */
export function markSeen(feedId: string, episodes: readonly Pick<Episode, "date">[]): void {
  if (!episodes.length) return;
  save({ ...loadSeen(), [feedId]: newestOf(episodes) });
}

/** Marks for shows that have none, from what's loaded: nothing is new on
 *  the first look. Returns whether anything was written. */
export function seedSeen(loaded: Record<string, readonly Pick<Episode, "date">[] | undefined>): boolean {
  const seen = loadSeen();
  let changed = false;
  for (const [feedId, episodes] of Object.entries(loaded)) {
    if (seen[feedId] !== undefined || !episodes?.length) continue;
    seen[feedId] = newestOf(episodes);
    changed = true;
  }
  if (changed) save(seen);
  return changed;
}
