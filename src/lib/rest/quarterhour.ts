// The quarter-hour rule — stimulus control, opt-in.
//
// CBT-I's stimulus control component says: if you are awake in bed for more
// than about twenty minutes, get out of bed. The bed must not become a place
// you associate with lying awake. A sleep-audio player works against that by
// default — it will happily play for 110 minutes while someone lies there
// wide awake, reinforcing exactly the association the protocol tries to break.
//
// So, when the listener has asked for it, the player stops and suggests
// getting up.
//
// WHAT WE CAN AND CANNOT SEE. The detector's onset is gated on the timer fade
// (detector.ts): it never reports sleep mid-night, only afterwards, and only
// for a night that faded unattended. So "has not fallen asleep yet" is not a
// question this code can ask. The only wakefulness we can observe is
// interaction — someone touching the transport. That means:
//
//   - restless-and-fiddling is detectable, and is what this fires on
//   - lying still awake is indistinguishable from sleeping, and is left alone
//
// Being left alone is the correct failure: waking a sleeper to tell them to
// get out of bed would be far worse than missing a silent insomniac.
//
// Deliberately clock-blind, like the rest of the app — this measures elapsed
// session time, never hour of day, so daytime listening behaves the same.

export interface QuarterHourInput {
  /** Since the night started. */
  elapsedMs: number;
  /** Transport touches so far this night. */
  interactions: number;
  /** Since the most recent touch; null when there has never been one. */
  msSinceLastInteraction: number | null;
}

/** ~20 minutes is the protocol's figure; 25 gives a little grace. */
export const RULE_AFTER_MS = 25 * 60_000;

/** A touch older than this suggests they have settled — leave them be. */
export const RECENT_MS = 5 * 60_000;

/** Fewer than this is reaching for a glass of water, not insomnia. */
export const MIN_INTERACTIONS = 3;

export function shouldSuggestGettingUp(i: QuarterHourInput): boolean {
  if (i.elapsedMs < RULE_AFTER_MS) return false;
  if (i.interactions < MIN_INTERACTIONS) return false;
  if (i.msSinceLastInteraction === null) return false;
  return i.msSinceLastInteraction <= RECENT_MS;
}
