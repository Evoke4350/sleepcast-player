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
import { aliveIn, pickNextEpisode, type Play } from "./plays";
import type { FeedWeight } from "./rest/types";

/**
 * The lead a mixed night should actually open on, given the one somebody
 * supplied, if any (none: the night nobody had an opinion about).
 *
 * Leads arrive from two places — the 3am re-anchor, and a search result or
 * suggestion in setup (a resumed night keeps its episode and doesn't come
 * here) — and the re-anchor's is picked in array order with no idea that
 * kinds exist. Letting either through unexamined spends the night's one waking gesture on a
 * podcast and leaves the first video to land mid-sleep, which is exactly the
 * failure leading with video exists to prevent.
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
  weightOf?: FeedWeight,
): Episode | null {
  if (lead?.youtubeId) return lead;
  const alive = aliveIn(pool, dead);
  const videos = alive.filter((e) => !!e.youtubeId);
  // Freshness is the ordinary rule, applied to the videos alone — a lead that
  // hands back last night's video would be a worse start than a random one.
  if (videos.length) return pickNextEpisode(videos, plays, rand, weightOf);
  // No video alive. A supplied podcast lead stands. With none, a podcast lead
  // (or null when nothing at all is alive — pickNextEpisode's empty guard):
  // dropping a podcast here left the night with nothing to play.
  return lead ?? pickNextEpisode(alive, plays, rand, weightOf);
}
