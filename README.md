# sleepcast-player

A sleep podcast player. Add your own feeds, it shuffles episodes, and a sleep
timer fades the audio to silence and stops. No account, no database, no
tracking, no AI. Everything you add lives in your browser's `localStorage`.

This is the player from [sleepcast.pro](https://sleepcast.pro), extracted so it
can be self-hosted and modified. MIT.

```bash
npm install
npm run dev        # http://localhost:3000
```

Node 22+ required (it uses `node:sqlite`-era built-ins and the standalone Astro
adapter). No env vars are needed to run it.

## Why it works this way

The design premise is that **a podcast app is the wrong shape for falling
asleep**. A normal player asks you to choose an episode, shows you what's next,
and keeps a queue you feel obliged to manage. At 1am each of those is a small
decision, and decisions are the thing keeping you awake.

So:

- **No next-up.** You never see what's coming, because knowing invites waiting.
- **Shuffle, not a queue.** Episodes are picked from your feeds with a bias
  against ones you've already heard (`src/lib/plays.ts`).
- **The timer fades, it doesn't cut.** A hard stop wakes people. The fade is a
  volume ramp over the last stretch (`fadeVolume` in `src/lib/engine.ts`).
- **It resumes the night, not the episode.** Fall asleep 20 minutes into a
  90-minute episode and the app remembers where you went under, so the next
  night doesn't restart the same thing from 0:00 (`src/lib/positions.ts`).

## The rest engine (`src/lib/rest/`)

The player tries to notice when you have fallen asleep, using nothing but
whether you are touching the screen. It is a sequential test — evidence
accumulates while you are quiet and resets when you interact — with a gate that
prevents it from declaring sleep before the audio has had a realistic chance to
work. Minimum time to a sleep verdict is about 7 minutes.

It is deliberately conservative: a false positive ends the night early, which
is worse than a late verdict.

`detector.ts` holds the test, `session.ts` drives it from real events,
`ledger.ts` stores nights, `calibrate.ts` tightens the threshold when you tell
it that it got one wrong. Every one of these has tests, including a simulation
harness (`detector.sim.test.ts`) that runs synthetic nights.

**The quarter-hour rule** (`quarterhour.ts`) is opt-in and off by default. It
is the stimulus-control idea from CBT-I: if you have been awake for a quarter of
an hour, get out of bed. The app can suggest it. It is a timer and a
suggestion, not treatment, and nothing here is medical advice.

## `/api/relay` — read this before deploying

Browsers cannot fetch most podcast feeds directly (CORS), so the server fetches
them on the caller's behalf. **That makes it a proxy, and an unguarded proxy on
the public internet is somebody else's tool.** The guard is not optional
decoration:

- `relay-guard.ts` resolves the hostname, verifies every resolved address is
  public, and then **pins that address for the actual connection** — closing
  the DNS-rebinding window between the check and the fetch.
- `ratelimit.ts` caps requests per IP. Note it is **in-memory and per-machine**:
  run two instances behind a load balancer and the effective limit doubles. It
  bounds abuse; it is not an exact quota.
- The response body is sniffed and rejected if it is not a feed.
- There is a size cap (32MB — some real sleep podcast feeds are over 20MB).

If you fork this and remove those checks, you have built an open SSRF relay
that can reach your cloud metadata endpoint. Don't.

## Deploying

Any host that runs a Node process works. The build emits a standalone server:

```bash
npm run build
node ./dist/server/entry.mjs      # honours PORT and HOST
```

Set `PUBLIC_SITE_URL` to your own origin so the canonical URL is right.

## Tests

```bash
npm test
```

The interesting ones are `src/lib/rest/*.test.ts` (the sleep detector, including
the simulation) and `src/lib/relay-guard.test.ts` (the SSRF cases).
