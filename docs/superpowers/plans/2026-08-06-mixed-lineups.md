# Mixed Lineups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One night that plays both podcast episodes and YouTube videos, switching between them without stalling.

**Architecture:** A `MediaBackend` interface both playback mechanisms implement. `YouTubeMedia` already has its imperative half and gains subscribe-shaped events; a new `AudioBackend` wraps `HTMLAudioElement` to match. A new `Night.tsx` orchestrates using only that interface, and is routed to **only for mixed lineups** — `Player.tsx` and `YouTubeNight.tsx` are untouched.

**Tech Stack:** TypeScript strict, React 19 islands, Vitest (jsdom), no new dependencies.

## Global Constraints

From the spec (`docs/superpowers/specs/2026-08-06-mixed-lineups-design.md`).

- **`Player.tsx` and `YouTubeNight.tsx` must not be modified by any task in this plan.** That is the entire risk posture: they work, they have no tests, and a break shows up at 1am.
- **A mixed night always opens on a YouTube episode.** One tap while awake unlocks the session; the same refusal at 2am stalls the night with the timer running.
- **The wake lock is held for the whole night**, not only while video plays.
- **The iframe stays mounted while a podcast plays** — destroying it discards the playback permission the bedtime tap bought. Hidden while paused, visible whenever playing.
- Mixed nights get the minimal transport: **pause, next, hold-to-end.** No scrub bar, no ±30s, no loudness compressor, no drift game.
- **Never suppress, mute, skip or hide a YouTube ad.** Circumvention, not a feature.
- A night must never stall: an episode that will not start is dead for tonight and the night moves on.
- TypeScript `strict: true`. No `any` in `src/lib`.
- Every task ends green: `mise exec node@22 -- npm test && mise exec node@22 -- npm run typecheck`. **Every command in this plan needs the `mise exec node@22 --` prefix** — system Node is 18 and fails with `SyntaxError: ... 'node:util' does not provide an export named 'styleText'`, which names nothing useful.
- Comments explain *why*, not *what*.
- Test style is `describe` + `it` from vitest.

## File Structure

| Path | Responsibility | Change |
|---|---|---|
| `src/lib/media/backend.ts` | `MediaBackend` interface + `Transport` type | **create** |
| `src/lib/media/audio-backend.ts` | `HTMLAudioElement` → `MediaBackend` | **create** |
| `src/lib/media/audio-backend.test.ts` | its tests | **create** |
| `src/lib/youtube-media.ts` | gains `on*` subscriptions + `transport()` | modify |
| `src/lib/mixed-night.ts` | lead selection: a mixed night opens on YouTube | **create** |
| `src/lib/mixed-night.test.ts` | its tests | **create** |
| `src/components/Night.tsx` | the orchestrator | **create** |
| `src/components/AppPlayer.tsx` | route mixed lineups to `Night` | modify |
| `src/components/SleepSetup.tsx` | stop refusing mixed lineups | modify |

`isYouTubeLineup` and `isMixedLineup` already exist in `src/lib/youtube-night.ts` and are tested — do not reimplement them.

---

### Task 1: The backend interface and the audio implementation

**Files:**
- Create: `src/lib/media/backend.ts`
- Create: `src/lib/media/audio-backend.ts`
- Test: `src/lib/media/audio-backend.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type Transport = "playing" | "paused" | "buffering" | "awaiting-start"`; `interface MediaBackend`; `class AudioBackend implements MediaBackend` constructed as `new AudioBackend(el: HTMLAudioElement)`

- [ ] **Step 1: Write `src/lib/media/backend.ts`**

```ts
// What a night needs from a thing that makes sound.
//
// Two implementations: an <audio> element and Google's embedded player. The
// orchestrator talks only to this and never learns which it got — which is the
// whole point, because a mixed night switches between them mid-flight.

/** What the source is actually doing. Four values, not a boolean: "hasn't
 *  started" and "paused" are different, and conflating them is what once
 *  rendered a Pause button over silence. */
export type Transport = "playing" | "paused" | "buffering" | "awaiting-start";

export interface MediaBackend {
  /** An enclosure URL for audio, a videoId for YouTube. The orchestrator picks
   *  the backend from episode.youtubeId and never inspects this again. */
  load(ref: string, startSeconds?: number): void;
  play(): void;
  pause(): void;
  /** 0–1, like HTMLMediaElement.volume. */
  setVolume(level: number): void;
  currentTime(): number;
  duration(): number;
  transport(): Transport;
  destroy(): void;

  /** Fires often enough to drive a 60-second fade. Each implementation owns
   *  its own clock: an <audio> has timeupdate, which keeps firing through a
   *  locked screen; an iframe has nothing and must poll. Returns an
   *  unsubscribe, because the orchestrator swaps backends per episode and a
   *  handler that outlives its backend fires against a dead one. */
  onProgress(cb: () => void): () => void;
  onEnded(cb: () => void): () => void;
  onError(cb: (code: number | string) => void): () => void;
}
```

