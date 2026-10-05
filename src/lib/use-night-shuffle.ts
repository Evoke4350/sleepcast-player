import { useLazyRef } from "./use-lazy-ref";
import { loadNights } from "./rest/ledger";
import { nightLean } from "./rest/sleepscore";
import type { FeedWeight } from "./plays";

/** The night's shuffle lean, fixed at its start (see nightLean), with its
 *  picker form and whether it leans at all (one fact, for the record). */
export function useNightShuffle(
  favorWhatWorks: boolean,
  pool: readonly { feedId: string }[],
  resume: { shuffleLean?: unknown } | null | undefined,
): { lean: Record<string, number> | undefined; weightOf: FeedWeight | undefined; leaned: boolean } {
  return useLazyRef(() => {
    const lean = nightLean(favorWhatWorks, pool, resume, loadNights);
    // A Map, not the object: a feed id like "constructor" mustn't find an
    // inherited property.
    const byFeed = lean ? new Map(Object.entries(lean)) : undefined;
    return { lean, weightOf: byFeed ? (feedId: string) => byFeed.get(feedId) ?? 1 : undefined, leaned: lean !== undefined };
  }).current;
}
