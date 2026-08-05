# What puts you under — Design Spec

**Date:** 2026-08-05
**Status:** Awaiting user review
**Owner:** nathanib
**Repo:** `sleepcast-player` (canonical for the rest engine; `sleepcast-site` consumes it via `vendor/player`)

---

## 1. Purpose

The app has recorded 90 nights of sleep-onset data and has never once used it
to decide anything. This makes it earn its keep: learn which shows actually put
this listener under, and say so.

The user's own framing of the problem was *"deciding what to play"* — the one
choice you don't want to make while tired. The answer is not to choose silently
on their behalf. It is to make the choice obvious and show the reasoning.

## 2. Goals

1. Every night records which show was playing when sleep was inferred.
2. A score per feed, derived from that, that survives being looked at.
3. One suggestion before a night starts, with its evidence beside it, and a way
   to disagree in one tap.
4. Nothing in the shuffle changes. The score suggests; it does not reweight.

## 3. Non-goals

- **No transcripts, no embeddings, no ASR.** Considered and declined this round.
- **No server, no accounts, no sync.** Everything stays in `localStorage` on the
  device, like the rest of the app.
- **No episode-level scoring.** See §6.
- **No silent reweighting of the shuffle.** See §8.
- Mixed YouTube + podcast lineups. Real, wanted, and a separate subsystem —
  its own spec.

## 4. The finding that changed the design

The first design was to join two stores that already exist:

```
onset wall-clock  =  RestNight.startedAt + RestNight.sleptAtMs
episode at onset  =  the Play whose [startedAt, startedAt + heardSec] contains it
```

**It does not work.** `plays.ts`:

```ts
export function recordHeard(plays: Play[], p: Play, cap = PLAYS_CAP): Play[] {
  const next = plays.filter((x) => x.id !== p.id);   // replaces
  next.push(p);
  return next.slice(-cap);
}
```

The play ledger is a **de-duplicated set of episodes you have heard**, not an
event log. Its own docstring says so: "A repeat listen replaces the earlier
entry instead of duplicating it, so the ledger holds distinct episodes." A
second listen overwrites the first one's `startedAt`.

So a retrospective join is silently partial — it succeeds only for episodes
that happen never to have been replayed since, and nothing records which of the
90 nights those are. A sleep model that is quietly wrong about its own evidence
is worse than one that admits it starts today.

**So: record the fact when it happens, rather than reconstructing it later.**
`RestSession` already holds the onset the moment the detector fires. It simply
has never been told what was playing.

The cost is stated plainly: **learning starts the night this ships.** The 90
stored nights contribute nothing to it. A best-effort backfill marked
"estimated" was considered and rejected — evidence you cannot audit is not
evidence.

## 5. Data model

`RestNight` gains four optional fields. Optional because every existing stored
night lacks them, and `loadNights()` must keep parsing those.

```ts
export interface RestNight {
  // ...unchanged
  /** Feed playing when sleep was inferred. Absent when no onset was detected,
   *  or for any night recorded before this shipped. */
  onsetFeedId?: string;
  onsetEpisodeId?: string;
  /** Feeds that auto-advanced after onset — played while you stayed under. */
  sleptThrough?: string[];
  /** Feeds you manually skipped or blocked this night. */
  skipped?: string[];
}
```

`RestSession` gains a timeline and a skip set, and resolves them in `finish()`:

```ts
private timeline: { t: number; feedId: string; episodeId: string }[] = [];
private skipped = new Set<string>();

/** Called whenever an episode starts. t is relative to night start, matching
 *  SleepOnset.atMs, so resolving onset is a comparison rather than a join. */
noteEpisode(feedId: string, episodeId: string, now?: number): void;

/** Called on Next and on "never again". */
noteSkip(feedId: string): void;
```

`finish()` then resolves, with no I/O and no ambiguity:

- `onset*` — the last timeline entry with `t <= onset.atMs`
- `sleptThrough` — feedIds of entries with `t > onset.atMs`
- `skipped` — the set, as an array

All of it lives in `src/lib/rest/session.ts`, which is already tested, rather
than in the player components — the components only call the two new methods.

## 6. Scoring

`sleepscore.py`'s credit assignment from `~/Projects/sleepcast`, ported to
TypeScript. New file: `src/lib/rest/sleepscore.ts`.

| Event | Credit | Why |
|---|---|---|
| Feed was playing at onset | **+2** | The strongest evidence available |
| Feed auto-advanced after onset | **+1** | You stayed under while it played |
| Feed manually skipped | **−1** | It did not work |

