import { describe, expect, test } from "vitest";
import { needsFetch, RETRY_AFTER_MS } from "./feed-status";

const NOW = 1_000_000;

describe("needsFetch", () => {
  test("fetches a feed never tried", () => {
    expect(needsFetch(undefined, NOW)).toBe(true);
  });

  // The setup screen re-ran its fetch loop on every change to the feed list
  // (enabling a show, setting a skip-intro) and skipped only feeds that had
  // finished. Feeds still downloading were fetched again, burning the relay's
  // per-visitor allowance on duplicates.
  test("does not refetch a feed already in flight", () => {
    expect(needsFetch({ loading: true, error: null }, NOW)).toBe(false);
    expect(needsFetch({ loading: true, error: null }, NOW, true)).toBe(false);
  });

  test("keeps a feed that loaded", () => {
    expect(needsFetch({ loading: false, error: null }, NOW)).toBe(false);
    expect(needsFetch({ loading: false, error: null }, NOW, true)).toBe(false);
  });

  test("retries a failed feed once it has had time to recover", () => {
    expect(needsFetch({ loading: false, error: "HTTP 502", failedAt: NOW - RETRY_AFTER_MS }, NOW)).toBe(true);
  });

  // Retrying on every unrelated settings change, with no backoff, would keep
  // a visitor who hit the relay's rate limit (HTTP 429) over it.
  test("does not retry a recent failure on an unrelated change", () => {
    expect(needsFetch({ loading: false, error: "HTTP 429", failedAt: NOW - 1000 }, NOW)).toBe(false);
  });

  // "couldn't reach your feeds — try again": the listener asked, so retry now.
  test("retries a recent failure when the listener asks", () => {
    expect(needsFetch({ loading: false, error: "HTTP 502", failedAt: NOW - 1000 }, NOW, true)).toBe(true);
  });
});
