import { describe, expect, test, vi } from "vitest";
import { SeekEnforcer, type Seekable } from "./seek-enforcer";

class FakeEl implements Seekable {
  currentTime = 0;
  paused = true;
  readyState = 1; // HAVE_METADATA: most tests start there
  private listeners = new Map<string, Set<(e: Event) => void>>();
  addEventListener(t: string, f: (e: Event) => void) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(f);
  }
  removeEventListener(t: string, f: (e: Event) => void) {
    this.listeners.get(t)?.delete(f);
  }
  fire(t: string) {
    for (const f of [...(this.listeners.get(t) ?? [])]) f(new Event(t));
  }
  count() {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

describe("SeekEnforcer", () => {
  test("lands only once playback is rolling at the confirmed target", () => {
    const el = new FakeEl();
    const onLanded = vi.fn();
    const done = vi.fn();
    new SeekEnforcer(el, 300, { onLanded }, done);
    el.paused = false; // play() called, still loading
    el.fire("loadedmetadata");
    expect(el.currentTime).toBe(300);
    el.fire("timeupdate"); // reads the target at once: proves nothing yet
    expect(done).not.toHaveBeenCalled();
    el.fire("seeked");
    el.fire("canplay"); // at the target, not playing yet: not landed
    expect(done).not.toHaveBeenCalled();
    el.currentTime = 0; // Safari resets as playback starts
    el.fire("playing");
    expect(el.currentTime).toBe(300); // re-seeked
    el.fire("seeked");
    el.currentTime = 301;
    el.fire("timeupdate");
    expect(onLanded).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(el.count()).toBe(0);
  });

  test("a dropped seek is retried, not mistaken for a listener's scrub", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 2700, {}, done);
    el.paused = false;
    el.fire("loadedmetadata"); // seeks; reads 2700 at once
    el.fire("canplay"); // still in flight
    el.paused = true; // autoplay refused
    el.currentTime = 0; // and the seek is dropped (no "seeked")
    el.fire("timeupdate");
    expect(done).not.toHaveBeenCalled();
    expect(el.currentTime).toBe(2700); // retried
  });

  test("waits for metadata before seeking", () => {
    const el = new FakeEl();
    new SeekEnforcer(el, 300);
    el.paused = false;
    el.readyState = 0;
    el.fire("timeupdate"); // the load's own, before metadata: no seek
    expect(el.currentTime).toBe(0);
    el.readyState = 1;
    el.fire("loadedmetadata");
    expect(el.currentTime).toBe(300);
  });

  test("stands down when the listener scrubs while its own seek is still going", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 300, {}, done);
    el.fire("loadedmetadata"); // seeks, paused (autoplay refused)
    el.currentTime = 60; // the listener's seek replaces it
    el.fire("seeked");
    expect(el.currentTime).toBe(60);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("stands down when the listener scrubs while paused", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 300, {}, done);
    el.fire("loadedmetadata"); // seeks
    el.fire("seeked"); // confirmed, paused (autoplay refused)
    el.currentTime = 60; // the listener rewinds
    el.fire("timeupdate");
    expect(el.currentTime).toBe(60);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("stands down for a paused scrub when the target was confirmed while loading", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 300, {}, done);
    el.paused = false; // play() pending
    el.fire("loadedmetadata"); // seeks
    el.fire("seeked"); // confirmed, still loading
    el.paused = true; // then autoplay is refused
    el.currentTime = 60; // and the listener rewinds
    el.fire("timeupdate");
    expect(el.currentTime).toBe(60);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("a listener's skip ahead is not claimed as the landing", () => {
    const el = new FakeEl();
    const onLanded = vi.fn();
    const done = vi.fn();
    new SeekEnforcer(el, 120, { onLanded }, done);
    el.paused = false;
    el.fire("loadedmetadata");
    el.fire("seeked");
    el.fire("playing"); // at 120
    el.currentTime = 150; // skipped +30 before the landing timeupdate
    el.fire("timeupdate");
    expect(el.currentTime).toBe(150);
    expect(onLanded).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("gives up on a stream that never takes the seek", () => {
    const el = new FakeEl();
    const done = vi.fn();
    const enf = new SeekEnforcer(el, 300, {}, done);
    el.paused = false;
    Object.defineProperty(el, "currentTime", { get: () => 0, set: () => {} });
    for (let i = 0; i < 20; i++) el.fire("timeupdate"); // never a "seeked"
    expect(done).toHaveBeenCalledTimes(1);
    enf.cancel(); // idempotent
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("an echo of its own seek on a playing element is not a landing", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 2700, {}, done);
    el.paused = false;
    el.fire("playing");
    el.fire("timeupdate"); // reads 0: seeks, and now reads exactly 2700
    el.fire("timeupdate"); // the echo, unconfirmed
    expect(done).not.toHaveBeenCalled();
    el.currentTime = 2700.3; // playback there
    el.fire("timeupdate");
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("cancel removes every listener", () => {
    const el = new FakeEl();
    const enf = new SeekEnforcer(el, 300);
    enf.cancel();
    expect(el.count()).toBe(0);
  });
});
