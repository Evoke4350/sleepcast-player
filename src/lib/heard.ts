// Time actually spent listening, from successive position readings.
//
// Shared by all three players, so the rule can't drift between them.

/** The listening between two readings: a forward step under 5 s. Anything
 *  else is a seek, a new load or a stale reading, not time anyone heard;
 *  and so is everything while a start seek is still being enforced (its
 *  retries and its landing step the position forward in small jumps). */
export function heardDelta(prevSec: number, curSec: number, seeking: boolean): number {
  const delta = curSec - prevSec;
  return !seeking && delta > 0 && delta < 5 ? delta : 0;
}
