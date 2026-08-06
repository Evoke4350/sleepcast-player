# What Puts You Under — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Learn which podcast feeds actually put this listener to sleep, from data the app records at the moment it happens, and suggest one before a night starts — with its evidence beside it.

**Architecture:** `RestSession` already holds the inferred sleep onset but has never been told what was playing. It gains a timeline of episode starts and a set of skipped feeds, and resolves both against the onset in `finish()` — so attribution is a comparison inside an already-tested module, not a join across two stores. A pure scorer then rolls those per-night facts up per feed. The shuffle is untouched; the score only ranks a suggestion.

**Tech Stack:** TypeScript strict, React 19 islands, Vitest (jsdom), no new dependencies.

## Global Constraints

Copied from the spec (`docs/superpowers/specs/2026-08-05-what-puts-you-under-design.md`). Every task's requirements implicitly include these.

- **Credits:** onset feed `+2`, slept-through feed `+1`, skipped feed `−1`.
- **`WEIGHT_FLOOR = 0.25`** — never zero a feed out, or the scorer eliminates its own exploration and converges on whatever it tried first.
- **`MIN_NIGHTS = 3`** — a feed below this is not ranked and not suggested.
- **Feed-level only.** No episode-level scoring.
- **The shuffle is untouched.** `pickNextEpisode` must not change; nothing multiplies by `weight`.
- **The pick never appears without its evidence**, and always with a one-tap refusal.
- **No server, no accounts, no network.** Everything is `localStorage`, same as the rest of the app.
- New `RestNight` fields are **optional** — 90 stored nights lack them and `loadNights()` must keep parsing those.
- TypeScript `strict: true`. No `any` in `src/lib`.
- Every task ends green: `npm test && npm run typecheck` (Node 22: `mise exec node@22 -- npm test`).
- Comments explain *why*, not *what*.

## Prior art in this repo, so you don't duplicate it

`src/lib/plays.ts` already exports `playsSince(plays, fromMs)` and `playAtMoment(plays, atMs)`, and `RestView.tsx` uses them to show which episode was playing when you drifted off **last night**. That works for one recent night. It does **not** work across history, because `recordHeard` replaces by episode id — a repeat listen overwrites the earlier entry's `startedAt`, so the play ledger is a de-duplicated set of episodes heard, not an event log. That is why this feature records attribution at the time instead. **Leave `playAtMoment` and the RestView last-night display alone.**

## File Structure

| Path | Responsibility | Change |
|---|---|---|
| `src/lib/rest/types.ts` | `RestNight` gains four optional fields | modify |
| `src/lib/rest/session.ts` | timeline + skip set; resolve in `finish()` | modify |
| `src/lib/rest/sleepscore.ts` | credits → per-feed score, weight, ranking | **create** |
| `src/lib/rest/sleepscore.test.ts` | its tests | **create** |
| `src/components/Player.tsx` | call `noteEpisode` / `noteSkip` | modify |
| `src/components/YouTubeNight.tsx` | same, on the video path | modify |
| `src/components/SleepSetup.tsx` | the suggestion above the moon | modify |
| `src/components/RestView.tsx` | "what puts you under" panel | modify |

Test style in this repo is `describe` + `it` from vitest (see `src/lib/rest/session.test.ts`). Match it.

---

### Task 1: Record what was playing when sleep was inferred

**Files:**
- Modify: `src/lib/rest/types.ts`
- Modify: `src/lib/rest/session.ts`
- Test: `src/lib/rest/session.test.ts`

**Interfaces:**
- Consumes: `SleepOnset`, `RestNight` from `./types`
- Produces: `RestNight.onsetFeedId?`, `.onsetEpisodeId?`, `.sleptThrough?`, `.skipped?`; `RestSession.noteEpisode(feedId: string, episodeId: string, now?: number): void`; `RestSession.noteSkip(feedId: string): void`

- [ ] **Step 1: Add the fields to `RestNight` in `src/lib/rest/types.ts`**

Append inside the existing `RestNight` interface. All optional — every stored night predates them.

