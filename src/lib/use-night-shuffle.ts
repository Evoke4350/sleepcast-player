import { useLazyRef } from "./use-lazy-ref";
import { loadNights } from "./rest/ledger";
import { shuffleWeights } from "./rest/sleepscore";
import type { FeedWeight } from "./plays";

/** The night's shuffle lean, fixed at its start: what has put this listener
 *  under, when they opted in (favorWhatWorks; see shuffleWeights), else none
 *  (a plain shuffle). */
export function useNightShuffleWeights(favorWhatWorks: boolean): { readonly current: FeedWeight | undefined } {
  return useLazyRef(() => (favorWhatWorks ? shuffleWeights(loadNights()) : undefined));
}