- [ ] **Step 2: Write the failing test**

`src/lib/media/audio-backend.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { AudioBackend } from "./audio-backend";

/** A stand-in for HTMLAudioElement: real listener bookkeeping, settable
 *  readonly-in-the-DOM properties, and a way to fire events by hand. */
function fakeAudio() {
  const listeners = new Map<string, Set<EventListener>>();
  const el = {
    src: "",
    currentTime: 0,
    duration: 0,
    volume: 1,
    paused: true,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    addEventListener: (t: string, cb: EventListener) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(cb);
    },
    removeEventListener: (t: string, cb: EventListener) => {
      listeners.get(t)?.delete(cb);
    },
  } as unknown as HTMLAudioElement;
  return {
    el,
    fire: (t: string) => listeners.get(t)?.forEach((cb) => cb(new Event(t))),
    count: (t: string) => listeners.get(t)?.size ?? 0,
  };
}

describe("driving an audio element through the backend interface", () => {
  it("loading points the element at the enclosure and plays it", () => {
    const { el } = fakeAudio();
    new AudioBackend(el).load("https://x.test/a.mp3");
    expect(el.src).toBe("https://x.test/a.mp3");
    expect(el.play).toHaveBeenCalled();
  });

  it("a start position is applied once metadata arrives, not before", () => {
    // currentTime cannot be set until the element knows the duration; setting
    // it early is silently discarded and the listener restarts a 90-minute
    // episode from the top.
    const { el, fire } = fakeAudio();
    new AudioBackend(el).load("https://x.test/a.mp3", 1830);
    expect(el.currentTime).toBe(0);
    fire("loadedmetadata");
    expect(el.currentTime).toBe(1830);
  });

  it("a later load does not re-seek to the previous episode's position", () => {
    // The metadata handler must not outlive the episode that armed it, or the
    // NEXT episode lands in the middle of a story nobody started.
    const { el, fire } = fakeAudio();
    const b = new AudioBackend(el);
    b.load("https://x.test/a.mp3", 1830);
    b.load("https://x.test/b.mp3");
    fire("loadedmetadata");
    expect(el.currentTime).toBe(0);
  });

  it("volume is 0–1, clamped", () => {
    const { el } = fakeAudio();
    const b = new AudioBackend(el);
    b.setVolume(0.5);
    expect(el.volume).toBe(0.5);
    b.setVolume(2);
    expect(el.volume).toBe(1);
    b.setVolume(-1);
    expect(el.volume).toBe(0);
  });

  it("reports position and duration, and never NaN", () => {
    const { el } = fakeAudio();
    const b = new AudioBackend(el);
    (el as { currentTime: number }).currentTime = 12;
    (el as { duration: number }).duration = NaN;
    expect(b.currentTime()).toBe(12);
    expect(b.duration()).toBe(0);
  });

  it("transport reflects the element rather than a mirrored flag", () => {
    const { el } = fakeAudio();
    const b = new AudioBackend(el);
    expect(b.transport()).toBe("paused");
    (el as { paused: boolean }).paused = false;
    expect(b.transport()).toBe("playing");
  });

  it("progress comes from timeupdate, which survives a locked screen", () => {
    // Not from an interval: browsers throttle background intervals to about
    // once a minute, and the phone is locked for nearly all of a sleep timer.
    const { el, fire } = fakeAudio();
    const cb = vi.fn();
    new AudioBackend(el).onProgress(cb);
    fire("timeupdate");
    fire("timeupdate");
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("unsubscribing detaches the listener", () => {
    const { el, fire, count } = fakeAudio();
    const cb = vi.fn();
    const off = new AudioBackend(el).onProgress(cb);
    off();
    fire("timeupdate");
    expect(cb).not.toHaveBeenCalled();
    expect(count("timeupdate")).toBe(0);
  });

  it("ended and error reach their subscribers", () => {
    const { el, fire } = fakeAudio();
    const b = new AudioBackend(el);
    const ended = vi.fn();
    const errored = vi.fn();
    b.onEnded(ended);
    b.onError(errored);
    fire("ended");
    fire("error");
    expect(ended).toHaveBeenCalledTimes(1);
    expect(errored).toHaveBeenCalledTimes(1);
  });

  it("destroy detaches everything and makes later commands inert", () => {
    // The countdown and the fade can both fire after a night ends. This
    // codebase has been bitten by exactly that before — it is why tick-gate.ts
    // exists.
    const { el, fire, count } = fakeAudio();
    const b = new AudioBackend(el);
    const cb = vi.fn();
    b.onProgress(cb);
    b.destroy();
    expect(count("timeupdate")).toBe(0);
    fire("timeupdate");
    expect(cb).not.toHaveBeenCalled();
    b.play();
    expect(el.play).not.toHaveBeenCalled();
  });

  it("destroy is idempotent", () => {
    const { el } = fakeAudio();
    const b = new AudioBackend(el);
    b.destroy();
    expect(() => b.destroy()).not.toThrow();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `mise exec node@22 -- npx vitest run --environment jsdom src/lib/media/audio-backend.test.ts`
Expected: FAIL — cannot resolve `./audio-backend`.

- [ ] **Step 4: Implement `src/lib/media/audio-backend.ts`**

```ts
import type { MediaBackend, Transport } from "./backend";

