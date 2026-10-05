import { useLazyRef } from "./use-lazy-ref";
import { loadNights } from "./rest/ledger";
import { nightLean } from "./rest/sleepscore";
import type { FeedWeight } from "./plays";

/** The night's shuffle lean, fixed at its start (see nightLean), and its
 *  picker form, which tells `onLeanedPick` of each pick it actually shaped
 *  (for the night's record). */
export function useNightShuffle(
  favorWhatWorks: boolean,
  pool: readonly { feedId: string }[],
  resume: { shuffleLean?: unknown } | null | undefined,
  onLeanedPick: () => void,
): { lean: Record<string, number> | undefined; weightOf: FeedWeight | undefined } {
  return useLazyRef(() => {
    const lean = nightLean(favorWhatWorks, pool, resume, loadNights);
    // A Map, not the object: a feed id like "constructor" mustn't find an
    // inherited property.
    const byFeed = lean ? new Map(Object.entries(lean)) : undefined;
    const weightOf: FeedWeight | undefined = byFeed
      ? Object.assign((feedId: string) => byFeed.get(feedId) ?? 1, { onLeanedPick })
      : undefined;
    return { lean, weightOf };
  }).current;
}