```
nightCredit(feed, night) = +2 onset | +1 sleptThrough | −1 skipped, summed
score(feed)              = Σ nightCredit over every night mentioning that feed
weight(feed)             = max(0.25, 1 + 0.25 × (score / nightsMentioning))
```

The mean is **per night that mentions the feed**, not per credit event and not
over all nights — a feed present on three nights out of ninety is judged on
those three.

`weight` ranks the suggestion in §7 and does nothing else in v1. It is shaped
as a multiplier rather than a raw score so that if §8 is ever revisited it can
drive `pickNextEpisode` without a redesign — but nothing multiplies by it yet,
and the tests assert that.

`WEIGHT_FLOOR = 0.25` is the important constant and comes straight from the
Python: **never zero a feed out.** A feed that scored badly on two nights has
not been disproved, and a scorer that eliminates its own exploration converges
on whatever it happened to try first.

**Feed-level, not episode-level.** Sleep With Me alone has 1,600 episodes and
`pickNextEpisode` actively prefers unheard ones, so per-episode credit would be
one observation per episode forever and would never converge. Feeds accumulate
dozens of nights.

**Confidence gate.** A feed with fewer than 3 scored nights is not ranked and
not suggested. With one night's evidence the app would state a preference it
does not have.

### Time-of-night conditioning

The user's own phrasing — *"after midnight"* — suggests the same show does not
work equally at every hour. Nights carry `startedAt`, so bucketing by local
start hour is free. But it splits already-thin evidence, so v1 computes it and
**only mentions it when a bucket independently clears the 3-night gate**. It
never drives the top-line suggestion.

## 7. Surface

Two places, both existing screens.

**Above the moon on `/app`**, when a suggestion clears the gate:

```
Boring Books for Bedtime leads tonight.
Gone in 14 min the last 3 times it led.
                                  [ start ]  [ something else ]
```

Never the pick alone. The pick and its evidence, always, and a one-tap refusal.
When nothing clears the gate the app says nothing — no "still learning" nag.

**In the existing rest view**, a "what puts you under" panel: feeds ranked, with
night counts, median time-to-sleep, and skip counts. This is the auditable half
— the reason the design is B rather than a black-box recommender. If the model
is wrong about the user, the user can see that it is wrong.

## 8. Why the shuffle is untouched

The score suggests and nothing else. A scorer that silently reweights nights
before it has been trusted is hard to notice going wrong: the pool quietly
narrows, the listener cannot tell whether the app learned something or broke,
and there is no baseline left to compare against. Reweighting is a later
decision, made with the panel in §7 as evidence, not an assumption baked in on
day one.

## 9. Error handling

| Case | Behaviour |
|---|---|
| Night with no onset (`sleptAtMs === null`) | Contributes `skipped` only; no onset credit |
| Nights recorded before this shipped | Parse fine, contribute nothing |
| No feed clears the 3-night gate | No suggestion rendered; no placeholder |
| Suggested feed is disabled or gone | Skip to the next qualifying feed; if none, render nothing |
| `timeline` empty at `finish()` | `onset*` absent; not an error |
| Onset earlier than the first timeline entry | `onset*` absent — a clock or resume artefact, not a fact worth inventing |

## 10. Testing

Everything above is pure functions over arrays, which is the point.

- **Resolution** — a timeline plus an `atMs`, asserting which entry wins:
  onset exactly on a boundary, onset before any entry, single-episode night,
  onset after the last entry.
- **Scoring** — hand-built `RestNight[]`, asserting per-feed scores and weights.
  Explicitly: a feed scored −1 twice still has `weight === 0.25`, never 0.
- **Gate** — 2 nights yields no suggestion, 3 does.
- **Legacy** — a `RestNight[]` with none of the new fields scores to empty and
  does not throw.
- **Time buckets** — a feed that qualifies overall but not in any hour bucket
  produces no time-conditioned claim.

The suggestion component gets a test that it renders the evidence line
alongside the pick, since the guarantee is that the pick never appears alone.

## 11. Open questions

1. **Where "skipped" ends and "not for me" begins.** `handleBlock` ("never
   again") already removes an episode permanently. Should it also cost the feed
   a point, or is blocking about the episode and not the show? v1 records both
   and counts them the same; revisit once real data exists.
2. **The onset detector's own accuracy.** Everything here inherits
   `sleptAtMs`. If the detector is systematically early or late, every credit is
   attributed to the wrong episode. `selfLabel` exists and could validate it;
   out of scope here, but worth knowing the whole feature rests on it.
3. **Whether 3 nights is the right gate.** Picked as the smallest number that
   is not one anecdote. No evidence behind it.
