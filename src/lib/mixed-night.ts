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
