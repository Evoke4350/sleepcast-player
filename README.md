# sleepcast-player

A sleep podcast player. Add your own feeds, it shuffles episodes, and a sleep
timer fades the audio to silence and stops. No account, no database, no
tracking, no server-side anything. Everything you add lives in your browser's
`localStorage`.

This is the player from [sleepcast.pro](https://sleepcast.pro), extracted so it
can be self-hosted and modified. MIT.

```bash
npm install
npm run dev        # http://localhost:3000
```

Node 22+ required (Astro 6). No env vars are needed to run it.

## Why it works this way

The design premise is that **a podcast app is the wrong shape for falling
asleep**. A normal player asks you to choose an episode, shows you what's next,
and keeps a queue you feel obliged to manage. At 1am each of those is a small
decision, and decisions are the thing keeping you awake.

So:

- **No next-up.** You never see what's coming, because knowing invites waiting.
- **Shuffle, not a queue.** Episodes are picked from your feeds with a bias
  against ones you've already heard (`src/lib/plays.ts`). Opt in to "Favor
  what puts me under" and it also leans toward shows you've fallen asleep to
  and away from ones you skip, never ruling one out (`shuffleWeights` in
  `src/lib/rest/sleepscore.ts`).
- **The timer fades, it doesn't cut.** A hard stop wakes people. The fade is a
  volume ramp over the last stretch (`fadeVolume` in `src/lib/engine.ts`).
- **A dropped connection doesn't stop the night.** While an episode plays, it
  and the one picked to follow it download whole into the browser's cache,
  and the service worker plays them from there (`src/lib/offline-audio.ts`,
  `public/sw.js`). The next pick is made early but never shown: still no
  next-up. Settings → Keep playing without internet turns it off. Episodes
  over 250 MB (twelve-hour sound machines) stream instead.
- **A short list, not a search box.** Podcasts → More sleep podcasts offers
  shows picked by hand and checked for long episodes, recent activity and
  audio that can be saved offline (`src/lib/catalog.ts`, which records the
  checks). A directory search mostly turns up generated loops and ten-minute
  clips.
- **Your history is yours to carry.** Settings → Your history saves one JSON
  file with the feeds, settings, play ledger and every night the rest engine
  has logged, and restores it on another browser (`src/lib/backup.ts`).
  Nothing else keeps a copy, so this is the only way it survives a cleared
  browser or a new phone. Sleepcast asks the browser to keep its storage once
  there's a night in it, and the Rest tab reminds you to back up after 5
  nights with no backup, then after every 14 new ones (`src/lib/keep.ts`).
- **Your watch can say when you actually fell asleep.** An iPhone Shortcut
  reads Apple Watch sleep from Health and opens `/#watch=…` (or copies it
  for "Add from clipboard"). The watch's onset replaces the detector's guess
  for the night it falls in, keeping the guess to grade the detector by
  (`src/lib/rest/watch.ts`). The data rides after the `#`, so it never
  reaches the server. Setup steps are in Settings. The night's stages are
  kept too, and the Rest tab draws them: asleep, woke, awake in the night,
  REM, Core and Deep, with what played, when you touched the phone and
  Sleepcast's own guess on the same clock (`src/components/NightChart.tsx`).
  Over the nights, it shows your typical night, the last two weeks on one
  clock, and how the shows you fell asleep to compare
  (`src/lib/rest/trends.ts`). And it checks what wakes you: whether the
  watch sees you wake soon after a new episode starts, or after the sound
  stops, more often than chance would explain (`src/lib/rest/wakes.ts`).
  The watch also tunes Sleepcast's own guess, for nights you don't wear
  it: the middle difference between the two moves later guesses, when
  that would have brought past ones closer (`guessAccuracy` in
  `src/lib/rest/calibrate.ts`).
- **Experiments settle which show or timer works.** Pick two shows or two
  timer lengths; each night started from the moon gets one at random, kept
  even, and once both have their nights a rank-sum test says whether the
  faster one is faster beyond chance. Times stay hidden until then
  (`src/lib/rest/experiment.ts`). With "Favour what puts me under" on, a
  show that won leans the shuffle as much as any show can, and the show it
  beat no more than ×1 (`provenShows`). A timer that won is saved as
  "your timer" when you're done, and the Sleep screen sets it each night,
  ahead of the learned one, until you change it there
  (`src/lib/rest/kept-timer.ts`).
- **It asks how rested you feel.** One tap from 1 to 5 on the Rest tab, the
  morning after only. After 7 rated mornings it shows what goes with the
  rested ones (sleep, Deep, REM, wakings, bedtime and more), by rank
  correlation, calling a link clear only after a correction for testing
  several at once (`src/lib/rest/rested.ts`).
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

- `relay-guard.ts` allows only https URLs to named public hosts, on every
  redirect hop. The relay runs on Cloudflare Workers (`worker/relay.ts`),
  which cannot reach private networks, so a public name that resolves to a
  private address goes nowhere. **Move it to a host that can, and you must
  add DNS pinning back** (git history has the Node version that did).
- Workers rate limiting (`RELAY_LIMIT` in `wrangler.jsonc`) caps requests per
  IP. It bounds abuse; it is not an exact quota.
- The response body is sniffed and rejected if it is not a feed.
- There is a size cap (32MB — some real sleep podcast feeds are over 20MB).

If you fork this and remove those checks, you have built an open SSRF relay
that can reach your cloud metadata endpoint. Don't.

Feeds are cached at the edge for 30 minutes, and served from an older copy
when the feed's host is down. (The Cache API does nothing on a `workers.dev`
address, only on a custom domain.)

## Deploying

It runs on Cloudflare Workers, which is free at a personal app's traffic: the
pages are static files, and `/api/relay` is a small Worker.

```bash
npx wrangler login
npm run preview   # build, then run the Worker locally
npm run deploy    # build, then deploy
```

To serve it on your own domain, add it in the Cloudflare dashboard under the
Worker's Settings → Domains & Routes.

**Read `SECURITY.md` before putting this on the public internet.**

## Tests

```bash
npm test
```

The interesting ones are `src/lib/rest/*.test.ts` (the sleep detector, including
the simulation) and `src/lib/relay-guard.test.ts` (the SSRF cases).
