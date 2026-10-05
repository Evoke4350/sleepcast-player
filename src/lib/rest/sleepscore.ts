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

import type { FeedWeight, RestNight } from "./types";

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
 *  night's evidence the app would state a preference it does not have —
 *  and, for a listener who opted in, doesn't lean the shuffle either
 *  (shuffleWeights). */
export const MIN_NIGHTS = 3;

// Matches the ported Python's curve exactly (sleepscore.py's WEIGHT_SLOPE).
const WEIGHT_SLOPE = 0.25;
/** The most a feed can weigh: the best a night can credit is onset plus
 *  slept-through. */
export const WEIGHT_MAX = 1 + WEIGHT_SLOPE * (CREDIT_ONSET + CREDIT_SLEPT);

export interface FeedScore {
  feedId: string;
  /** Sum of credits across every night this feed appeared in. */
  score: number;
  /** Nights this feed appeared in — not nights in the ledger. */
  nights: number;
  /** max(WEIGHT_FLOOR, 1 + slope × mean credit). Ranks the suggestion, and
   *  leans the shuffle only for a listener who opts in (shuffleWeights; the
   *  spec, §8). */
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
    // "awake" means the listener told the app the detector was wrong — the
    // onset, whatever slept through, and whatever got skipped all rest on
    // that same discredited call, so the whole night is thrown out rather
    // than just the onset credit. stepback.ts has honoured this for its own
    // question since the beginning; this scorer had not.
    if (n.selfLabel === "awake") continue;

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

/** Whether a scored feed clears the bar to be suggested or ranked: enough
 *  nights to say anything, at least one of them actually led (a feed that
 *  has only ever been skipped or slept through has never been chosen, only
 *  reacted to), and a net-positive record. A count alone is not enough —
 *  three nights of nothing but skips clears MIN_NIGHTS and nets a negative
 *  score, and a scorer that gates on the count without the sign recommends
 *  the exact feed its own evidence damns.
 *
 *  Exported so the audit panel (RestView) can split its listing along the
 *  same line rankedFeeds uses to pick the suggestion — the two must never be
 *  able to disagree about which feeds have "enough" behind them. */
export function meetsSuggestionGate(f: FeedScore): boolean {
  return f.nights >= MIN_NIGHTS && f.onsetNights >= 1 && f.score > 0;
}

/** A weight as the shuffle reads it: one that isn't a positive finite
 *  number counts as 1 (no lean). */
export function asWeight(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** A lineup's lean: the weight of each of its feeds that isn't ×1 (absent
 *  means ×1), or undefined when its feeds all weigh the same (the shuffle
 *  normalises, so equal weights lean nothing: a plain shuffle, and recorded
 *  as one). */
export function lineupLean(
  weightOf: FeedWeight,
  pool: readonly { feedId: string }[],
): Record<string, number> | undefined {
  const all = new Map<string, number>();
  for (const e of pool) if (!all.has(e.feedId)) all.set(e.feedId, asWeight(weightOf(e.feedId))); // once per feed, read as the shuffle reads it
  if (new Set(all.values()).size < 2) return undefined; // one weight, or none
  return leanRecord([...all].filter(([, w]) => w !== 1));
}

/** A lean as a record with no prototype: a feed id like "constructor"
 *  can't find an inherited property, so a plain lookup is safe. */
function leanRecord(entries: Iterable<[string, number]>): Record<string, number> {
  return Object.assign(Object.create(null) as Record<string, number>, Object.fromEntries(entries));
}

/** The shuffle's lean, for a listener who has opted in (settings
 *  favorWhatWorks): a feed with MIN_NIGHTS or more scored nights leans by
 *  its weight (0.75 to WEIGHT_MAX under today's credits, never below
 *  WEIGHT_FLOOR: toward what has put them under, away from what they skip,
 *  never ruled out); any other feed is 1, no lean
 *  without evidence either way. Unlike the suggestion, a net-negative feed
 *  counts here: leaning away is the other half of the point.
 *  Takes feeds already scored (scoreFeeds); weights go through clampWeight
 *  (WEIGHT_FLOOR..WEIGHT_MAX), which also rounds them to
 *  hundredths: a difference below that changes no pick that matters, so it
 *  neither makes a night "leaned" nor shows as a weight. */
export function shuffleWeights(scored: readonly FeedScore[]): FeedWeight {
  const w = new Map(
    scored.filter((f) => f.nights >= MIN_NIGHTS).map((f) => [f.feedId, clampWeight(f.weight)]),
  );
  return (feedId) => w.get(feedId) ?? 1;
}

/** A weight within WEIGHT_FLOOR..WEIGHT_MAX, rounded to hundredths: the one
 *  rule both a new night's lean (shuffleWeights) and a revived one
 *  (validLean) go through, so the two can't disagree. */
function clampWeight(w: number): number {
  return Math.round(Math.min(WEIGHT_MAX, Math.max(WEIGHT_FLOOR, w)) * 100) / 100;
}

/** A stored lean (a revived snapshot's), if it is one, in lineupLean's
 *  shape: its entries that are positive finite weights other than 1 (an
 *  entry that isn't is dropped: absent means 1), clamped (and rounded) by
 *  clampWeight (so a snapshot from before a change to the credits still
 *  revives leaning, within today's bounds). None left, or not an object at
 *  all, is none, a plain shuffle. Returned as a prototype-less record, like
 *  lineupLean's. */
export function validLean(x: unknown): Record<string, number> | undefined {
  if (!x || typeof x !== "object" || Array.isArray(x)) return undefined;
  const kept: [string, number][] = [];
  for (const [feedId, w] of Object.entries(x as Record<string, unknown>)) {
    if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) continue;
    const c = clampWeight(w);
    if (c !== 1) kept.push([feedId, c]);
  }
  return kept.length ? leanRecord(kept) : undefined;
}

/** The night's lean, fixed at its start. A revived night keeps the one it
 *  was snapshotted with (validLean; none if none), whatever the setting,
 *  scores or revived lineup are by then. A new night leans by the scores when the
 *  listener opted in and they tell its lineup's feeds apart; else none, a
 *  plain shuffle. `nights` is read only when needed. */
export function nightLean(
  favorWhatWorks: boolean,
  pool: readonly { feedId: string }[],
  resume: { shuffleLean?: unknown } | null | undefined,
  nights: () => readonly RestNight[],
): Record<string, number> | undefined {
  // A revived night is the same night: it keeps its lean as it began, so
  // it's recorded as it was (leaned by what was in effect), even when the
  // snapshot's cut-down pool leaves feeds that weigh the same (those picks
  // are then plain, which the weights already give).
  if (resume) return validLean(resume.shuffleLean);
  return favorWhatWorks ? lineupLean(shuffleWeights(scoreFeeds(nights())), pool) : undefined;
}

/** Scored feeds with enough evidence to say anything about. */
export function rankedFeeds(nights: readonly RestNight[]): FeedScore[] {
  return scoreFeeds(nights).filter(meetsSuggestionGate);
}

/** Times the onset feed had been playing (ms) for nights this feed was
 *  playing at onset, unsorted. Shared by medianTimeToSleep and evidenceFor so
 *  the count named in the evidence sentence can never drift from the set the
 *  median was computed over — see evidenceFor's comment on why that drift is
 *  possible at all.
 *
 *  Reads onsetAfterMs, not timeToSleepMs: the latter is measured from night
 *  start, so a skip-heavy night would credit the feed with time it spent
 *  skipping through everything else. A night with onsetFeedId but no
 *  onsetAfterMs is excluded rather than falling back — a wrong number is
 *  worse than a smaller sample. */
function onsetTimesFor(nights: readonly RestNight[], feedId: string): number[] {
  return nights
    // "awake" nights are discarded for the same reason scoreFeeds drops them.
    .filter((n) => n.onsetFeedId === feedId && n.onsetAfterMs !== undefined && n.selfLabel !== "awake")
    .map((n) => n.onsetAfterMs as number);
}

/** Median time the onset feed had been playing, across nights this feed was
 *  playing at onset, or null if it never led one (or led only nights without
 *  onsetAfterMs). Median rather than mean: one 3am night that ran the whole
 *  timer would drag an average and misdescribe every other night. */
export function medianTimeToSleep(
  nights: readonly RestNight[],
  feedId: string,
): number | null {
  const times = onsetTimesFor(nights, feedId).sort((a, b) => a - b);
  if (!times.length) return null;
  const mid = Math.floor(times.length / 2);
  return times.length % 2 ? times[mid] : Math.round((times[mid - 1] + times[mid]) / 2);
}

/** A time to sleep in minutes, for the evidence sentence and the panel it
 *  is checked against. A round-trip through Math.round already collapses
 *  anything under 30 seconds to 0 — "Gone in 0 min" is technically the true
 *  minute count but reads like the detector glitched, not like a fast, real
 *  result — so that reads "under a minute". */
export function fmtOnsetMinutes(ms: number): string {
  const mins = Math.round(ms / 60_000);
  return mins === 0 ? "under a minute" : `${mins} min`;
}

/** "1 night" / "3 nights" (or "1 timed night" with `kind`) — singularises
 *  the unit the count names, not just the number, so a feed with one
 *  recorded night doesn't read as a typo ("1 nights"). */
export function pluralNights(n: number, kind?: string): string {
  return `${n} ${kind ? `${kind} ` : ""}night${n === 1 ? "" : "s"}`;
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
      ? `You've skipped it on ${f.skipNights} of ${pluralNights(f.nights)}.`
      : `It's played on ${pluralNights(f.nights)}.`;
  }
  const minsPhrase = fmtOnsetMinutes(median);
  // f.onsetNights counts every night onsetFeedId matched this feed, including
  // one where onsetAfterMs is absent — this module doesn't trust its producer
  // (see scoreFeeds' de-dup comments) so that combination isn't ruled out.
  // The median above can only be built from nights with a real time, so "N
  // times" must be counted the same way, or it would name a night the
  // minutes figure never saw.
  const led = onsetTimesFor(nights, f.feedId).length;
  const sentence = `Gone in ${minsPhrase} the last ${led} time${led === 1 ? "" : "s"} it led.`;
  // A median only describes the nights the feed got picked to lead. A feed
  // can look flawless there and still fail most of the nights it was
  // offered — the median winning unconditionally let that failure rate go
  // unmentioned even though it's exactly what would change a reader's mind.
  return f.skipNights > 0
    ? `${sentence} Skipped on ${f.skipNights} of ${pluralNights(f.nights)}.`
    : sentence;
}