```ts
  /** Feed playing when sleep was inferred. Absent when no onset was detected,
   *  or for any night recorded before this shipped. */
  onsetFeedId?: string;
  onsetEpisodeId?: string;
  /** Feeds that auto-advanced after onset — they played while you stayed under. */
  sleptThrough?: string[];
  /** Feeds you manually skipped or blocked during the night. */
  skipped?: string[];
```

- [ ] **Step 2: Write the failing tests**

Append to `src/lib/rest/session.test.ts`. Read the top of that file first for its existing helpers and `beforeEach`.

```ts
describe("attributing sleep onset to what was playing", () => {
  /** Drive a session to a detected onset. Copied from the existing passing
   *  test at the top of this file — the detector only concludes once the fade
   *  is under way, which is why fadingOrDone turns on at tick 34 rather than
   *  at the start. Onset lands at 435_000ms — the detector backdates behind the tick that
   *  detected it, so the naive 34 * 15s = 510_000 is the wrong guess. */
  function sessionWithOnset(start: number) {
    const s = new RestSession(start, 60);
    for (let i = 0; i < 40; i++) {
      s.tick({ interacted: false, hidden: true, fadingOrDone: i >= 34, now: start + i * 15_000 });
    }
    return s;
  }

  it("credits the episode that was playing at the onset moment", () => {
    const start = 1_000_000;
    const s = sessionWithOnset(start);
    s.noteEpisode("swm", "ep1", start);
    s.noteEpisode("boring", "ep2", start + 10_000);
    const night = s.finish("faded", start + 900_000);
    expect(night.sleptAtMs).not.toBeNull();
    // Both started before onset; the LAST one before it is what was playing.
    expect(night.onsetFeedId).toBe("boring");
    expect(night.onsetEpisodeId).toBe("ep2");
  });

  it("records feeds that auto-advanced after onset as slept-through", () => {
    const start = 1_000_000;
    const s = sessionWithOnset(start);
    s.noteEpisode("swm", "ep1", start);              // before onset — it led
    s.noteEpisode("boring", "ep2", start + 700_000); // after onset (>510_000)
    const night = s.finish("faded", start + 900_000);
    expect(night.onsetFeedId).toBe("swm");
    expect(night.sleptThrough).toEqual(["boring"]);
  });

  it("does not list the onset feed as slept-through as well", () => {
    // A feed that led AND auto-advanced later earns onset credit once and
    // slept-through credit once, but must not be double-counted as one night's
    // worth of two different things in the same array.
    const start = 1_000_000;
    const s = sessionWithOnset(start);
    s.noteEpisode("swm", "ep1", start);
    s.noteEpisode("swm", "ep2", start + 700_000);
    const night = s.finish("faded", start + 900_000);
    expect(night.onsetFeedId).toBe("swm");
    expect(night.sleptThrough).toEqual(["swm"]);
  });

  it("records skips, and does so even when no onset was ever detected", () => {
    // A night where the listener stayed awake still tells you what failed.
    const s = new RestSession(1_000_000, 45);
    s.noteEpisode("swm", "ep1", 1_000_000);
    s.noteSkip("swm");
    const night = s.finish("ended", 1_100_000);
    expect(night.sleptAtMs).toBeNull();
    expect(night.onsetFeedId).toBeUndefined();
    expect(night.skipped).toEqual(["swm"]);
  });

  it("does not repeat a feed skipped twice", () => {
    const s = new RestSession(1_000_000, 45);
    s.noteSkip("swm");
    s.noteSkip("swm");
    expect(s.finish("ended", 1_100_000).skipped).toEqual(["swm"]);
  });

  it("leaves onset absent when nothing had started yet", () => {
    // A clock or resume artefact. Better absent than invented.
    const s = sessionWithOnset(1_000_000);
    const night = s.finish("faded", 1_900_000);
    expect(night.onsetFeedId).toBeUndefined();
    expect(night.sleptThrough).toBeUndefined();
  });

  it("omits the fields entirely rather than writing empty arrays", () => {
    // loadNights() parses 90 stored nights without them; absent and [] must
    // not become two different shapes in the ledger.
    const s = new RestSession(1_000_000, 45);
    const night = s.finish("ended", 1_100_000);
    expect("skipped" in night).toBe(false);
    expect("sleptThrough" in night).toBe(false);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `mise exec node@22 -- npx vitest run --environment jsdom src/lib/rest/session.test.ts`
Expected: FAIL — `s.noteEpisode is not a function`.

- [ ] **Step 4: Implement in `src/lib/rest/session.ts`**

Add the private state near the other private fields:

```ts
  /** Episode starts, t relative to night start so it compares directly with
   *  SleepOnset.atMs. This is why attribution is a comparison and not a join
   *  against the play ledger, which de-duplicates by episode id and so cannot
   *  answer "what was playing then" for any night but the most recent. */
  private timeline: { t: number; feedId: string; episodeId: string }[] = [];
  private skipped = new Set<string>();
