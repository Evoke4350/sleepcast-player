import { useLazyRef } from "./use-lazy-ref";
import { loadNights } from "./rest/ledger";
import { nightLean } from "./rest/sleepscore";
import type { FeedWeight } from "./plays";

/** The night's shuffle lean, fixed at its start (see nightLean), with its
 *  picker form. */
export function useNightShuffle(
  favorWhatWorks: boolean,
  pool: readonly { feedId: string }[],
  resume: { shuffleLean?: unknown } | null | undefined,
): { lean: Record<string, number> | undefined; weightOf: FeedWeight | undefined } {
  return useLazyRef(() => {
    const lean = nightLean(favorWhatWorks, pool, resume, loadNights);
    return { lean, weightOf: lean ? (feedId: string) => lean[feedId] ?? 1 : undefined };
  }).current;
}
