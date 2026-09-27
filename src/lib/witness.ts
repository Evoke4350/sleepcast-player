// Has this episode actually made a sound?
//
// A player's own "playing" is not proof. An audio element reads "playing" over
// a stream that has hung; an embed keeps reporting the PREVIOUS video's state
// and time for a while after a switch. The one reading that can't lie is the
// position moving the way playback moves. Night and YouTubeNight both decide
// "played" with this, so the rule can't drift between them.

/**
 * Whether going from `prevPos` (seen at `prevAt`, 0 = no earlier look) to
 * `pos` (at `now`) is playback rather than a seek or a stale reading:
 *
 *  - forward, and no faster than the wall clock (plus slack) — a seek jumps;
 *    a fixed cap would miss real playback when background ticks are throttled
 *    a minute apart;
 *  - not a jump ONTO the requested start from somewhere else — that is the
 *    start seek landing (from 0 before metadata, or from the previous video's
 *    leftover position), which with throttled ticks can fit under the cap.
 *
 * A leftover reading from the previous episode doesn't move, so it never
 * counts.
 */
export function isPlaybackStep(prevPos: number, prevAt: number, pos: number, now: number, startSec: number): boolean {
  const step = pos - prevPos;
  if (!(step > 0)) return false;
  const wallSec = prevAt > 0 ? (now - prevAt) / 1000 : 1;
  if (step > wallSec + 2) return false;
  const landsOnStart = startSec > 1 && Math.abs(pos - startSec) < 1.5 && Math.abs(prevPos - startSec) >= 1.5;
  return !landsOnStart;
}
