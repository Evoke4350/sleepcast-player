// Finding the episode you half-remember.
//
// Deliberately literal rather than semantic. There is a MiniLM in this codebase
// and rankBySimilarity has sat unused waiting for exactly this feature, but
// semantic search would mean downloading a 23MB model at bedtime to find a word
// that is already sitting in the title. Someone typing "train" at 2am wants the
// one with "train" in it, immediately, offline, on a phone.
//
// If literal search turns out not to be enough, the embeddings are still there.

export interface Searchable {
  title: string;
}

/** Lowercase, strip punctuation, collapse whitespace. Applied to both the
 *  query and the titles so neither side has to be typed accurately. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Episodes whose titles contain every word of the query, best first.
 *
 * Every word rather than any word: "night train" should find the one episode
 * about a night train, not every episode with "night" in it. On an archive of
 * a thousand titles, OR-matching returns everything and is useless.
 */
export function searchEpisodes<E extends Searchable>(
  pool: E[],
  query: string,
  limit: number,
): E[] {
  const q = normalize(query);
  if (!q) return [];
  const words = q.split(" ");

  const scored: { item: E; score: number; title: string }[] = [];

  for (const item of pool) {
    const title = normalize(item.title);
    if (!words.every((w) => title.includes(w))) continue;

    let score = 0;
    if (title === q) score += 1000;          // exactly what they typed
    else if (title.startsWith(q)) score += 500; // the title leads with it
    else if (title.includes(q)) score += 200;   // the whole phrase, mid-title

    // Words landing at the start of a word beat matches buried inside one:
    // "time" in "Timetables" is a better hit than in "sometimes".
    for (const w of words) {
      if (new RegExp(`(^| )${w}`).test(title)) score += 50;
    }

    // Shorter titles win ties. A title that is mostly the query is a more
    // specific answer than a long one that merely contains it.
    score += Math.max(0, 60 - title.length) / 10;

    scored.push({ item, score, title });
  }

  scored.sort(
    (a, b) => b.score - a.score || a.title.length - b.title.length || a.title.localeCompare(b.title),
  );
  return scored.slice(0, limit).map((s) => s.item);
}
