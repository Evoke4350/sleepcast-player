export interface Episode { id: string; title: string; url: string; feedId: string; date: string; }
export interface Feed { id: string; title: string; episodes: Episode[]; artwork?: string; }

export type PlayMode =
  | { kind: "minutes"; minutes: number }
  | { kind: "one-episode" }
  | { kind: "all-night" };

export function fadeVolume(remainingSeconds: number, fadeSeconds: number): number {
  if (remainingSeconds >= fadeSeconds) return 1;
  if (remainingSeconds <= 0) return 0;
  return remainingSeconds / fadeSeconds;
}

export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// Channel artwork: <itunes:image href> (any namespace prefix — DOMParser on
// feeds without the xmlns declared still yields localName "image") wins over
// legacy <image><url>. Walk direct channel children only, so per-item images
// and a prefix-less selector matching itunes:image can't cross wires.
function extractArtwork(doc: Document): string | undefined {
  const channel = doc.querySelector("channel");
  if (!channel) return undefined;
  let legacyUrl: string | undefined;
  for (const el of Array.from(channel.children)) {
    if (el.localName !== "image") continue;
    const href = el.getAttribute("href")?.trim();
    if (href) return href;
    legacyUrl ||= el.querySelector("url")?.textContent?.trim() || undefined;
  }
  return legacyUrl;
}

export function parseFeedXml(xmlText: string, feedId: string): Feed {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  const title = doc.querySelector("channel > title")?.textContent?.trim() ?? "feed";
  const episodes: Episode[] = [];
  for (const item of doc.querySelectorAll("item")) {
    const url = item.querySelector("enclosure")?.getAttribute("url");
    if (!url) continue;
    episodes.push({
      id: item.querySelector("guid")?.textContent?.trim() || url,
      title: item.querySelector("title")?.textContent?.trim() ?? "untitled",
      url,
      feedId,
      date: item.querySelector("pubDate")?.textContent ?? "",
    });
  }
  return { id: feedId, title, episodes, artwork: extractArtwork(doc) };
}

// Deterministic-ish diverse pick without embeddings: spread selections across
// feed × publication-year buckets. The fallback for devices whose WASM can't
// run the semantic model (e.g. iOS Lockdown Mode).
export function diverseByMeta(episodes: Episode[], n: number, rand: () => number = Math.random): Episode[] {
  if (episodes.length <= n) return [...episodes];
  const buckets = new Map<string, Episode[]>();
  for (const ep of episodes) {
    const year = ep.date ? String(new Date(ep.date).getFullYear()) : "";
    const key = `${ep.feedId}|${year}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(ep);
  }
  const keys = [...buckets.keys()].sort(() => rand() - 0.5);
  const picks: Episode[] = [];
  let i = 0;
  while (picks.length < n && keys.length) {
    const bucket = buckets.get(keys[i % keys.length])!;
    if (bucket.length) {
      picks.push(bucket.splice(Math.floor(rand() * bucket.length), 1)[0]);
    } else {
      keys.splice(i % keys.length, 1);
      continue;
    }
    i++;
  }
  return picks;
}

// Fade × per-feed trim, clamped to what an <audio> element accepts.
export function effectiveVolume(
  remainingSeconds: number,
  fadeSeconds: number,
  trim: number
): number {
  const v = fadeVolume(remainingSeconds, fadeSeconds) * trim;
  return Math.min(1, Math.max(0, v));
}

// Half the previous timer, rounded to 5, never under 10 — the 3am dose.
export function rearmMinutes(previousMinutes: number): number {
  return Math.max(10, Math.round(previousMinutes / 2 / 5) * 5);
}

// Seconds driving the fade this tick. Infinity means "no fade underway".
export function fadeDriverSeconds(
  mode: PlayMode["kind"],
  timerRemaining: number,
  episodeRemaining: number | null
): number {
  if (mode === "minutes") return timerRemaining;
  if (mode === "one-episode") return episodeRemaining ?? Infinity;
  return Infinity;
}
