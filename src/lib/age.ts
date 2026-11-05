// Sleepcast isn't for children under 13.
//
// A neutral age screen: it asks when you were born rather than "are you
// 13 or over?", which only invites the answer it signals. The answer is
// kept on this device, under-13 included, so going back to try another
// year doesn't get past it. Only "old enough" or "too young" is kept, never
// the date. It isn't in a backup: it belongs to the device, like the
// analytics choice.

export const AGE_KEY = "sc-age";
export const MIN_AGE = 13;

export type AgeAnswer = "ok" | "under";

export function storedAge(): AgeAnswer | null {
  try {
    const v = localStorage.getItem(AGE_KEY);
    return v === "ok" || v === "under" ? v : null;
  } catch {
    return null;
  }
}

export function saveAge(answer: AgeAnswer): void {
  try { localStorage.setItem(AGE_KEY, answer); } catch { /* holds for this page */ }
}

/** Whether someone born in `month` (1-12) of `year` is 13 by `now`. With no
 *  day asked, a birthday this month counts as not yet: better to turn
 *  away a 13-year-old for a few weeks than let a 12-year-old in. */
export function oldEnough(year: number, month: number, now: Date): boolean {
  const thisMonth = now.getMonth() + 1;
  const age = now.getFullYear() - year - (thisMonth <= month ? 1 : 0);
  return age >= MIN_AGE;
}
