// No-PII aggregate beacon.
//
// A single allowlisted event name, fire-and-forget. The server keeps a bare
// whole-number tally per name — no identity, no payload, nothing per-visitor.
// GET with keepalive rather than sendBeacon: Astro's CSRF guard forbids the
// POST, and keepalive is what lets the request survive the page going away.
//
// The names are a union rather than a bare string on purpose. The server
// counts only names on its own allowlist, so a typo here does not error — it
// silently produces an event nobody ever counts, and the feature looks unused.
// sleepcast-site's middleware.test.ts asserts its allowlist covers every name
// in EVENT_NAMES, so the two cannot drift apart.

export const EVENT_NAMES = [
  "welcome_shown",
  "ritual_same_shows",
  "ritual_exact_again",
  "ritual_mix",
  "slept_yes",
  "slept_no",
  "reanchor_shown",
  "reanchor_tapped",
  "reanchor_dismissed",
  // YouTube. Shipped 2026-08-04 with no instrumentation at all, so nobody
  // could tell whether it had ever been used.
  "youtube_added",     // a channel resolved and was added as a feed
  "youtube_night",     // a night started on a YouTube lineup
  "youtube_tap_start", // the embed refused to autoplay and asked for a tap
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export function beacon(name: EventName): void {
  try {
    fetch(`/api/_event?e=${encodeURIComponent(name)}`, {
      method: "GET",
      keepalive: true,
      cache: "no-store",
    });
  } catch {
    /* a counter is never worth breaking a night over */
  }
}
