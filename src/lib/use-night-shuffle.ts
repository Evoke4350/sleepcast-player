import { useLazyRef } from "./use-lazy-ref";
import { loadNights } from "./rest/ledger";
import { nightLean } from "./rest/sleepscore";
import type { FeedWeight } from "./plays";

/** The night's shuffle lean, fixed at its start (see nightLean), and its
 *  picker form. A night with a lean is recorded as leaned. */
export function useNightShuffle(
  favorWhatWorks: boolean,
  pool: readonly { feedId: string }[],
  resume: { shuffleLean?: unknown } | null | undefined,
): { lean: Record<string, number> | undefined; weightOf: FeedWeight | undefined; leaned: boolean } {
  return useLazyRef(() => {
    const lean = nightLean(favorWhatWorks, pool, resume, loadNights);
    // (lean has no prototype: a plain lookup can't hit an inherited key.)
    const weightOf: FeedWeight | undefined = lean
      ? (feedId: string) => lean[feedId] ?? 1
      : undefined;
    return { lean, weightOf, leaned: lean !== undefined };
  }).current;
}