/**
 * An <audio> element behind the backend interface.
 *
 * Deliberately thinner than Player.tsx's handling of the same element. No
 * crossOrigin, no CORS-bad/CORS-good feed sets, no compressor: a mixed night
 * cannot use the compressor at all (it cannot capture an iframe, and attaching
 * it is a one-way door), so the machinery that exists to serve it is not
 * carried across.
 */
export class AudioBackend implements MediaBackend {
  private dead = false;
  /** Torn down before the next load. A metadata handler that outlives its
   *  episode seeks the NEXT one to this one's position. */
  private seekCleanup: (() => void) | null = null;
  private detach: Array<() => void> = [];

  constructor(private readonly el: HTMLAudioElement) {}

  load(ref: string, startSeconds = 0): void {
    if (this.dead) return;
    this.seekCleanup?.();
    this.seekCleanup = null;

    this.el.src = ref;

    if (startSeconds > 0) {
      const onMeta = () => {
        try {
          this.el.currentTime = startSeconds;
        } catch {
          /* not seekable yet; the episode simply starts at the top */
        }
        cleanup();
      };
      const cleanup = () => {
        this.el.removeEventListener("loadedmetadata", onMeta);
        if (this.seekCleanup === cleanup) this.seekCleanup = null;
      };
      this.seekCleanup = cleanup;
      this.el.addEventListener("loadedmetadata", onMeta);
    }

    void this.el.play().catch(() => {
      /* the orchestrator's watchdog moves the night on */
    });
  }

  play(): void {
    if (this.dead) return;
    void this.el.play().catch(() => {});
  }

  pause(): void {
    if (this.dead) return;
    this.el.pause();
  }

  setVolume(level: number): void {
    if (this.dead) return;
    this.el.volume = Math.max(0, Math.min(1, level));
  }

  currentTime(): number {
    return Number.isFinite(this.el.currentTime) ? this.el.currentTime : 0;
  }

  duration(): number {
    return Number.isFinite(this.el.duration) && this.el.duration > 0 ? this.el.duration : 0;
  }

  transport(): Transport {
    if (this.dead) return "awaiting-start";
    return this.el.paused ? "paused" : "playing";
  }

  onProgress(cb: () => void): () => void {
    return this.subscribe("timeupdate", cb);
  }

  onEnded(cb: () => void): () => void {
    return this.subscribe("ended", cb);
  }

  onError(cb: (code: number | string) => void): () => void {
    return this.subscribe("error", () => cb("media-error"));
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.seekCleanup?.();
    this.seekCleanup = null;
    for (const off of this.detach.splice(0)) off();
    this.el.pause();
    this.el.removeAttribute("src");
  }

