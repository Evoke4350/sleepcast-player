import { useLazyRef } from "./use-lazy-ref";
import { loadNights } from "./rest/ledger";
import { lineupLean, shuffleWeights } from "./rest/sleepscore";
import type { FeedWeight } from "./plays";

/** The night's shuffle lean, fixed at its start: `lean`, each lineup feed's
 *  weight (see lineupLean), when the listener opted in (favorWhatWorks) and
 *  the scores tell the lineup's feeds apart; else none, a plain shuffle. A
 *  revived night keeps the lean it was snapshotted with (none, if none),
 *  whatever the setting or the scores are by then. `weightOf` is its picker
 *  form. */
export function useNightShuffle(
  favorWhatWorks: boolean,
  pool: readonly { feedId: string }[],
  resume: { shuffleLean?: Record<string, number> } | null | undefined,
): { lean: Record<string, number> | undefined; weightOf: FeedWeight | undefined } {
  return useLazyRef(() => {
    const lean = resume
      ? resume.shuffleLean
      : favorWhatWorks
        ? lineupLean(shuffleWeights(loadNights()), pool)
        : undefined;
    return { lean, weightOf: lean ? (feedId: string) => lean[feedId] ?? 1 : undefined };
  }).current;
}
