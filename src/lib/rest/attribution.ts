// Attribution: which show was playing at a night's onset, for the
// detector's onset (RestSession.finish) and the watch's (watch.ts) alike,
// and re-timing a night to a watch onset. Pure, over a RestNight: the
// ledger (merging a night recorded twice), the session and the watch import
// all use it without depending on one another.
import type { RestNight, TimelineEntry } from "./types";

/** What was playing at an onset `atMs` (from the night's start), and which
 *  feeds played on after it: the onset fields of a RestNight, for the
 *  detector's onset (finish) and the watch's alike (watch.ts). None for no
 *  onset. `timeline` in time order: finish sorts it, and stores it so.
 *  Spread rather than assigned: an absent field and an empty array must not
 *  become two shapes in a ledger that already holds 90 nights without them.
 *  The timeline knows episode starts, not pauses: an onset during a pause
 *  credits the paused episode (spec §6). */
export function attribution(
  timeline: readonly TimelineEntry[],
  atMs: number | null,
): Pick<RestNight, "onsetFeedId" | "onsetEpisodeId" | "onsetAfterMs" | "sleptThrough"> {
  if (atMs === null) return {};
  const at = timeline.filter((e) => e.t <= atMs).at(-1);
  const sleptThrough = [...new Set(timeline.filter((e) => e.t > atMs).map((e) => e.feedId))];
  return {
    // at.t is when the credited feed itself started, so atMs - at.t is how
    // long *it* had been playing — not timeToSleepMs, which is measured from
    // night start regardless of how much got skipped first.
    ...(at ? { onsetFeedId: at.feedId, onsetEpisodeId: at.episodeId, onsetAfterMs: atMs - at.t } : {}),
    ...(sleptThrough.length ? { sleptThrough } : {}),
  };
}

/** Whether an onset `atMs` (from the night's start) came after the night
 *  ended: the audio had stopped, and nothing was observed by then. Unknown
 *  (no endedAt, older nights) is taken as no. */
export function onsetAfterEnd(n: RestNight, atMs: number): boolean {
  return n.endedAt !== undefined && n.startedAt + atMs > n.endedAt;
}

/** A night re-timed by the watch's onset `atMs`, or null for none (the
 *  watch had the listener asleep at its start: the detector's guess is
 *  ruled out, and kept only as inferredAtMs). Attribution comes from the
 *  night's timeline when it covers the onset; an onset after the night
 *  ended credits nothing (the audio had stopped). A timeline that starts
 *  after the onset (a night revived after a reload notes only what played
 *  since) can't say what was playing then, and would credit every show
 *  after the reload as slept through: it is no timeline. Without one, any
 *  attribution the night had is dropped: it was for a different onset
 *  (applyWatch never re-times a night to the onset it already has). A
 *  "slept" or "awake" label was on the detector's claim, which the watch
 *  replaces. */
export function retimed(n: RestNight, atMs: number | null): RestNight {
  const inferredAtMs = n.detector === "watch" ? (n.inferredAtMs ?? null) : n.sleptAtMs;
  const { selfLabel: _l, onsetFeedId: _f, onsetEpisodeId: _e, onsetAfterMs: _a, sleptThrough: _s, ...base } = n;
  const covering = atMs !== null && n.timeline?.some((e) => e.t <= atMs) ? n.timeline : undefined;
  return {
    ...base,
    sleptAtMs: atMs,
    timeToSleepMs: atMs,
    detector: "watch",
    inferredAtMs,
    ...(atMs !== null && !onsetAfterEnd(n, atMs) && covering ? attribution(covering, atMs) : {}),
  };
}
