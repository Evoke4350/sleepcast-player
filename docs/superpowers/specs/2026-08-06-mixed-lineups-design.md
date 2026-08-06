# Mixed YouTube + podcast nights — Design Spec

**Date:** 2026-08-06
**Status:** Awaiting user review
**Owner:** nathanib
**Repo:** `sleepcast-player` (canonical; `sleepcast-site` consumes it via `vendor/player`)

---

## 1. Purpose

A night is currently all-podcast or all-YouTube. A mixed lineup is refused
outright, with a sentence telling the listener to turn one kind off. This makes
one night able to play both.

The user named it as one of the two things that annoy them, alongside deciding
what to play. That one shipped 2026-08-06; this is the other.

## 2. The measurement that shaped the design

The two playback components share almost all of their logic and none of their
code:

```
duplicated in BOTH:  clearStopFade endSession extendTimer handleBlock handleNext
                     handleTogglePause heardTick holdEndCancel holdEndStart
                     persistLive playNext restTick tick tickGuarded      (14)
Player only:         playEpisode rememberCurrentPosition seekToRatio
                     skipBy dismissGettingUp                              (5)
YouTubeNight only:   startEpisode buildPlayer handleEnded handleError
                     freezeClock unfreezeClock flash                      (7)
```

2,122 lines across the two files, and the entire night orchestration —
countdown, fade, ledger, persistence, hold-to-end, extend, block — is written
twice.

**The drift is already real, not hypothetical.** On 2026-08-06 the sleep-onset
instrumentation had to be applied to both files separately, and the lock-screen
skip bug existed in `Player.tsx` alone — not because `YouTubeNight` got it
right, but because it registers no Media Session handlers at all. Two
implementations means two chances to be wrong and one review that has to be
pointed at both.

## 3. Goals

1. One night can contain both podcast and YouTube episodes.
2. **Zero regression risk to the podcast path.** It is what the user actually
   falls asleep to, it is 1,116 untested lines, and a break shows up at 1am.
3. A switch between backends never stalls the night.
4. The duplication has somewhere to go, later, without a rewrite.

## 4. Non-goals

- Merging `Player.tsx` and `YouTubeNight.tsx`. See §5.
- A loudness compressor on a mixed night. See §8.
- Seeking on a mixed night. See §8.
- Re-streaming or re-hosting anything. YouTube plays in Google's player.

## 5. Strangler, not a merge

`Player.tsx` is 1,116 lines, has **zero tests**, and works. Any refactor of it
is verified by reading, because this repo has no component-test framework — and
a subtle break is a night that fades wrong or a ledger that stops recording,
discovered in the morning.

So the new path takes only the case that has no incumbent:

```
all podcast  →  Player.tsx        untouched
all YouTube  →  YouTubeNight.tsx  untouched
mixed        →  Night.tsx         new
```

`isYouTubeLineup` and `isMixedLineup` already exist in `src/lib/youtube-night.ts`
and are tested, so the routing decision is already built.

The cost is three code paths for a while, and the duplication does not go away
today. It goes away when `Night.tsx` has run enough real nights to earn the
promotion, at which point the other two are deleted rather than edited. That is
a later decision made with evidence, not an assumption baked in now.

## 6. The backend interface already exists

`src/lib/youtube-media.ts` already has the imperative half of it:

```ts
play() / pause() / setVolume(0–1) / currentTime() / duration()
load(id, startSeconds) / destroy() / state()
```

Twenty tests, shipped, working. So most of this is not "design an abstraction"
but "write a second implementation of a proven one".

**The event half does need adapting, and the spec should not pretend
otherwise.** `YouTubeMedia` takes `onEnded` / `onError` as constructor
handlers, not as subscriptions — fine for a component that owns one player for
a whole night, wrong for an orchestrator that swaps backends per episode and
must be able to detach. So the interface below uses subscribe-and-unsubscribe,
and `YouTubeMedia` gains that shape alongside the constructor handlers it
already has. That is an additive change to a tested module, not a rewrite.

```ts
// src/lib/media/backend.ts
export interface MediaBackend {
  load(ref: string, startSeconds?: number): void;
  play(): void;
  pause(): void;
  /** 0–1, like HTMLMediaElement.volume. */
  setVolume(level: number): void;
  currentTime(): number;
  duration(): number;
  /** What it is actually doing, asked rather than mirrored — the same lesson
   *  YouTubeNight learned when a boolean it updated on three of six state
   *  codes rendered a Pause button over silence. */
  transport(): "playing" | "paused" | "buffering" | "awaiting-start";
  destroy(): void;
  /** Fires often enough to drive a 60-second fade. See §7. */
  onProgress(cb: () => void): () => void;
  onEnded(cb: () => void): () => void;
  onError(cb: (code: number | string) => void): () => void;
}
```

`ref` is an enclosure URL for audio and a videoId for YouTube. The orchestrator
picks the backend from `episode.youtubeId` and never inspects `ref` again.

