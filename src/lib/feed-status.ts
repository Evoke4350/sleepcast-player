/**
 * Whether the setup screen should fetch a feed, given its current status.
 *
 * The fetch loop re-runs on every change to the feed list. It used to skip
 * only feeds that had finished loading, so every feed still in flight was
 * fetched again (duplicates against the relay's rate limit), while a feed
 * that had failed was never retried for the life of the page.
 */
export function needsFetch(status: { loading: boolean; error: string | null } | undefined): boolean {
  if (!status) return true;
  if (status.loading) return false;
  return status.error !== null;
}
