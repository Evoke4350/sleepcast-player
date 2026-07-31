// The clock-blind timer: four feel labels instead of minutes. Minutes are kept
// internally (the fade still needs a duration) but never shown as the primary
// control. Single source of truth for the setup presets.
export interface FeelPreset {
  label: string;
  minutes: number;
}

export const FEEL_PRESETS: FeelPreset[] = [
  { label: "a short drift", minutes: 25 },
  { label: "a while", minutes: 45 },
  { label: "a long while", minutes: 75 },
  { label: "the whole way", minutes: 110 },
];

export const DEFAULT_FEEL_MINUTES = 45;

export function labelForMinutes(m: number): string | null {
  const hit = FEEL_PRESETS.find((p) => p.minutes === m);
  return hit ? hit.label : null;
}

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
