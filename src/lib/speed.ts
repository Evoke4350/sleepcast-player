// Playback speed, kept per show.
//
// Slower is the direction that matters here: a voice at 0.8–0.9× is a
// drowsier one, and browsers keep its pitch. Faster is for the shows you
// listen to awake. The sleep timer is wall-clock time either way; only what
// is measured in an episode's own seconds (how much of it is left) has to be
// divided by the speed to say how long it will take.

/** The speeds a tap steps through, in order. */
export const SPEEDS = [0.8, 0.9, 1, 1.25, 1.5] as const;

/** The speed after `rate`, wrapping round; 1 for one not on the list. */
export function nextSpeed(rate: number): number {
  const i = SPEEDS.indexOf(rate as (typeof SPEEDS)[number]);
  return i < 0 ? 1 : SPEEDS[(i + 1) % SPEEDS.length];
}

/** "0.8×", "1×", "1.25×". */
export function speedLabel(rate: number): string {
  return `${rate}×`;
}

/** Episode seconds as real seconds at `rate`; null stays null. */
export function realSeconds(episodeSec: number | null, rate: number): number | null {
  return episodeSec === null ? null : episodeSec / (rate > 0 ? rate : 1);
}

/** feedId → speed, keeping only speeds on the list other than 1 (absent
 *  means 1), so a stored value can't set something the controls can't. */
export function sanitizeSpeeds(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && v !== 1 && (SPEEDS as readonly number[]).includes(v)) out[k] = v;
    }
  }
  return out;
}
