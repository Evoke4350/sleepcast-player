# Security

## Reporting

Email nathanib@pm.me. Please don't open a public issue for anything exploitable
until it's fixed.

## The part that matters: `/api/relay`

This app ships a server endpoint that **fetches a URL supplied by the caller**.
It exists because browsers can't fetch most podcast feeds cross-origin. That
makes it the highest-value target in the codebase, and the guard around it is
load-bearing:

- **`isAllowedFeedUrl`** rejects non-HTTP(S) schemes, credentials in the URL,
  and non-public hosts before any request is made.
- **Cloudflare Workers itself**: a Worker cannot reach private networks, so a
  public hostname whose DNS answers with a private address (the rebinding
  attack) goes nowhere. This replaces the DNS pinning the Node relay needed.
  **If you move the relay to a host that can reach a private network, pin DNS
  answers again** (git history has `resolvePublicIps` and the pinned fetch).
- **Per-IP rate limiting** through the Workers rate limiting binding, keyed on
  `CF-Connecting-IP`, which Cloudflare sets and a caller can't. It bounds
  abuse; it is not a quota.
- **A response sniff** that rejects bodies which aren't feeds, and a size cap.

If you fork this and drop any of that, you have published an open proxy that
can reach `169.254.169.254` and your internal network. The tests in
`src/lib/relay-guard.test.ts` and `worker/relay.test.ts` cover these cases;
they should stay green.

## What this app does not do

It has no accounts, no server-side storage, and no database. It uses Google
Analytics for usage measurement, gated behind a consent banner (Consent Mode
v2, denied by default), so analytics cookies are set only after a visitor
accepts; declining, or opting out, leaves the app fully working. Feeds, settings
and listening history live only in the browser's `localStorage`. There is
nothing about a user on the app's server to breach: usage analytics goes
directly from the browser to Google when consented, not through the server, and
the only server work is fetching feeds.

One optional feature ("varied mix") downloads MiniLM-L6-v2 from Hugging Face's
CDN and runs it in the browser. That is the only third-party request the app
makes other than to your own podcast hosts. See the README.

## Scope

Self-hosters own their own deployment. The relay's protections assume it runs
on Cloudflare Workers; see above for what changes elsewhere.
