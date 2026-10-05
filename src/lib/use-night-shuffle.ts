import { useLazyRef } from "./use-lazy-ref";
import { loadNights } from "./rest/ledger";
import { nightLean } from "./rest/sleepscore";
import type { FeedWeight } from "./rest/types";

export interface NightShuffle {
  /** The night's lean; a night with one is recorded as leaned. */
  lean: Record<string, number> | undefined;
  weightOf: FeedWeight | undefined;
}

/** A lean and its picker form (lean has no prototype, so a plain
 *  lookup can't hit an inherited key; absent feeds weigh 1). */
export function shuffleFor(lean: Record<string, number> | undefined): NightShuffle {
  return {
    lean,
    weightOf: lean ? (feedId: string) => lean[feedId] ?? 1 : undefined,
  };
}

/** The night's shuffle, fixed at its start (see nightLean). */
export function useNightShuffle(
  favorWhatWorks: boolean,
  pool: readonly { feedId: string }[],
  resume: { shuffleLean?: unknown } | null | undefined,
): NightShuffle {
  return useLazyRef(() => shuffleFor(nightLean(favorWhatWorks, pool, resume, loadNights))).current;
}