```

Add the two methods:

```ts
  /** Called whenever an episode starts playing. */
  noteEpisode(feedId: string, episodeId: string, now: number = Date.now()): void {
    this.timeline.push({ t: now - this.startedAt, feedId, episodeId });
  }

  /** Called on Next and on "never again" — both mean this one didn't work. */
  noteSkip(feedId: string): void {
    this.skipped.add(feedId);
  }
```

Replace `finish()` with:

```ts
  finish(endedVia: RestNight["endedVia"], now: number): RestNight {
    const atMs = this.onset ? this.onset.atMs : null;
    const at = atMs === null ? null : this.timeline.filter((e) => e.t <= atMs).at(-1);
    const after = atMs === null ? [] : this.timeline.filter((e) => e.t > atMs);
    const sleptThrough = [...new Set(after.map((e) => e.feedId))];

    return {
      startedAt: this.startedAt,
      timerMinutes: this.timerMinutes,
      endedVia,
      sleptAtMs: atMs,
      timeToSleepMs: atMs,
      interactions: this.interactions,
      detector: this.onset ? "inference" : "none",
      // Spread rather than assign: an absent field and an empty array must not
      // become two shapes in a ledger that already holds 90 nights without them.
      ...(at ? { onsetFeedId: at.feedId, onsetEpisodeId: at.episodeId } : {}),
      ...(sleptThrough.length ? { sleptThrough } : {}),
      ...(this.skipped.size ? { skipped: [...this.skipped] } : {}),
    };
  }
