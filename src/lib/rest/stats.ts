/** The middle value (the mean of the middle two for an even count), or null
 *  for none. A leaf module: the ledger, stepback, sleepscore and the watch
 *  import all use it without importing one another. */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
