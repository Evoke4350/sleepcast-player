// Which episode a mixed night opens on.
//
// Always a video, when there is one. Browsers may refuse to autoplay an embed
// without a gesture, and they generally stop asking once a video has actually
// played in the session. At bedtime the listener is awake and can tap; the same
// refusal at 2am stalls the night with the timer still running, which is the
// worst failure this app has. So the expensive first video is spent while
// someone is there to answer for it, and every later switch is free.
//
// The constraint is only on position one. Everything after it shuffles.

import type { Episode } from "./engine";
import { pickNextEpisode, type Play } from "./plays";

export function chooseLead(
  pool: readonly Episode[],
  dead: ReadonlySet<string>,
  plays: Play[],
  rand: () => number = Math.random,
): Episode | null {
  const alive = pool.filter((e) => !dead.has(e.id));
  const videos = alive.filter((e) => !!e.youtubeId);
  // Freshness is the ordinary rule, applied to the videos alone — a lead that
  // hands back last night's video would be a worse start than a random one.
  // The `alive` fallback covers two different callers, correctly by construction:
  // when `alive` is all podcasts (no videos in the pool, or all videos dead),
  // pickNextEpisode picks among them, which is the required podcast lead; when
  // `alive` is itself empty (nothing playable at all), pickNextEpisode's own
  // empty-array guard returns null. No extra guard needed here.
  return pickNextEpisode(videos.length ? videos : alive, plays, rand);
}

/**
 * The lead a mixed night should actually open on, given one somebody supplied.
 *
 * chooseLead alone only covers the night nobody had an opinion about. Leads
 * arrive from three other places — the 3am re-anchor, a search result or
 * suggestion in setup, and a resumed night — and the re-anchor's is picked in
 * array order with no idea that kinds exist. Letting any of them through
 * unexamined spends the night's one waking gesture on a podcast and leaves the
 * first video to land mid-sleep, which is exactly the failure leading with
 * video exists to prevent.
 *
 * A supplied podcast lead is only overridden by a video, never by another
 * podcast: the listener may have chosen this one, and swapping it for a
 * different podcast buys nothing and ignores them.
 */
export function preferVideoLead(
  lead: Episode | null | undefined,
  pool: readonly Episode[],
  dead: ReadonlySet<string>,
  plays: Play[],
  rand: () => number = Math.random,
): Episode | null {
  if (lead?.youtubeId) return lead;
  const video = chooseLead(pool, dead, plays, rand);
  return video?.youtubeId ? video : lead ?? null;
}
