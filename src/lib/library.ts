// The Podcasts tab's list of your shows: which to show, in what order, and
// the episodes to jump back into. Pure, apart from remembering grid or list.

import type { Episode } from "./engine";

export type LibraryFilter = "all" | "on" | "off";
export type LibrarySort = "recent" | "az";
export type LibraryView = "list" | "grid";

/** When each show last started playing, by feed id. */
export function lastPlayedByFeed(plays: readonly { feedId: string; startedAt: number }[]): Record<string, number> {
  const last: Record<string, number> = {};
  for (const p of plays) if (!(p.startedAt <= (last[p.feedId] ?? -Infinity))) last[p.feedId] = p.startedAt;
  return last;
}

// "The Sleepy Bookshelf" files under S, as a shelf would.
const sortTitle = (t: string) => t.replace(/^(the|a|an)\s+/i, "");

/** Your shows, filtered by whether they're in the shuffle and sorted by
 *  when you last played them (never played keep their order, after) or by
 *  title. */
export function arrangeShows<T extends { id: string; title: string; enabled: boolean }>(
  feeds: readonly T[],
  filter: LibraryFilter,
  sort: LibrarySort,
  lastPlayed: Record<string, number>,
): T[] {
  const kept = feeds.filter((f) => filter === "all" || (filter === "on") === f.enabled);
  if (sort === "az") {
    return [...kept].sort((a, b) => sortTitle(a.title).localeCompare(sortTitle(b.title), undefined, { sensitivity: "base" }));
  }
  return kept
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (lastPlayed[b.f.id] ?? -1) - (lastPlayed[a.f.id] ?? -1) || a.i - b.i)
    .map(({ f }) => f);
}

/** Episodes you went under in, the most recently played first: what the
 *  tab offers to pick back up. Only episodes the loaded feeds still list. */
export function jumpBackIn(
  episodes: readonly Episode[],
  positions: Record<string, number>,
  plays: readonly { id: string; startedAt: number }[],
  max = 8,
): Episode[] {
  const lastPlay: Record<string, number> = {};
  for (const p of plays) if (!(p.startedAt <= (lastPlay[p.id] ?? -Infinity))) lastPlay[p.id] = p.startedAt;
  const seen = new Set<string>();
  return episodes
    .filter((ep) => (positions[ep.id] ?? 0) > 0 && !seen.has(ep.id) && seen.add(ep.id))
    .sort((a, b) => (lastPlay[b.id] ?? -1) - (lastPlay[a.id] ?? -1))
    .slice(0, max);
}

const VIEW_KEY = "sleepcast2.libraryView";

/** Grid or list, as last picked on this device. A convenience: not in a
 *  backup, and list when storage can't be read. */
export function loadLibraryView(): LibraryView {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function saveLibraryView(view: LibraryView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Private mode or full: it's only a preference.
  }
}
