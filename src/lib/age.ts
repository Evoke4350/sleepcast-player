// Sleepcast isn't for children under 13.
//
// A neutral age screen: it asks when you were born rather than "are you
// 13 or over?", which only invites the answer it signals. The answer is
// kept on this device, under-13 included, so going straight back to try
// another year doesn't get past it. A wrong year isn't a life sentence
// though: after a day the date can be given again (the only other way out
// was clearing the site's data, which takes every night with it). Only "old
// enough" or "too young" is kept, and when, never the date. It isn't in a
// backup: it belongs to the device, like the analytics choice.

export const AGE_KEY = "sc-age";
/** When a "too young" answer was given (epoch ms). */
export const AGE_AT_KEY = "sc-age-at";
export const MIN_AGE = 13;
/** How long a "too young" answer stands before the date can be given again. */
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export type AgeAnswer = "ok" | "under";

export function storedAge(): AgeAnswer | null {
  try {
    const v = localStorage.getItem(AGE_KEY);
    return v === "ok" || v === "under" ? v : null;
  } catch {
    return null;
  }
}

export function saveAge(answer: AgeAnswer, now = Date.now()): void {
  try {
    localStorage.setItem(AGE_KEY, answer);
    if (answer === "under") localStorage.setItem(AGE_AT_KEY, String(now));
    else localStorage.removeItem(AGE_AT_KEY);
  } catch { /* holds for this page */ }
}

/** When a "too young" answer can be changed (epoch ms): a day after it was
 *  given, or at once for one kept before the time was (nothing to count
 *  from). Null unless the answer is "too young". */
export function retryAt(): number | null {
  if (storedAge() !== "under") return null;
  try {
    const at = Number(localStorage.getItem(AGE_AT_KEY));
    return Number.isFinite(at) && at > 0 ? at + RETRY_AFTER_MS : 0;
  } catch {
    return 0;
  }
}

/** Forget the answer, so the date is asked again. */
export function clearAge(): void {
  try {
    localStorage.removeItem(AGE_KEY);
    localStorage.removeItem(AGE_AT_KEY);
  } catch { /* nothing kept to clear */ }
}

/** Whether someone born in `month` (1-12) of `year` is 13 by `now`. With no
 *  day asked, a birthday this month counts as not yet: better to turn
 *  away a 13-year-old for a few weeks than let a 12-year-old in. */
export function oldEnough(year: number, month: number, now: Date): boolean {
  const thisMonth = now.getMonth() + 1;
  const age = now.getFullYear() - year - (thisMonth <= month ? 1 : 0);
  return age >= MIN_AGE;
}
