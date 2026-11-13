// What a show page shows beyond titles: how long an episode runs, a few
// lines on it, and who makes the show. All read from the feed already
// fetched, so nothing new is sent anywhere.

/** <itunes:duration> as seconds: "1:02:03", "62:03" or "3723". Null when
 *  it's missing or not a length. */
export function parseItunesDuration(raw: string | null | undefined): number | null {
  const s = raw?.trim();
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const sec = parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  return sec > 0 ? Math.round(sec) : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", mdash: "—", ndash: "–" };

/** A feed's HTML-ish description as plain text, cut to `max` characters on
 *  a word. String work, not a DOM: a feed can carry thousands of these. */
export function plainText(raw: string | null | undefined, max: number): string {
  if (!raw) return "";
  const text = raw
    .slice(0, max * 8)
    .replace(/<[^>]*>?/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    })
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:!?])/g, "$1")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

/** "24 min", "1 hr 5 min". */
export function formatLength(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60), rest = m % 60;
  return rest ? `${h} hr ${rest} min` : `${h} hr`;
}

/** The typical episode length, for a show's summary line: the median of the
 *  episodes whose length the feed gives. */
export function typicalLength(durations: (number | undefined)[]): number | null {
  const known = durations.filter((d): d is number => typeof d === "number" && d > 0).sort((a, b) => a - b);
  if (!known.length) return null;
  const mid = Math.floor(known.length / 2);
  return known.length % 2 ? known[mid] : (known[mid - 1] + known[mid]) / 2;
}

export type EpisodeOrder = "newest" | "longest" | "unplayed";

/** A show's episodes in the order picked. The feed's own order is newest
 *  first; "longest" puts unknown lengths last, "unplayed" leaves out what
 *  you've heard or went under in. Stable, so ties keep the feed's order. */
export function orderEpisodes<T extends { id: string; durationSec?: number }>(
  episodes: T[],
  order: EpisodeOrder,
  heard: Set<string>,
  positions: Record<string, number>,
): T[] {
  if (order === "longest") {
    return episodes
      .map((ep, i) => ({ ep, i }))
      .sort((a, b) => (b.ep.durationSec ?? -1) - (a.ep.durationSec ?? -1) || a.i - b.i)
      .map(({ ep }) => ep);
  }
  if (order === "unplayed") return episodes.filter((ep) => !heard.has(ep.id) && !(positions[ep.id] > 0));
  return episodes;
}

/** The episodes whose title or notes contain every word of `query`, in any
 *  case; all of them for a blank query. */
export function searchEpisodes<T extends { id: string; title: string }>(
  episodes: T[],
  notes: Record<string, string>,
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return episodes;
  return episodes.filter((ep) => {
    const hay = `${ep.title}\n${notes[ep.id] ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
