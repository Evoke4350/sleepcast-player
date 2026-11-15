// Hidden episodes: the "never again" list, readable.
//
// Blocking stores ids (store.ts). This names them for the list in Settings,
// the one place that brings an episode back after the 8-second undo on the
// show page has gone. A name is what was written down when it was hidden;
// for a block from before names were kept, the feed, while the episode is
// still listed there; else the episode is shown as no longer listed (it
// can't play anyway, but it still counts, and can still be unhidden).
import type { Episode } from "./engine";
import { loadBlocked, loadBlockedNames, type BlockedName } from "./store";

export interface HiddenEpisode {
  id: string;
  title: string;
  /** The show's title; "" when unknown. */
  show: string;
  /** No feed lists it now, and nothing was written down: an older block. */
  unknown?: boolean;
}

export const UNKNOWN_TITLE = "An episode no longer listed";

/** Newest hidden first (the block list appends). */
export function hiddenEpisodes(
  blocked: readonly string[],
  names: Record<string, BlockedName>,
  episodes: readonly Episode[],
  showTitles: Record<string, string>,
): HiddenEpisode[] {
  const byId = new Map(episodes.map((e) => [e.id, e]));
  const out: HiddenEpisode[] = [];
  for (let i = blocked.length - 1; i >= 0; i--) {
    const id = blocked[i];
    const name = names[id];
    const ep = byId.get(id);
    if (name) out.push({ id, title: name.title, show: name.show });
    else if (ep) out.push({ id, title: ep.title, show: showTitles[ep.feedId] ?? "" });
    else out.push({ id, title: UNKNOWN_TITLE, show: "", unknown: true });
  }
  return out;
}

/** The list from storage. */
export function loadHidden(episodes: readonly Episode[], showTitles: Record<string, string>): HiddenEpisode[] {
  return hiddenEpisodes(loadBlocked(), loadBlockedNames(), episodes, showTitles);
}
