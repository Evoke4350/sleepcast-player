import { describe, expect, test } from "vitest";
import { needsFetch } from "./feed-status";

describe("needsFetch", () => {
  test("fetches a feed never tried", () => {
    expect(needsFetch(undefined)).toBe(true);
  });

  // The setup screen re-ran its fetch loop on every change to the feed list
  // (enabling a show, setting a skip-intro) and skipped only feeds that had
  // finished. Feeds still downloading were fetched again, burning the relay's
  // per-visitor allowance on duplicates.
  test("does not refetch a feed already in flight", () => {
    expect(needsFetch({ loading: true, error: null })).toBe(false);
  });

  test("keeps a feed that loaded", () => {
    expect(needsFetch({ loading: false, error: null })).toBe(false);
  });

  test("retries a feed that failed", () => {
    expect(needsFetch({ loading: false, error: "HTTP 502" })).toBe(true);
  });
});