  private subscribe(type: string, cb: () => void): () => void {
    if (this.dead) return () => {};
    const handler = () => cb();
    this.el.addEventListener(type, handler);
    const off = () => this.el.removeEventListener(type, handler);
    this.detach.push(off);
    return off;
  }
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `mise exec node@22 -- npx vitest run --environment jsdom src/lib/media/audio-backend.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Run everything**

Run: `mise exec node@22 -- npm test && mise exec node@22 -- npm run typecheck`
Expected: all suites pass, 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/media
git commit -m "An audio element behind an interface a night can share"
```

---

### Task 2: YouTubeMedia conforms to the interface

`YouTubeMedia` already has the imperative half. It takes `onEnded`/`onError` as constructor handlers, which is fine for a component owning one player all night and wrong for an orchestrator that swaps backends per episode and must detach. **Additive** — the constructor handlers keep working, because `YouTubeNight.tsx` uses them and must not be touched.

**Files:**
- Modify: `src/lib/youtube-media.ts`
- Modify: `src/lib/youtube-media.test.ts`

**Interfaces:**
- Consumes: `MediaBackend`, `Transport` from `./media/backend`; `transportFor` from `./youtube-night`
- Produces: `YouTubeMedia implements MediaBackend` — adds `onProgress`, `onEnded`, `onError`, `transport()`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/youtube-media.test.ts`. Read the existing `fakePlayer()` helper at the top of that file first and reuse it — do not write a second one.

```ts
describe("conforming to the shared backend interface", () => {
  it("polls its own clock, because an iframe emits no timeupdate", () => {
    // An <audio> gets progress free from timeupdate, which survives a locked
    // screen. There is no equivalent here, so the backend owns an interval and
    // the orchestrator never learns the difference.
    vi.useFakeTimers();
    try {
      const { create, ready } = fakePlayer();
      const media = new YouTubeMedia(create);
      media.load("abc");
      ready();
      const cb = vi.fn();
      media.onProgress(cb);
      vi.advanceTimersByTime(2000);
      expect(cb.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribing stops the callbacks", () => {
    vi.useFakeTimers();
    try {
      const { create, ready } = fakePlayer();
      const media = new YouTubeMedia(create);
      media.load("abc");
      ready();
      const cb = vi.fn();
      const off = media.onProgress(cb);
      off();
      vi.advanceTimersByTime(3000);
      expect(cb).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroy stops the polling", () => {
    // An interval outliving the night is the bug tick-gate.ts exists for.
    vi.useFakeTimers();
    try {
      const { create, ready } = fakePlayer();
      const media = new YouTubeMedia(create);
      media.load("abc");
      ready();
      const cb = vi.fn();
      media.onProgress(cb);
      media.destroy();
      vi.advanceTimersByTime(5000);
      expect(cb).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("subscribed ended and error fire alongside the constructor handlers", () => {
    // YouTubeNight.tsx passes handlers to the constructor and must keep
    // working — this is additive, not a replacement.
    const ctorEnded = vi.fn();
    const { create, ready, ended, error } = fakePlayer();
    const media = new YouTubeMedia(create, { onEnded: ctorEnded });
    media.load("abc");
    ready();
    const subEnded = vi.fn();
    const subError = vi.fn();
    media.onEnded(subEnded);
    media.onError(subError);
    ended();
    error(150);
    expect(ctorEnded).toHaveBeenCalledTimes(1);
    expect(subEnded).toHaveBeenCalledTimes(1);
    expect(subError).toHaveBeenCalledWith(150);
  });

  it("transport maps YT's state codes, not a mirrored boolean", () => {
    const { create, ready, setState } = fakePlayer();
    const media = new YouTubeMedia(create);
    media.load("abc");
    ready();
    setState(1);
    expect(media.transport()).toBe("playing");
    setState(2);
    expect(media.transport()).toBe("paused");
    setState(-1);
    expect(media.transport()).toBe("awaiting-start");
    setState(3);
    expect(media.transport()).toBe("buffering");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `mise exec node@22 -- npx vitest run --environment jsdom src/lib/youtube-media.test.ts`
Expected: FAIL — `media.onProgress is not a function`.

- [ ] **Step 3: Implement**

In `src/lib/youtube-media.ts`, add the import and make the class declare conformance:

```ts
import type { MediaBackend, Transport } from "./media/backend";
import { transportFor } from "./youtube-night";

export class YouTubeMedia implements MediaBackend {
```

Add these members. `PROGRESS_MS` is 1000 to match `Player.tsx`'s own tick; the orchestrator's `shouldTick` gate dedupes anything faster.

```ts
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private progressSubs = new Set<() => void>();
  private endedSubs = new Set<() => void>();
  private errorSubs = new Set<(code: number | string) => void>();

  /** An iframe emits no timeupdate, so this is the clock. One interval however
   *  many subscribers, started on the first and stopped with the last. */
  onProgress(cb: () => void): () => void {
    if (this.dead) return () => {};
    this.progressSubs.add(cb);
    this.progressTimer ??= setInterval(() => {
      for (const s of this.progressSubs) s();
    }, 1000);
    return () => {
      this.progressSubs.delete(cb);
      if (this.progressSubs.size === 0 && this.progressTimer !== null) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
    };
  }

  onEnded(cb: () => void): () => void {
    this.endedSubs.add(cb);
    return () => void this.endedSubs.delete(cb);
  }

  onError(cb: (code: number | string) => void): () => void {
    this.errorSubs.add(cb);
    return () => void this.errorSubs.delete(cb);
  }

  /** The shared vocabulary. state() stays as YT's raw code, which
   *  YouTubeNight.tsx reads directly and must keep working. */
  transport(): Transport {
    return transportFor(this.state());
  }
```

In `load()`, the `createPlayer` call already forwards `onEnded` and `onError` to the constructor handlers. Extend both to notify subscribers too:

```ts
      onEnded: () => {
        this.handlers.onEnded?.();
        for (const s of this.endedSubs) s();
      },
      onError: (code) => {
        this.handlers.onError?.(code);
        for (const s of this.errorSubs) s(code);
      },
```

In `destroy()`, after `this.dead = true;`, stop the clock and drop the subscribers — an interval that outlives the night is exactly what `tick-gate.ts` exists to prevent:

```ts
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    this.progressSubs.clear();
    this.endedSubs.clear();
    this.errorSubs.clear();
```

- [ ] **Step 4: Run it and watch it pass**

Run: `mise exec node@22 -- npx vitest run --environment jsdom src/lib/youtube-media.test.ts`
Expected: PASS, 25 tests.

- [ ] **Step 5: Confirm the untouchable file still compiles against it**

Run: `mise exec node@22 -- npm run typecheck`
Expected: 0 errors. `YouTubeNight.tsx` must not need editing — if it does, the change was not additive and something is wrong.

- [ ] **Step 6: Run everything, then commit**

```bash
mise exec node@22 -- npm test
git add src/lib/youtube-media.ts src/lib/youtube-media.test.ts
git commit -m "Let the YouTube player be subscribed to, not only constructed with"
```

---

### Task 3: A mixed night opens on YouTube

**Files:**
- Create: `src/lib/mixed-night.ts`
- Create: `src/lib/mixed-night.test.ts`

**Interfaces:**
- Consumes: `Episode` from `./engine`; `pickNextEpisode`, `Play` from `./plays`
- Produces: `chooseLead(pool: readonly Episode[], dead: ReadonlySet<string>, plays: Play[], rand?: () => number): Episode | null`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { chooseLead } from "./mixed-night";
import type { Episode } from "./engine";

const yt = (id: string): Episode => ({
  id, title: id, url: `https://www.youtube.com/watch?v=${id}`,
  feedId: "chan", date: "", youtubeId: id,
});
const pod = (id: string): Episode => ({
  id, title: id, url: `https://x.test/${id}.mp3`, feedId: "swm", date: "",
});
const none = new Set<string>();

describe("what a mixed night opens on", () => {
  it("leads with a YouTube episode", () => {
    // The embed may refuse to autoplay. At bedtime the listener is awake and
    // taps; at 2am the same refusal stalls the night with the timer running.
    // So the expensive first video happens while someone can answer for it.
    const lead = chooseLead([pod("p1"), yt("v1"), pod("p2")], none, [], () => 0);
    expect(lead?.youtubeId).toBe("v1");
  });

  it("never leads with a podcast while any playable video remains", () => {
    for (const r of [0, 0.4, 0.99]) {
      const lead = chooseLead([pod("p1"), pod("p2"), pod("p3"), yt("v1")], none, [], () => r);
      expect(lead?.id).toBe("v1");
    }
  });

  it("falls back to a podcast when every video is dead", () => {
    // Blocked or failed videos still leave a night worth having.
    const dead = new Set(["v1", "v2"]);
    const lead = chooseLead([yt("v1"), yt("v2"), pod("p1")], dead, [], () => 0);
    expect(lead?.id).toBe("p1");
  });

  it("prefers an unheard video, the same as the ordinary shuffle", () => {
    const plays = [{ id: "v1", title: "v1", feedId: "chan", startedAt: 1, heardSec: 999 }];
    const lead = chooseLead([yt("v1"), yt("v2"), pod("p1")], none, plays, () => 0);
    expect(lead?.id).toBe("v2");
  });

  it("returns null when nothing is playable", () => {
    expect(chooseLead([yt("v1"), pod("p1")], new Set(["v1", "p1"]), [], () => 0)).toBeNull();
    expect(chooseLead([], none, [], () => 0)).toBeNull();
  });

  it("handles a pool with no videos at all", () => {
    // chooseLead is only called for mixed lineups, but a pool can lose its
    // last video to blocking between the check and the start.
    expect(chooseLead([pod("p1")], none, [], () => 0)?.id).toBe("p1");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `mise exec node@22 -- npx vitest run --environment jsdom src/lib/mixed-night.test.ts`
Expected: FAIL — cannot resolve `./mixed-night`.

- [ ] **Step 3: Implement `src/lib/mixed-night.ts`**

```ts
// Which episode a mixed night opens on.
//
// Always a video, when there is one. Browsers may refuse to autoplay an embed
// without a gesture, and they generally stop asking once a video has actually
// played in the session. At bedtime the listener is awake and can tap; the same
// refusal at 2am stalls the night with the timer still running, which is the
// worst failure this app has. So the expensive first video is spent while
// someone is there to answer for it, and every later switch is free.
//
// The constraint is only on position one. Everything after it shuffles.

import type { Episode } from "./engine";
import { pickNextEpisode, type Play } from "./plays";

export function chooseLead(
  pool: readonly Episode[],
  dead: ReadonlySet<string>,
  plays: Play[],
  rand: () => number = Math.random,
): Episode | null {
  const alive = pool.filter((e) => !dead.has(e.id));
  const videos = alive.filter((e) => !!e.youtubeId);
  // Freshness is the ordinary rule, applied to the videos alone — a lead that
  // hands back last night's video would be a worse start than a random one.
  return pickNextEpisode(videos.length ? videos : alive, plays, rand);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `mise exec node@22 -- npx vitest run --environment jsdom src/lib/mixed-night.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mixed-night.ts src/lib/mixed-night.test.ts
git commit -m "Spend the autoplay tap while the listener is awake to give it"
```

---

### Task 4: The orchestrator

The largest task, and the one with no test framework behind it. Everything decidable already lives in `src/lib` and is tested; this is the wiring.

**Files:**
- Create: `src/components/Night.tsx`

**Interfaces:**
- Consumes: `MediaBackend`, `Transport` from `../lib/media/backend`; `AudioBackend` from `../lib/media/audio-backend`; `YouTubeMedia`, `YT_EMBED_HOST` from `../lib/youtube-media`; `loadYouTubeApi` from `../lib/youtube-api`; `chooseLead` from `../lib/mixed-night`; `nextPlayable`, `decideAfterError`, `shouldGiveUp`, `YT_STATE` from `../lib/youtube-night`; `browserScreenLock` from `../lib/wake-lock`; `fadeDriverSeconds`, `effectiveVolume`, `formatTime` from `../lib/engine`; `shouldTick` from `../lib/tick-gate`; `RestSession`, `appendNight`; the `store` functions `saveLive`/`clearLive`/`saveLastNight`/`saveLastEpisode`/`recordSessionEnd`/`recordHeardPlay`/`getPlays`/`loadBlocked`/`blockEpisode`/`forgetPosition`/`rememberPosition`
- Produces: `Night` component with the same props as `YouTubeNight`

- [ ] **Step 1: Build it from `YouTubeNight.tsx`, not from scratch**

`src/components/YouTubeNight.tsx` already implements this night shape — countdown, fade, ledger, persistence, wake lock, hold-to-end, spread, the tap prompt, the ad notice. Copy it to `src/components/Night.tsx` and change what follows. Do **not** edit the original.

Same props as `YouTubeNight`: `pool`, `timerMinutes`, `mode`, `feedTrim`, `noise`, `skipIntroByFeedId`, `feedTitles`, `artworkByFeedId`, `onEnd`, `resume`, `leadEpisode`, `leadPosition`, `wasVaried`.

- [ ] **Step 2: Hold two backends, not one**

Replace the single `mediaRef` with both, plus a note of which is live:

```ts
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioBackendRef = useRef<AudioBackend | null>(null);
  const ytRef = useRef<YouTubeMedia | null>(null);
  const liveRef = useRef<MediaBackend | null>(null);
  const offRef = useRef<Array<() => void>>([]);
```

`liveRef.current` is what every existing `mediaRef.current` call becomes.

- [ ] **Step 3: Switch backends in `startEpisode`**

The one genuinely new function. Detach the old backend's subscriptions, pause it, point `liveRef` at the right one, and subscribe afresh:

```ts
  function backendFor(ep: Episode): MediaBackend | null {
    return ep.youtubeId ? ytRef.current : audioBackendRef.current;
  }

  function startEpisode(ep: Episode, seekTo = 0) {
    const next = backendFor(ep);
    if (!next) return;

    // Detach first. A handler that outlives its backend fires against a dead
    // one, and on a mixed night that means the podcast's "ended" advancing a
    // night that has already moved on to a video.
    for (const off of offRef.current.splice(0)) off();
    if (liveRef.current && liveRef.current !== next) liveRef.current.pause();
    liveRef.current = next;

    offRef.current.push(
      next.onProgress(tickGuarded),
      next.onEnded(handleEnded),
      next.onError(handleError),
    );

    setNowPlaying({ id: ep.id, title: ep.title, feedId: ep.feedId });
    setPlayedIds((prev) => new Set(prev).add(ep.id));
    currentEpRef.current = ep;
    currentFeedRef.current = ep.feedId;
    retriesRef.current = 0;
    setTransport("buffering");
    setShowStartPrompt(false);
    restRef.current?.noteEpisode(ep.feedId, ep.id);

    const skipSec = (skipIntroRef.current[ep.feedId] ?? 0) * 60;
    const start = seekTo > 0 ? seekTo : skipSec;
    next.load(ep.youtubeId ?? ep.url, start);

    watchRef.current = { id: ep.id, at: Date.now() };
    heardSecRef.current = 0;
    lastPosRef.current = start;
    heardSavedAtRef.current = -1e9;
    epStartedAtRef.current = Date.now();
    persistCounterRef.current = 10;

    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      const art = artworkRef.current[ep.feedId];
      navigator.mediaSession.metadata = new MediaMetadata({
        title: ep.title,
        artist: feedTitlesRef.current[ep.feedId] ?? "sleepcast",
        album: "sleepcast",
        ...(art ? { artwork: [{ src: art, sizes: "512x512" }] } : {}),
      });
    }
  }
```

- [ ] **Step 4: Read transport from the live backend**

`YouTubeNight` reconciles `transportFor(media.state())` inside `tick`. Here it is `liveRef.current.transport()`, which both backends implement — so the same line works whichever is playing.

The tap prompt must only ever appear for a video. Gate it:

```ts
    const isVideo = !!currentEpRef.current?.youtubeId;
    const needsTap = isVideo && t === "awaiting-start" && waitedMs > START_PROMPT_MS;
```

An audio element that is `paused` before its first `play()` resolves would otherwise render "tap to begin" over a podcast, which is nonsense.

- [ ] **Step 5: Mount both, and keep the iframe alive**

In the mount effect, create the audio backend immediately and the YouTube one once the API resolves. **Do not destroy the YouTube player between episodes** — destroying it discards the playback permission the bedtime tap bought.

```ts
    audioBackendRef.current = new AudioBackend(audioRef.current!);

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;
        ytRef.current = new YouTubeMedia((args) => buildPlayer(YT, args));
        setStatus("playing");
        beacon("youtube_night");
        const first =
          resume?.episode ?? leadEpisode ??
          chooseLead(pool, deadRef.current, getPlays());
        if (!first) { setStatus("error"); setErrorText("nothing here can be played"); return; }
        startEpisode(first, resume ? resume.position : leadEpisode ? leadPosition : 0);
        tickHandleRef.current = setInterval(tickGuarded, 1000);
        if (noise.on) { const bn = new BrownNoise(); brownRef.current = bn; void bn.start(); }
        tick();
      })
      .catch(() => {
        // No IFrame API: run podcast-only rather than losing the night. Every
        // video is unplayable, so mark them dead and let nextPlayable route
        // around them.
        if (cancelled) return;
        for (const e of pool) if (e.youtubeId) deadRef.current.add(e.id);
        setStatus("playing");
        const first = nextPlayable(pool, deadRef.current, null, getPlays());
        if (!first) { setStatus("error"); setErrorText("nothing here can be played"); return; }
        startEpisode(first);
        tickHandleRef.current = setInterval(tickGuarded, 1000);
        tick();
      });
```

- [ ] **Step 6: Render both, iframe hidden while audio plays**

```tsx
      <audio ref={audioRef} preload="none" />
      <div className="relative" style={{ display: nowPlayingIsVideo ? "block" : "none" }}>
        <div ref={hostRef} className="aspect-video w-full …" />
        {status === "playing" && showStartPrompt && ( /* the tap prompt */ )}
      </div>
```

`display: none` rather than unmounting: the player object survives, and so does the session's playback permission. Google's player is visible whenever it is playing, which is what its terms require — it is hidden only while paused behind a podcast.

- [ ] **Step 7: Clean up both on unmount and in `endSession`**

```ts
      for (const off of offRef.current.splice(0)) off();
      audioBackendRef.current?.destroy();
      ytRef.current?.destroy();
      audioBackendRef.current = null;
      ytRef.current = null;
      liveRef.current = null;
```

- [ ] **Step 8: Verify by reading, then typecheck**

Run: `mise exec node@22 -- npm test && mise exec node@22 -- npm run typecheck`
Expected: all suites pass, 0 errors. No test covers `Night.tsx` — this repo has no component-test framework, so confirm by reading:

- every `mediaRef.current` from the original became `liveRef.current`
- `startEpisode` detaches before it subscribes, on every path including resume and lead
- the tap prompt cannot render for a podcast episode
- `endSession` and the unmount cleanup both destroy both backends
- `Player.tsx` and `YouTubeNight.tsx` are unchanged: `git diff --stat` names neither

- [ ] **Step 9: Commit**

```bash
git add src/components/Night.tsx
git commit -m "A night that can change what is making the sound"
```

---

### Task 5: Route to it, and stop refusing mixed lineups

**Files:**
- Modify: `src/components/AppPlayer.tsx`
- Modify: `src/components/SleepSetup.tsx`

**Interfaces:**
- Consumes: `isYouTubeLineup`, `isMixedLineup` from `../lib/youtube-night`; `Night` from `./Night`
- Produces: nothing

- [ ] **Step 1: Route in `AppPlayer.tsx`**

Inside `if (session) {`, before the existing `isYouTubeLineup` branch:

```tsx
    // Mixed goes to the new orchestrator; the two single-kind paths keep their
    // existing components untouched. That split is the whole risk posture —
    // Player.tsx works, has no tests, and is what gets slept to.
    if (isMixedLineup(session.pool)) {
      return (
        <Night
          pool={session.pool}
          timerMinutes={session.timerMinutes}
          skipIntroByFeedId={session.skipIntroByFeedId}
          feedTitles={session.feedTitles}
          artworkByFeedId={session.artworkByFeedId}
          onEnd={handleEnd}
          resume={resume}
          leadEpisode={session.leadEpisode}
          leadPosition={session.leadPosition ?? 0}
          mode={mode}
          feedTrim={feedTrim}
          noise={noise}
          wasVaried={session.wasVaried ?? false}
        />
      );
    }
```

Add `import { Night } from "./Night";` and extend the existing `youtube-night` import to include `isMixedLineup`.

- [ ] **Step 2: Delete the refusal in `SleepSetup.tsx`**

Remove this block from `beginNight` — the reason it existed is now handled:

```ts
    if (isMixedLineup(pool)) {
      setFeedError("a YouTube night can't shuffle with podcast feeds yet — turn one kind off");
      return;
    }
```

Drop the now-unused `isMixedLineup` import from that file if nothing else uses it.

- [ ] **Step 3: Update the help text**

`SleepSetup.tsx`'s YouTube `<details>` lists "One kind per night." as a limitation. It is no longer true, and a stale limitation is worse than none. Replace that bullet with:

```tsx
                  <li>
                    <span className="text-[#b59a76]">Mixed nights start on a video.</span>{" "}
                    Your browser may want one tap before it will play one, and
                    it is better to give it while you are awake.
                  </li>
```

- [ ] **Step 4: Verify**

Run: `mise exec node@22 -- npm test && mise exec node@22 -- npm run typecheck`
Expected: all pass, 0 errors.

Then confirm by reading: `git diff --stat` for this task names only `AppPlayer.tsx` and `SleepSetup.tsx`, and the routing order is mixed → YouTube-only → podcast, so a mixed lineup can never fall through to `Player.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/components/AppPlayer.tsx src/components/SleepSetup.tsx
git commit -m "Let a night hold both kinds, and stop saying it cannot"
```

---

## Deferred, on purpose

- **Deleting `Player.tsx` and `YouTubeNight.tsx`.** The trigger is `Night.tsx` surviving real nights, which is a judgement call made with evidence rather than a date. Until then the duplication stands — that is the price of not touching what works.
- **Seeking on a mixed night.** Free on one backend, a round trip to Google's player on the other. A control that behaves differently depending on what happens to be playing is worse than no control.
- **The loudness compressor on a mixed night.** It cannot capture an iframe, and attaching it is a one-way door.

## Still open after this plan

1. **Whether the bedtime tap actually unlocks later switches.** Task 3 rests on it and it is browser behaviour no test here can verify. `youtube_tap_start` shipped 2026-08-06 and will show whether the embed ever autoplays at all.
2. **Whether a mixed night should score into "what puts you under" normally.** It does, because a YouTube feed and a podcast feed are both just feeds to the scorer. Left alone deliberately; if mixed nights are systematically better or worse it will show in the panel rather than being assumed here.