```

- [ ] **Step 5: Run them and watch them pass**

Run: `mise exec node@22 -- npx vitest run --environment jsdom src/lib/rest/session.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `mise exec node@22 -- npm test && mise exec node@22 -- npm run typecheck`
Expected: all suites pass, 0 typecheck errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/rest/types.ts src/lib/rest/session.ts src/lib/rest/session.test.ts
git commit -m "Record what was playing when the detector concluded"
```

---

### Task 2: Score feeds by what actually worked

**Files:**
- Create: `src/lib/rest/sleepscore.ts`
- Create: `src/lib/rest/sleepscore.test.ts`

**Interfaces:**
- Consumes: `RestNight` from `./types`
- Produces: `CREDIT_ONSET`, `CREDIT_SLEPT`, `PENALTY_SKIP`, `WEIGHT_FLOOR`, `MIN_NIGHTS`; `interface FeedScore { feedId: string; score: number; nights: number; weight: number; onsetNights: number; skipNights: number }`; `scoreFeeds(nights: readonly RestNight[]): FeedScore[]`; `rankedFeeds(nights: readonly RestNight[]): FeedScore[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { scoreFeeds, rankedFeeds, WEIGHT_FLOOR, MIN_NIGHTS } from "./sleepscore";
import type { RestNight } from "./types";

const night = (over: Partial<RestNight>): RestNight => ({
  startedAt: 1_000_000,
  timerMinutes: 45,
  endedVia: "faded",
  sleptAtMs: 900_000,
  timeToSleepMs: 900_000,
  interactions: 0,
  detector: "inference",
  ...over,
});

const onset = (feedId: string, startedAt = 1_000_000) =>
  night({ startedAt, onsetFeedId: feedId, onsetEpisodeId: `${feedId}-ep` });

describe("scoring a feed by what it did", () => {
  it("gives the onset feed the most credit", () => {
    const [f] = scoreFeeds([onset("swm")]);
    expect(f.feedId).toBe("swm");
    expect(f.score).toBe(2);
    expect(f.onsetNights).toBe(1);
  });

  it("gives a slept-through feed less than the onset feed", () => {
    const s = scoreFeeds([night({ onsetFeedId: "swm", sleptThrough: ["boring"] })]);
    const by = Object.fromEntries(s.map((f) => [f.feedId, f.score]));
    expect(by.swm).toBe(2);
    expect(by.boring).toBe(1);
  });

  it("penalises a skipped feed", () => {
    const [f] = scoreFeeds([night({ sleptAtMs: null, detector: "none", skipped: ["swm"] })]);
    expect(f.score).toBe(-1);
    expect(f.skipNights).toBe(1);
  });

  it("counts nights the feed appeared in, not nights in the ledger", () => {
    // A feed on 2 of 50 nights is judged on those 2.
    const nights = [onset("swm"), onset("swm"), ...Array.from({ length: 48 }, () => onset("boring"))];
    const swm = scoreFeeds(nights).find((f) => f.feedId === "swm")!;
    expect(swm.nights).toBe(2);
  });

  it("never zeroes a feed out, however badly it scored", () => {
    // WEIGHT_FLOOR is load-bearing: a scorer that eliminates its own
    // exploration converges on whatever it happened to try first.
    const bad = Array.from({ length: 9 }, () =>
      night({ sleptAtMs: null, detector: "none", skipped: ["swm"] }),
    );
    const [f] = scoreFeeds(bad);
    expect(f.score).toBe(-9);
    expect(f.weight).toBe(WEIGHT_FLOOR);
    expect(f.weight).toBeGreaterThan(0);
  });

  it("a feed that always works scores above one", () => {
    const [f] = scoreFeeds([onset("swm"), onset("swm"), onset("swm")]);
    expect(f.weight).toBeGreaterThan(1);
  });

  it("ignores nights recorded before any of this existed", () => {
    // 90 stored nights have none of the new fields and must not throw.
    expect(scoreFeeds([night({}), night({})])).toEqual([]);
  });

  it("handles an empty ledger", () => {
    expect(scoreFeeds([])).toEqual([]);
  });
});

describe("ranking, and the confidence gate", () => {
  it("does not rank a feed below the night threshold", () => {
    const thin = Array.from({ length: MIN_NIGHTS - 1 }, () => onset("swm"));
    expect(rankedFeeds(thin)).toEqual([]);
  });

  it("ranks it once the threshold is reached", () => {
    const enough = Array.from({ length: MIN_NIGHTS }, () => onset("swm"));
    expect(rankedFeeds(enough).map((f) => f.feedId)).toEqual(["swm"]);
  });

  it("puts the better feed first", () => {
    const nights = [
      ...Array.from({ length: 3 }, () => onset("boring")),
      ...Array.from({ length: 3 }, () => night({ sleptAtMs: null, detector: "none", skipped: ["swm"] })),
    ];
    expect(rankedFeeds(nights)[0].feedId).toBe("boring");
  });

  it("breaks ties deterministically, so the suggestion does not flicker", () => {
    // Two feeds with identical evidence must not swap places between renders.
    const nights = [
      ...Array.from({ length: 3 }, () => onset("aaa")),
      ...Array.from({ length: 3 }, () => onset("bbb")),
    ];
    const a = rankedFeeds(nights).map((f) => f.feedId);
    const b = rankedFeeds(nights).map((f) => f.feedId);
    expect(a).toEqual(b);
    expect(a).toEqual(["aaa", "bbb"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `mise exec node@22 -- npx vitest run --environment jsdom src/lib/rest/sleepscore.test.ts`
Expected: FAIL — cannot resolve `./sleepscore`.

- [ ] **Step 3: Implement `src/lib/rest/sleepscore.ts`**

```ts
// Which feeds actually put this listener under.
//
// Ported from sleepscore.py in the private engine (~/Projects/sleepcast), whose
// insight is that manual actions prove wakefulness: if the timer outlived the
// listener, whatever was playing at the moment the detector concluded earns the
// credit, whatever auto-advanced afterwards earns a little, and whatever they
// reached over and skipped earns a penalty.
//
// Feed-level, not episode-level, and that is not a simplification. Sleep With Me
// alone has 1,600 episodes and pickNextEpisode actively prefers unheard ones, so
// per-episode credit would be one observation per episode forever and would
// never converge on anything. Feeds accumulate dozens of nights.

import type { RestNight } from "./types";

export const CREDIT_ONSET = 2;
export const CREDIT_SLEPT = 1;
export const PENALTY_SKIP = -1;

/** Never zero a feed out. A feed that scored badly twice has not been
 *  disproved, and a scorer that eliminates its own exploration converges on
 *  whatever it happened to try first. */
export const WEIGHT_FLOOR = 0.25;

/** Below this many nights a feed is not ranked and not suggested — with one
 *  night's evidence the app would state a preference it does not have. */
export const MIN_NIGHTS = 3;

const WEIGHT_SLOPE = 0.25;

export interface FeedScore {
  feedId: string;
  /** Sum of credits across every night this feed appeared in. */
  score: number;
  /** Nights this feed appeared in — not nights in the ledger. */
  nights: number;
  /** max(WEIGHT_FLOOR, 1 + slope × mean credit). Ranks the suggestion and
   *  nothing else: the shuffle is deliberately untouched (see the spec, §8). */
  weight: number;
  onsetNights: number;
  skipNights: number;
}

export function scoreFeeds(nights: readonly RestNight[]): FeedScore[] {
  const acc = new Map<string, { score: number; nights: number; onset: number; skips: number }>();
  const bump = (feedId: string, delta: number, kind?: "onset" | "skip") => {
    const e = acc.get(feedId) ?? { score: 0, nights: 0, onset: 0, skips: 0 };
    e.score += delta;
    if (kind === "onset") e.onset++;
    if (kind === "skip") e.skips++;
    acc.set(feedId, e);
  };

  for (const n of nights) {
    // Count each feed once per night, so a feed appearing twice in one night's
    // records does not inflate its night count and dilute its mean.
    const seen = new Set<string>();
    if (n.onsetFeedId) {
      bump(n.onsetFeedId, CREDIT_ONSET, "onset");
      seen.add(n.onsetFeedId);
    }
    for (const f of n.sleptThrough ?? []) {
      bump(f, CREDIT_SLEPT);
      seen.add(f);
    }
    for (const f of n.skipped ?? []) {
      bump(f, PENALTY_SKIP, "skip");
      seen.add(f);
    }
    for (const f of seen) acc.get(f)!.nights++;
  }

  return [...acc.entries()]
    .map(([feedId, e]) => ({
      feedId,
      score: e.score,
      nights: e.nights,
      weight: Math.max(WEIGHT_FLOOR, 1 + WEIGHT_SLOPE * (e.score / e.nights)),
      onsetNights: e.onset,
      skipNights: e.skips,
    }))
    // feedId is the tiebreak so the suggestion does not flicker between renders
    // on feeds with identical evidence.
    .sort((a, b) => b.weight - a.weight || a.feedId.localeCompare(b.feedId));
}

/** Scored feeds with enough evidence to say anything about. */
export function rankedFeeds(nights: readonly RestNight[]): FeedScore[] {
  return scoreFeeds(nights).filter((f) => f.nights >= MIN_NIGHTS);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `mise exec node@22 -- npx vitest run --environment jsdom src/lib/rest/sleepscore.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rest/sleepscore.ts src/lib/rest/sleepscore.test.ts
git commit -m "Score feeds by what actually put this listener under"
```

---

### Task 3: The evidence line

The suggestion never appears without its reason. That sentence is a decision, not a string, so it gets its own tested function rather than being assembled inline in JSX.

**Files:**
- Modify: `src/lib/rest/sleepscore.ts`
- Modify: `src/lib/rest/sleepscore.test.ts`

**Interfaces:**
- Consumes: `FeedScore`, `RestNight`
- Produces: `medianTimeToSleep(nights: readonly RestNight[], feedId: string): number | null`; `evidenceFor(nights: readonly RestNight[], f: FeedScore): string`

- [ ] **Step 1: Write the failing test**

```ts
import { medianTimeToSleep, evidenceFor } from "./sleepscore";

describe("the evidence beside the pick", () => {
  it("takes the median time-to-sleep over nights this feed led", () => {
    const nights = [
      night({ onsetFeedId: "swm", timeToSleepMs: 600_000 }),
      night({ onsetFeedId: "swm", timeToSleepMs: 900_000 }),
      night({ onsetFeedId: "swm", timeToSleepMs: 1_800_000 }),
      night({ onsetFeedId: "boring", timeToSleepMs: 60_000 }),
    ];
    expect(medianTimeToSleep(nights, "swm")).toBe(900_000);
  });

  it("is null when the feed never led a night", () => {
    expect(medianTimeToSleep([onset("boring")], "swm")).toBeNull();
  });

  it("states the count and the median, both of which are checkable", () => {
    const nights = Array.from({ length: 3 }, () =>
      night({ onsetFeedId: "swm", timeToSleepMs: 840_000 }),
    );
    const [f] = rankedFeeds(nights);
    const line = evidenceFor(nights, f);
    expect(line).toMatch(/14 min/);
    expect(line).toMatch(/3/);
  });

  it("says something true when the feed has only ever been skipped", () => {
    // No onset nights means no median. The line must not claim a time.
    const nights = Array.from({ length: 3 }, () =>
      night({ sleptAtMs: null, detector: "none", skipped: ["swm"] }),
    );
    const [f] = scoreFeeds(nights);
    const line = evidenceFor(nights, f);
    expect(line).not.toMatch(/\bmin\b/);
    expect(line).toMatch(/skipped/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `mise exec node@22 -- npx vitest run --environment jsdom src/lib/rest/sleepscore.test.ts`
Expected: FAIL — `medianTimeToSleep is not a function`.

- [ ] **Step 3: Implement, appending to `src/lib/rest/sleepscore.ts`**

```ts
/** Median time-to-sleep across nights this feed was playing at onset, or null
 *  if it never led one. Median rather than mean: one 3am night that ran the
 *  whole timer would drag an average and misdescribe every other night. */
export function medianTimeToSleep(
  nights: readonly RestNight[],
  feedId: string,
): number | null {
  const times = nights
    .filter((n) => n.onsetFeedId === feedId && n.timeToSleepMs !== null)
    .map((n) => n.timeToSleepMs as number)
    .sort((a, b) => a - b);
  if (!times.length) return null;
  const mid = Math.floor(times.length / 2);
  return times.length % 2 ? times[mid] : Math.round((times[mid - 1] + times[mid]) / 2);
}

/**
 * The sentence that appears beside the pick. Every claim in it is checkable
 * against the panel in the rest view — that is the point of showing it rather
 * than just picking.
 */
export function evidenceFor(nights: readonly RestNight[], f: FeedScore): string {
  const median = medianTimeToSleep(nights, f.feedId);
  if (median === null) {
    return f.skipNights > 0
      ? `You've skipped it on ${f.skipNights} of ${f.nights} nights.`
      : `It's played on ${f.nights} nights.`;
  }
  const mins = Math.round(median / 60_000);
  const led = f.onsetNights;
  return `Gone in ${mins} min the last ${led} time${led === 1 ? "" : "s"} it led.`;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `mise exec node@22 -- npx vitest run --environment jsdom src/lib/rest/sleepscore.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rest/sleepscore.ts src/lib/rest/sleepscore.test.ts
git commit -m "Say why, in a sentence whose every claim is checkable"
```

---

### Task 4: Feed the timeline from both players

Nothing above records anything until the players call it. Both playback paths must, or a YouTube night silently teaches the model nothing.

**Files:**
- Modify: `src/components/Player.tsx`
- Modify: `src/components/YouTubeNight.tsx`

**Interfaces:**
- Consumes: `RestSession.noteEpisode(feedId, episodeId, now?)`, `RestSession.noteSkip(feedId)`
- Produces: nothing — this is wiring

- [ ] **Step 1: In `Player.tsx`, record every episode start**

In `playEpisode(ep, seekTo)`, immediately after `currentFeedRef.current = ep.feedId;`, add:

```ts
    // The rest session infers WHEN sleep began; only the player knows WHAT was
    // playing. Told here rather than reconstructed later, because the play
    // ledger de-duplicates by episode id and cannot answer this for any night
    // but the most recent.
    restRef.current?.noteEpisode(ep.feedId, ep.id);
```

- [ ] **Step 2: In `Player.tsx`, record skips**

`handleNext` currently calls `restRef.current?.noteInteraction()` then `playNext()`. Add the skip, using the episode being left:

```ts
  function handleNext() {
    restRef.current?.noteInteraction();
    const leaving = currentEpRef.current;
    if (leaving) restRef.current?.noteSkip(leaving.feedId);
    playNext();
  }
```

In `handleBlock`, after `blockEpisode(ep.id);` add:

```ts
    restRef.current?.noteSkip(ep.feedId);
```

- [ ] **Step 3: Make the same three changes in `YouTubeNight.tsx`**

In `startEpisode(ep, seekTo)`, after `currentFeedRef.current = ep.feedId;`:

```ts
    restRef.current?.noteEpisode(ep.feedId, ep.id);
```

In `handleNext`:

```ts
  function handleNext() {
    restRef.current?.noteInteraction();
    const leaving = currentEpRef.current;
    if (leaving) restRef.current?.noteSkip(leaving.feedId);
    playNext();
  }
```

In `handleBlock`, after `blockEpisode(ep.id);`:

```ts
    restRef.current?.noteSkip(ep.feedId);
```

- [ ] **Step 4: Verify nothing regressed**

Run: `mise exec node@22 -- npm test && mise exec node@22 -- npm run typecheck`
Expected: all suites pass, 0 errors.

There are no component tests in this repo, so this task's correctness rests on the calls being in the right places. Re-read each of the six edits and confirm: `noteEpisode` fires on every path that starts an episode (including the resume and lead-episode paths, which both route through `playEpisode` / `startEpisode`), and `noteSkip` names the feed being **left**, not the one being started.

- [ ] **Step 5: Commit**

```bash
git add src/components/Player.tsx src/components/YouTubeNight.tsx
git commit -m "Tell the rest session what is playing, on both paths"
```

---

### Task 5: The suggestion, above the moon

**Files:**
- Modify: `src/components/SleepSetup.tsx`

**Interfaces:**
- Consumes: `rankedFeeds`, `evidenceFor` from `../lib/rest/sleepscore`; `loadNights` from `../lib/rest/ledger`; existing `appState.feeds`, `beginNight(lead)`
- Produces: nothing — this is the surface

- [ ] **Step 1: Compute the suggestion**

Near the other `useMemo`s in `SleepSetup`, add:

```ts
  // Read once. This screen is not live while a night runs, and re-ranking on
  // every render would let the suggestion change under the user's thumb.
  const suggestion = useMemo(() => {
    const nights = loadNights();
    for (const f of rankedFeeds(nights)) {
      const feed = appState.feeds.find((x) => x.id === f.feedId && x.enabled);
      if (feed) return { feed, line: evidenceFor(nights, f) };
    }
    return null;
  }, [appState.feeds]);
```

The loop skips down the ranking rather than giving up: the top feed may have been disabled or removed since it earned its score.

- [ ] **Step 2: Render it above the moon**

Place it immediately before the golden-path moon button. It renders nothing when there is no suggestion — no "still learning" placeholder, which would be a nag that never resolves for a new listener.

```tsx
  {suggestion && (
    <div className="mb-4 rounded-xl border border-[#3a3325] bg-[#171310] p-4 text-center">
      <p className="text-sm text-[#d9c9a8]">
        {suggestion.feed.title} leads tonight.
      </p>
      <p className="mt-1 text-xs text-[#8a7a5c]">{suggestion.line}</p>
      <div className="mt-3 flex justify-center gap-3 text-sm">
        <button
          onClick={() => beginNight(leadFromFeed(suggestion.feed.id))}
          className="rounded-full border border-[#6e5d44] px-4 py-1.5 text-[#f0dcb8] transition-colors hover:border-[#8a7a5c]"
        >
          start
        </button>
        <button
          onClick={() => beginNight(null)}
          className="rounded-full border border-[#3a3325] px-4 py-1.5 text-[#8a7a5c] transition-colors hover:border-[#6e5d44]"
        >
          something else
        </button>
      </div>
    </div>
  )}
```

- [ ] **Step 3: Add `leadFromFeed`**

The suggestion names a feed; `beginNight` takes a lead **episode**. Pick from that feed using the same freshness rule the shuffle uses, so the suggestion does not hand back something heard last night.

```ts
  /** An episode from the suggested feed, chosen by the ordinary freshness
   *  rule. Returns null if the feed's episodes have not loaded yet, in which
   *  case the night starts shuffled — the same as tapping the moon. */
  function leadFromFeed(feedId: string): Episode | null {
    const fromFeed = pool.filter((e) => e.feedId === feedId);
    return fromFeed.length ? pickNextEpisode(fromFeed, getPlays()) : null;
  }
```

Add `pickNextEpisode` to the existing `../lib/plays` import and `getPlays` to the existing `../lib/store` import.

- [ ] **Step 4: Verify**

Run: `mise exec node@22 -- npm test && mise exec node@22 -- npm run typecheck`
Expected: all pass, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/SleepSetup.tsx
git commit -m "Suggest a feed, and say why, above the moon"
```

---

### Task 6: The panel that lets you catch it being wrong

**Files:**
- Modify: `src/components/RestView.tsx`

**Interfaces:**
- Consumes: `scoreFeeds`, `medianTimeToSleep` from `../lib/rest/sleepscore`; `loadNights`; existing `appState.feeds` titles via `loadState()`
- Produces: nothing

**Leave the existing last-night display alone**, including its `playAtMoment` join. That answers a different question ("what were you listening to last night") and works fine for one recent night.

- [ ] **Step 1: Compute the table**

```ts
  const feedTitles = useMemo(() => {
    const s = loadState();
    return Object.fromEntries(s.feeds.map((f) => [f.id, f.title]));
  }, []);

  // scoreFeeds, not rankedFeeds: the panel shows everything including feeds
  // below the suggestion threshold. Its whole job is to be auditable, and
  // hiding the thin evidence would defeat that.
  const scored = useMemo(() => scoreFeeds(nights), [nights]);
```

- [ ] **Step 2: Render it**

```tsx
  {scored.length > 0 && (
    <section className="mt-8">
      <h2 className="text-xs uppercase tracking-widest text-[#4a4540]">
        what puts you under
      </h2>
      <ul className="mt-2 space-y-1.5">
        {scored.map((f) => {
          const median = medianTimeToSleep(nights, f.feedId);
          return (
            <li key={f.feedId} className="flex items-baseline gap-2 text-sm">
              <span className="flex-1 truncate text-[#b0a898]">
                {feedTitles[f.feedId] ?? f.feedId}
              </span>
              <span className="shrink-0 text-xs text-[#8a7a5c]">
                {median === null ? "—" : `${Math.round(median / 60_000)} min`}
              </span>
              <span className="shrink-0 text-[10px] text-[#4a4540]">
                {f.nights} night{f.nights === 1 ? "" : "s"}
                {f.skipNights > 0 ? ` · ${f.skipNights} skipped` : ""}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] leading-snug text-[#4a4540]">
        Ranked by what was playing when you went under. Feeds with fewer than
        three nights are listed but never suggested.
      </p>
    </section>
  )}
```

- [ ] **Step 3: Verify**

Run: `mise exec node@22 -- npm test && mise exec node@22 -- npm run typecheck`
Expected: all pass, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/RestView.tsx
git commit -m "Show the working, so a wrong model can be seen to be wrong"
```

---

## Deferred, on purpose

- **Time-of-night conditioning** (spec §6). Computable from `RestNight.startedAt`, but it splits already-thin evidence and needs its own bucket-level confidence gate. Worth doing once there are enough nights to split.
- **Reweighting the shuffle** (spec §8). Deliberately not now: a scorer that silently narrows the pool before it has been trusted is hard to notice going wrong, and there would be no baseline left to compare against.
- **Validating the detector against `selfLabel`** (spec open question 2). Every credit here inherits `sleptAtMs`. If the detector is systematically early or late, every attribution lands on the wrong episode — and nothing in this plan would reveal that.

## Still open after this plan

1. Whether a blocked episode ("never again") should cost its feed a point. This plan counts it the same as a skip; revisit on real data.
2. Whether `MIN_NIGHTS = 3` is right. Chosen as the smallest number that is not one anecdote, with no evidence behind it.
