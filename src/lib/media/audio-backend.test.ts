import { describe, it, expect, vi } from "vitest";
import { AudioBackend } from "./audio-backend";

/** A stand-in for HTMLAudioElement: real listener bookkeeping, settable
 *  readonly-in-the-DOM properties, and a way to fire events by hand. */
function fakeAudio() {
  const listeners = new Map<string, Set<EventListener>>();
  let nextPlayResult: (() => Promise<void>) | null = null;
  const el = {
    src: "",
    currentTime: 0,
    duration: 0,
    volume: 1,
    paused: true,
    play: vi.fn(() => {
      const result = nextPlayResult;
      nextPlayResult = null;
      return result ? result() : Promise.resolve();
    }),
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
    /** The next (and only the next) call to play() rejects with this error
     *  instead of resolving. */
    rejectNextPlay: (err: unknown) => {
      nextPlayResult = () => Promise.reject(err);
    },
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

  it("a seek armed before destroy does not land on metadata that arrives after", () => {
    // destroy() tears down the seek handler, but if it didn't, a metadata
    // event firing on a dead element would seek an <audio> nobody is
    // listening to anymore — harmless today, but only because destroy is
    // careful, not because nothing is armed.
    const { el, fire } = fakeAudio();
    const b = new AudioBackend(el);
    b.load("https://x.test/a.mp3", 1830);
    b.destroy();
    expect(() => fire("loadedmetadata")).not.toThrow();
    expect(el.currentTime).toBe(0);
  });

  it("transport reports dead, not awaiting-start, once destroyed", () => {
    // A caller renders a tap-to-begin prompt for "awaiting-start" — but a
    // destroyed backend's play() is a permanent no-op, so that prompt would
    // do nothing when tapped.
    const { el } = fakeAudio();
    const b = new AudioBackend(el);
    b.destroy();
    expect(b.transport()).toBe("dead");
  });

  it("a blocked autoplay is reported, not swallowed", async () => {
    // NotAllowedError is a rejected promise, not an "error" event, and the
    // spec reverts `paused` to true when it happens — indistinguishable from
    // a deliberate pause unless something reports it.
    const { el, rejectNextPlay } = fakeAudio();
    const b = new AudioBackend(el);
    const errored = vi.fn();
    b.onError(errored);
    rejectNextPlay(new DOMException("blocked", "NotAllowedError"));
    b.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(errored).toHaveBeenCalledWith("autoplay-blocked");
  });

  it("a play() rejection that isn't autoplay is reported as play-failed", async () => {
    const { el, rejectNextPlay } = fakeAudio();
    const b = new AudioBackend(el);
    const errored = vi.fn();
    b.onError(errored);
    rejectNextPlay(new Error("network blew up"));
    b.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(errored).toHaveBeenCalledWith("play-failed");
  });

  it("an interrupted play() is not reported at all", async () => {
    // AbortError means the caller replaced the source or stopped it — a new
    // load, or a pause on something still buffering. It says nothing about the
    // episode, and it arrives a microtask late, by which time the subscriber is
    // whoever is live NOW. Reported as a failure it condemns the wrong episode,
    // whose own load then aborts the next one's play, until the night is over.
    const { el, rejectNextPlay } = fakeAudio();
    const b = new AudioBackend(el);
    const errored = vi.fn();
    b.onError(errored);
    rejectNextPlay(new DOMException("interrupted by a new load request", "AbortError"));
    b.load("https://x.test/a.mp3");
    await Promise.resolve();
    await Promise.resolve();
    expect(errored).not.toHaveBeenCalled();
  });
});
