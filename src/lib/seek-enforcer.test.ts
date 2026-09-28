import { describe, expect, test, vi } from "vitest";
import { SeekEnforcer, type Seekable } from "./seek-enforcer";

class FakeEl implements Seekable {
  currentTime = 0;
  duration = NaN;
  paused = true;
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
  test("lands only once playback is rolling at the target", () => {
    const el = new FakeEl();
    const onLanded = vi.fn();
    const done = vi.fn();
    new SeekEnforcer(el, 300, { onLanded }, done);
    el.paused = false; // play() called, still loading
    el.fire("loadedmetadata");
    expect(el.currentTime).toBe(300);
    el.fire("canplay"); // at the target, not playing yet: not landed
    expect(done).not.toHaveBeenCalled();
    el.currentTime = 0; // Safari resets as playback starts
    el.fire("playing");
    expect(el.currentTime).toBe(300); // re-seeked
    el.currentTime = 301;
    el.fire("timeupdate");
    expect(onLanded).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(el.count()).toBe(0);
  });

  test("stands down when the listener scrubs while paused", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 300, {}, done);
    el.fire("loadedmetadata"); // seeks
    el.fire("canplay"); // reached, paused (autoplay refused)
    el.currentTime = 60; // the listener rewinds
    el.fire("timeupdate");
    expect(el.currentTime).toBe(60);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("stands down for a paused scrub when the target was reached while loading", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 300, {}, done);
    el.paused = false; // play() pending
    el.fire("loadedmetadata"); // seeks
    el.fire("canplay"); // reached, still loading
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
    el.fire("playing"); // at 120
    el.currentTime = 150; // skipped +30 before the landing timeupdate
    el.fire("timeupdate");
    expect(el.currentTime).toBe(150);
    expect(onLanded).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("plays a short episode whole", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 300, { playWholeIf: (d) => 300 >= d - 30 }, done);
    el.duration = 320;
    el.fire("loadedmetadata");
    expect(el.currentTime).toBe(0);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("plays a short episode whole even after seeking before the duration was known", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 300, { playWholeIf: (d) => 300 >= d - 30 }, done);
    el.fire("timeupdate"); // the load's own, before metadata: seeks to 300
    expect(el.currentTime).toBe(300);
    el.duration = 320;
    el.fire("loadedmetadata");
    expect(el.currentTime).toBe(0);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("gives up on a stream that never takes the seek", () => {
    const el = new FakeEl();
    const done = vi.fn();
    const enf = new SeekEnforcer(el, 300, {}, done);
    Object.defineProperty(el, "currentTime", { get: () => 0, set: () => {} });
    for (let i = 0; i < 20; i++) el.fire("timeupdate");
    expect(done).toHaveBeenCalledTimes(1);
    enf.cancel(); // idempotent
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("cancel removes every listener", () => {
    const el = new FakeEl();
    const enf = new SeekEnforcer(el, 300, {}, () => {});
    enf.cancel();
    expect(el.count()).toBe(0);
  });
});