## 7. The progress driver is the only genuinely new problem

`Player.tsx` drives the fade and the stop from the audio element's `timeupdate`
event, not from its `setInterval`, and the comment explaining why is
load-bearing: browsers throttle background intervals to roughly once a minute,
the phone is locked for nearly all of a sleep timer, so the 60-second fade was
being sampled once or twice and the stop landed late — the fade decaying into
the hard cut it exists to avoid, exactly when it mattered.

An iframe emits no such stream.

So **the backend owns its clock.** `onProgress` is wired to `timeupdate` by the
audio backend and to an interval by the YouTube backend. The orchestrator
subscribes and never learns which it got.

This is also the honest limit of a mixed night: while a YouTube episode is
playing, the fade is interval-driven and therefore vulnerable to throttling if
the screen sleeps. A YouTube night already requires the screen to stay on, so
this adds no new requirement — but it does mean the wake lock is held for the
whole night, not only during video (§8).

## 8. What a mixed night deliberately does not have

Recorded because silently missing is worse than absent.

| Absent | Why |
|---|---|
| The loudness compressor | `createMediaElementSource` cannot capture an iframe, and attaching it is a one-way door: a feed that later proves CORS-bad plays silence and reports nothing |
| Scrub bar and ±30s | Seeking is free on one backend and a round trip to Google's player on the other; a control that behaves differently depending on what happens to be playing is worse than no control |
| The drift game | The video is the visual |

Mixed nights get the minimal transport: **pause, next, hold-to-end.**

**The wake lock is held for the whole night**, not only while video plays — the
next switch could be into YouTube, and acquiring it at the transition is
acquiring it while the listener is asleep.

**The iframe stays mounted but hidden while a podcast plays.** Destroying it
would discard the playback permission the bedtime tap bought (§9), and creating
one mid-night is seconds of nothing. Hidden while paused is fine; it is visible
whenever it is playing.

## 9. Ordering: a mixed night leads with YouTube

Autoplay stops being a start-of-night problem and becomes a mid-night one.

Today the embed's refusal to autoplay is survivable: it happens at bedtime, the
listener is awake, they tap. On a mixed night a switch into YouTube can land at
2am while they are asleep, and if it needs a gesture the night stalls with the
timer still running — the worst failure this app has.

Browsers generally stop demanding a gesture once a video has actually played in
the session. So the first YouTube video is the expensive one, and **a mixed
night always opens on a YouTube episode.** One tap while awake unlocks the rest.

The constraint is only on position one. Everything after it shuffles normally.

`src/lib/mixed-night.ts` owns this and is tested: given a pool, choose a
YouTube lead by the ordinary freshness rule, and fall back to a podcast lead
only if the pool turns out to contain no playable YouTube episode.

## 10. Error handling

| Case | Behaviour |
|---|---|
| A YouTube episode never reaches `playing` inside the watchdog | Dead for tonight, night moves on — possibly to a podcast |
| Every YouTube episode is dead | The night continues as podcast-only rather than ending |
| The IFrame API never loads | The night runs podcast-only; YouTube episodes are skipped |
| An enclosure is dead or CORS-bad | Existing audio behaviour: skip, exactly as `Player.tsx` does |
| No playable episode of either kind | End the night; do not spin in silence |

A lineup the listener deliberately mixed can therefore quietly become
podcast-only. That is recorded in the night's ledger entry rather than hidden,
so the morning can show it.

## 11. Testing

- **Both backends** take an injected element or player, exactly as
  `youtube-media.ts` does, so both are unit-testable with no browser and no
  network. The audio backend's tests mirror the existing YouTube ones:
  readiness, volume conversion, inertness after `destroy`, and `onProgress`
  firing from `timeupdate`.
- **`mixed-night.ts`** is pure: pool in, lead out. Tests cover a pool with both
  kinds, a pool whose YouTube episodes are all blocked, and an empty pool.
- **`Night.tsx`** is a component, and this repo has no framework for those. It
  is verified by reading and by real nights — the same standing as the two
  components it sits beside. Every decision that can live in `src/lib` does.

## 12. Open questions

1. **Does the bedtime tap actually unlock later switches?** §9 rests on it, and
   it is browser behaviour this design cannot verify from a Linux box. The
   `youtube_tap_start` counter shipped 2026-08-06 and will show whether the
   embed ever autoplays at all. If it turns out never to, §9 is load-bearing;
   if it always autoplays, §9 is harmless but unnecessary.
2. **Whether a mixed night should score into "what puts you under" normally.**
   It records feed credit like any other night, and a YouTube feed and a
   podcast feed are both just feeds to the scorer. Left alone deliberately; if
   mixed nights turn out to be systematically better or worse, that will show
   up in the panel rather than being assumed here.
3. **When the other two components get deleted.** Not now. The trigger is
   `Night.tsx` running enough real nights without incident, which is a judgement
   call to be made with evidence.
