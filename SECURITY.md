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
- **`resolvePublicIps` + address pinning** resolve the hostname, check that
  *every* returned address is public, and then pin that address for the actual
  connection. Without the pin there is a window between the check and the fetch
  where DNS can change the answer — that's the rebinding attack, and it is why
  a plain `fetch()` after a hostname check is not sufficient.
- **Per-IP rate limiting**, in-memory and per-process. Two instances behind a
  load balancer means double the effective limit. It bounds abuse; it is not a
  quota.
- **A response sniff** that rejects bodies which aren't feeds, and a size cap.

If you fork this and drop any of that, you have published an open proxy that
can reach `169.254.169.254` and your internal network. The tests in
`src/lib/relay-guard.test.ts` cover these cases; they should stay green.

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

Self-hosters own their own deployment, and one detail needs your attention.
`clientIp` (`src/lib/ratelimit.ts`) reads, in order:

```
fly-client-ip  →  x-forwarded-for (first entry)  →  x-real-ip  →  "unknown"
```

`fly-client-ip` is there because sleepcast.pro runs on Fly. **If you deploy
somewhere that sets none of these, every caller buckets together under
`"unknown"`** — one shared rate limit for the whole internet, which is a denial
of service against your own users rather than protection from anyone. Make sure
your proxy sets `x-forwarded-for`, and make sure the app is not directly
reachable around it, or a caller can simply send the header themselves.
