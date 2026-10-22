// The sleep timer's presets, in minutes, as setup shows them. Custom minutes
// sit beside them (clampTimerMinutes, store.ts).
export const TIMER_PRESETS = [25, 45, 75, 110] as const;

export const DEFAULT_TIMER_MINUTES = 45;

/**
 * How many times a night may be stretched by "a little longer".
 *
 * Unlimited extension is the 3am doom loop: awake, extend, still awake,
 * extend — the app quietly helping you stay up. Three is 45 extra minutes on
 * top of whatever was chosen, which also leaves plenty of room for people who
 * listen during the day. Deliberately a count, not a clock: time-of-day gating
 * would break daytime listening outright.
 */
export const MAX_EXTENSIONS = 3;

export function canExtend(extensionsSoFar: number): boolean {
  return extensionsSoFar < MAX_EXTENSIONS;
}
