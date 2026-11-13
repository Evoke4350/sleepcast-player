// Finding a podcast by name: the words go to /api/search on this site,
// which asks Apple's directory and hands back the shows (worker/search.ts).
// Nothing but the typed words leaves the device, and only through
// sleepcast.pro, which doesn't log them.

export interface FoundShow {
  title: string;
  author: string;
  feedUrl: string;
  art?: string;
  episodes?: number;
}

/** Fewer characters than this isn't a search yet. */
export const SEARCH_MIN_CHARS = 2;

export async function searchPodcasts(query: string, signal?: AbortSignal): Promise<FoundShow[]> {
  const q = query.trim().replace(/\s+/g, " ");
  if (q.length < SEARCH_MIN_CHARS) return [];
  const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal });
  if (resp.status === 429) throw new Error("Too many searches at once. Try again in a minute.");
  if (!resp.ok) throw new Error("Couldn't reach the podcast directory.");
  const hits = (await resp.json()) as unknown;
  return Array.isArray(hits) ? (hits as FoundShow[]) : [];
}
