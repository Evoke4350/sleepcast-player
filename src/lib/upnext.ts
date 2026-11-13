// Up next: episodes you asked for by name, played before the shuffle picks.
//
// A short list, oldest first. "Play next" on an episode adds it; the player
// takes the first one each time it needs an episode (the start of a night
// with nothing else to lead it, and every Next after that), and the shuffle
// only runs once the list is empty. Kept across reloads, so a night queued
// up in the evening survives the phone locking.
import type { Episode } from "./engine";
import { writeMakingRoom } from "./store";

const KEY = "sleepcast2.upnext";
/** More than this is a playlist, not "next"; the oldest go. */
export const UP_NEXT_CAP = 20;

export function loadUpNext(): Episode[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as Episode[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(eps: Episode[]): void {
  try {
    if (eps.length) writeMakingRoom(KEY, JSON.stringify(eps.slice(-UP_NEXT_CAP)));
    else localStorage.removeItem(KEY);
  } catch {
    /* quota / private mode: the shuffle picks instead */
  }
}

/** Add to the end; an episode already queued moves to the end. */
export function addUpNext(ep: Episode): Episode[] {
  const next = [...loadUpNext().filter((e) => e.id !== ep.id), ep];
  save(next);
  return next;
}

export function removeUpNext(id: string): Episode[] {
  const next = loadUpNext().filter((e) => e.id !== id);
  save(next);
  return next;
}

/** The first queued episode not in `skip` (blocked, or playing now), taken
 *  off the list along with any skipped ones before it; null if none. */
export function takeUpNext(skip: ReadonlySet<string> = new Set()): Episode | null {
  const queue = loadUpNext();
  const i = queue.findIndex((e) => !skip.has(e.id));
  if (i < 0) {
    if (queue.length) save([]);
    return null;
  }
  save(queue.slice(i + 1));
  return queue[i];
}

/** Whether `id` is queued. */
export function isUpNext(id: string): boolean {
  return loadUpNext().some((e) => e.id === id);
}
