import type { Episode } from "../engine";
import type { LastNight } from "../store";

// A faded night can offer a re-anchor for this long after it ended.
export const REANCHOR_WINDOW_MS = 6 * 60 * 60 * 1000;

// First pool episode not yet heard this night and not blocked (an episode
// can be blocked mid-night and stay in the saved pool); null if the spread is
// spent.
export function nextInSpread(pool: Episode[], playedIds: string[], blocked: readonly string[] = []): Episode | null {
  const skip = new Set([...playedIds, ...blocked]);
  for (const e of pool) {
    if (!skip.has(e.id)) return e;
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
  blocked?: () => readonly string[]; // episodes never to offer (loadBlocked), read only if needed
}

// The episode to re-anchor on, only when the user reopened in the dark, soon
// after a night that faded, with something left to play; else null.
// Deliberately conservative — a re-anchor at the wrong moment is worse than
// none.
export function reanchorNext({ lastNight, now, localHour, blocked = () => [] }: ReanchorInput): Episode | null {
  if (!lastNight) return null;
  if (lastNight.endedVia !== "faded") return null;
  if (now - lastNight.endedAt >= REANCHOR_WINDOW_MS) return null;
  if (!inNightHours(localHour)) return null;
  return nextInSpread(lastNight.pool, lastNight.playedIds, blocked());
}
