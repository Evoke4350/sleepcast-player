/** How long a failed feed rests before an unrelated change may retry it. */
export const RETRY_AFTER_MS = 30_000;

/**
 * Whether the setup screen should fetch a feed, given its current status.
 *
 * The fetch loop re-runs on every change to the feed list. It used to skip
 * only feeds that had finished loading, so every feed still in flight was
 * fetched again (duplicates against the relay's rate limit), while a feed
 * that had failed was never retried for the life of the page.
 *
 * A failed feed is retried when the listener asks (`force`), or on a later
 * change once RETRY_AFTER_MS has passed, never in a burst.
 */
export function needsFetch(
  status: { loading: boolean; error: string | null; failedAt?: number } | undefined,
  now: number,
  force = false,
): boolean {
  if (!status) return true;
  if (status.loading) return false;
  if (status.error === null) return false;
  return force || now - (status.failedAt ?? 0) >= RETRY_AFTER_MS;
}
