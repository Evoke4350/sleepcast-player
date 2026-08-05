// Which feeds actually put this listener under.
//
// Ported from sleepscore.py in the private engine (~/Projects/sleepcast), whose
// insight is that manual actions prove wakefulness: if the timer outlived the
// listener, whatever was playing at the moment the detector concluded earns the
// credit, whatever auto-advanced afterwards earns a little, and whatever they
// reached over and skipped earns a penalty.
//
// Feed-level, not episode-level, and that is not a simplification. Sleep With Me
// alone has 1,600 episodes and pickNextEpisode actively prefers unheard ones, so
// per-episode credit would be one observation per episode forever and would
// never converge on anything. Feeds accumulate dozens of nights.

import type { RestNight } from "./types";

export const CREDIT_ONSET = 2;
export const CREDIT_SLEPT = 1;
export const PENALTY_SKIP = -1;

/** Never zero a feed out. A feed that scored badly twice has not been
 *  disproved, and a scorer that eliminates its own exploration converges on
 *  whatever it happened to try first.
 *
 *  With sleptThrough/skipped de-duplicated per night (see scoreFeeds), the
 *  pre-clamp weight cannot reach this floor: per-night credit is bounded to
 *  [-1, 3], so weight = 1 + WEIGHT_SLOPE * mean is in [0.75, 1.75]. The
 *  clamp stays anyway — the credit scheme could change, and the test below
 *  pins the relationship so a change that breaks it gets caught. */
export const WEIGHT_FLOOR = 0.25;

/** Below this many nights a feed is not ranked and not suggested — with one
 *  night's evidence the app would state a preference it does not have. */
export const MIN_NIGHTS = 3;

// Matches the ported Python's curve exactly (sleepscore.py's WEIGHT_SLOPE).
const WEIGHT_SLOPE = 0.25;

export interface FeedScore {
  feedId: string;
  /** Sum of credits across every night this feed appeared in. */
  score: number;
  /** Nights this feed appeared in — not nights in the ledger. */
  nights: number;
  /** max(WEIGHT_FLOOR, 1 + slope × mean credit). Ranks the suggestion and
   *  nothing else: the shuffle is deliberately untouched (see the spec, §8). */
  weight: number;
  onsetNights: number;
  skipNights: number;
}

export function scoreFeeds(nights: readonly RestNight[]): FeedScore[] {
  const acc = new Map<string, { score: number; nights: number; onset: number; skips: number }>();
  const bump = (feedId: string, delta: number, kind?: "onset" | "skip") => {
    const e = acc.get(feedId) ?? { score: 0, nights: 0, onset: 0, skips: 0 };
    e.score += delta;
    if (kind === "onset") e.onset++;
    if (kind === "skip") e.skips++;
    acc.set(feedId, e);
  };

  for (const n of nights) {
    // Count each feed once per night, so a feed appearing twice in one night's
    // records does not inflate its night count and dilute its mean.
    const seen = new Set<string>();
    if (n.onsetFeedId) {
      bump(n.onsetFeedId, CREDIT_ONSET, "onset");
      seen.add(n.onsetFeedId);
    }
    // De-duplicated here, not trusted from the producer: RestNight's type
    // permits repeats in these arrays and ledger.ts JSON.parses stored
    // nights with no runtime validation, so a duplicate feedId must not
    // collect credit twice.
    for (const f of new Set(n.sleptThrough ?? [])) {
      bump(f, CREDIT_SLEPT);
      seen.add(f);
    }
    for (const f of new Set(n.skipped ?? [])) {
      bump(f, PENALTY_SKIP, "skip");
      seen.add(f);
    }
    for (const f of seen) acc.get(f)!.nights++;
  }

  return [...acc.entries()]
    .map(([feedId, e]) => ({
      feedId,
      score: e.score,
      nights: e.nights,
      weight: Math.max(WEIGHT_FLOOR, 1 + WEIGHT_SLOPE * (e.score / e.nights)),
      onsetNights: e.onset,
      skipNights: e.skips,
    }))
    // feedId is the tiebreak so the suggestion does not flicker between renders
    // on feeds with identical evidence.
    .sort((a, b) => b.weight - a.weight || a.feedId.localeCompare(b.feedId));
}

/** Scored feeds with enough evidence to say anything about. */
export function rankedFeeds(nights: readonly RestNight[]): FeedScore[] {
  return scoreFeeds(nights).filter((f) => f.nights >= MIN_NIGHTS);
}

/** Times to sleep (ms) for nights this feed was playing at onset, unsorted.
 *  Shared by medianTimeToSleep and evidenceFor so the count named in the
 *  evidence sentence can never drift from the set the median was computed
 *  over — see evidenceFor's comment on why that drift is possible at all. */
function onsetTimesFor(nights: readonly RestNight[], feedId: string): number[] {
  return nights
    .filter((n) => n.onsetFeedId === feedId && n.timeToSleepMs !== null)
    .map((n) => n.timeToSleepMs as number);
}

/** Median time-to-sleep across nights this feed was playing at onset, or null
 *  if it never led one. Median rather than mean: one 3am night that ran the
 *  whole timer would drag an average and misdescribe every other night. */
export function medianTimeToSleep(
  nights: readonly RestNight[],
  feedId: string,
): number | null {
  const times = onsetTimesFor(nights, feedId).sort((a, b) => a - b);
  if (!times.length) return null;
  const mid = Math.floor(times.length / 2);
  return times.length % 2 ? times[mid] : Math.round((times[mid - 1] + times[mid]) / 2);
}

/**
 * The sentence that appears beside the pick. Every claim in it is checkable
 * against the panel in the rest view — that is the point of showing it rather
 * than just picking.
 */
export function evidenceFor(nights: readonly RestNight[], f: FeedScore): string {
  const median = medianTimeToSleep(nights, f.feedId);
  if (median === null) {
    return f.skipNights > 0
      ? `You've skipped it on ${f.skipNights} of ${f.nights} nights.`
      : `It's played on ${f.nights} nights.`;
  }
  const mins = Math.round(median / 60_000);
  // f.onsetNights counts every night onsetFeedId matched this feed, including
  // one where timeToSleepMs is null — this module doesn't trust its producer
  // (see scoreFeeds' de-dup comments) so that combination isn't ruled out.
  // The median above can only be built from nights with a real time, so "N
  // times" must be counted the same way, or it would name a night the
  // minutes figure never saw.
  const led = onsetTimesFor(nights, f.feedId).length;
  return `Gone in ${mins} min the last ${led} time${led === 1 ? "" : "s"} it led.`;
}
