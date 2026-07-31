import type { Episode } from "../engine";
import type { LastNight } from "../store";

// A faded night can offer a re-anchor for this long after it ended.
export const REANCHOR_WINDOW_MS = 6 * 60 * 60 * 1000;

// First pool episode not yet heard this night; null if the spread is spent.
export function nextInSpread(pool: Episode[], playedIds: string[]): Episode | null {
  const played = new Set(playedIds);
  for (const e of pool) {
    if (!played.has(e.id)) return e;
  }
  return null;
}

// Night hours wrap midnight: 21:00–05:59 local.
function inNightHours(localHour: number): boolean {
  return localHour >= 21 || localHour < 6;
}

export interface ReanchorInput {
  lastNight: LastNight | null;
  now: number; // Date.now()
  localHour: number; // 0–23, viewer's local hour
}

// True only when the user reopened in the dark, soon after a night that faded,
// with something left to play. Deliberately conservative — a re-anchor at the
// wrong moment is worse than none.
export function shouldReanchor({ lastNight, now, localHour }: ReanchorInput): boolean {
  if (!lastNight) return false;
  if (lastNight.endedVia !== "faded") return false;
  if (now - lastNight.endedAt >= REANCHOR_WINDOW_MS) return false;
  if (!inNightHours(localHour)) return false;
  return nextInSpread(lastNight.pool, lastNight.playedIds) !== null;
}
