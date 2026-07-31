// Per-episode resume points.
//
// The player already snapshots the *live* night (store.ts saveLive), but that
// holds one position for the episode currently playing and dies when the night
// ends. So falling asleep twenty minutes into a ninety-minute story and asking
// for "the exact one again" tomorrow restarted it from the top.
//
// This is a separate, longer-lived map: episode id -> seconds.

export type Positions = Record<string, number>;

/** Below this, there is nothing worth resuming — you had barely started. */
export const MIN_POSITION_SEC = 60;

/** Within this of the end, resuming would drop you into the outro. */
export const END_MARGIN_SEC = 60;

/** Plenty for any real listener; keeps the JSON small. */
export const POSITIONS_CAP = 300;

/**
 * Whether a position is worth remembering. Duration may be NaN or 0 for a
 * stream whose metadata never arrived — that still deserves a resume point, so
 * only the floor applies in that case.
 */
export function shouldRemember(positionSec: number, durationSec: number): boolean {
  if (!Number.isFinite(positionSec) || positionSec < MIN_POSITION_SEC) return false;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return true;
  return positionSec < durationSec - END_MARGIN_SEC;
}

/**
 * Record a position, evicting the oldest-written entries at the cap.
 *
 * Insertion order is the eviction order: JS objects preserve string-key
 * insertion order, and re-recording an episode deletes and re-adds it, so a
 * position you keep updating stays fresh rather than ageing out.
 */
export function putPosition(positions: Positions, id: string, positionSec: number): Positions {
  const next: Positions = { ...positions };
  delete next[id]; // re-insert so this becomes the newest entry
  next[id] = positionSec;
  const keys = Object.keys(next);
  if (keys.length > POSITIONS_CAP) {
    for (const k of keys.slice(0, keys.length - POSITIONS_CAP)) delete next[k];
  }
  return next;
}
