// Episodes kept on the device ahead of any night: "keep the latest 3 of
// this show", and single episodes saved by hand.
//
// Both become pins on the offline cache (offline-audio.ts pin()): the
// night's own two episodes come and go around them. The per-show number
// lives in settings (store.ts feedKeep), so a backup carries it; the saved
// files and the by-hand list are this device's, and stay here.
import type { Episode } from "./engine";
import { canSave } from "./offline-audio";

/** How many of a show's newest episodes to keep; 0 is off. */
export const KEEP_CHOICES = [0, 3, 5, 10] as const;

const MANUAL_KEY = "sleepcast2.saved";

/** Episodes saved by hand, by URL. */
export function loadManualSaves(): string[] {
  try {
    const raw = localStorage.getItem(MANUAL_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Save it, or stop keeping it. Returns whether it is saved now. */
export function toggleManualSave(url: string): boolean {
  const had = loadManualSaves();
  const next = had.includes(url) ? had.filter((u) => u !== url) : [...had, url];
  try {
    if (next.length) localStorage.setItem(MANUAL_KEY, JSON.stringify(next));
    else localStorage.removeItem(MANUAL_KEY);
  } catch {
    /* quota / private mode */
  }
  return next.includes(url);
}

const timeOf = (ep: Pick<Episode, "date">): number => {
  const t = Date.parse(ep.date);
  return Number.isFinite(t) ? t : 0;
};

/** A show's newest `n` savable episodes, newest first. */
export function latestToKeep<T extends Pick<Episode, "url" | "date">>(episodes: readonly T[], n: number): T[] {
  if (n <= 0) return [];
  return [...episodes]
    .filter(canSave)
    .sort((a, b) => timeOf(b) - timeOf(a))
    .slice(0, n);
}

/**
 * Every URL to keep: what was saved by hand first (asked for by name), then
 * each show's latest. No URL twice.
 */
export function pinnedUrls(
  keep: Record<string, number>,
  episodesByFeed: Record<string, readonly Pick<Episode, "url" | "date">[] | undefined>,
  manual: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (u: string) => { if (!seen.has(u)) { seen.add(u); out.push(u); } };
  for (const u of manual) add(u);
  for (const [feedId, n] of Object.entries(keep)) {
    for (const ep of latestToKeep(episodesByFeed[feedId] ?? [], n)) add(ep.url);
  }
  return out;
}

/** feedId → count, keeping only the choices the control offers (0 is
 *  absent), so a stored value can't ask for something it can't show. */
export function sanitizeKeep(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && v !== 0 && (KEEP_CHOICES as readonly number[]).includes(v)) out[k] = v;
    }
  }
  return out;
}
