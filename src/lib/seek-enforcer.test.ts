import { describe, expect, test, vi } from "vitest";
import { SeekEnforcer, type Seekable } from "./seek-enforcer";

class FakeEl implements Seekable {
  currentTime = 0;
  paused = true;
  seeking = false;
  duration = NaN;
  readyState = 0; // HAVE_NOTHING, as after a new src; "loadedmetadata" raises it
  private listeners = new Map<string, Set<(e: Event) => void>>();
  addEventListener(t: string, f: (e: Event) => void) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(f);
  }
  removeEventListener(t: string, f: (e: Event) => void) {
    this.listeners.get(t)?.delete(f);
  }
  fire(t: string) {
    if (t === "loadedmetadata") this.readyState = Math.max(this.readyState, 1);
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
    expect(done).toHaveBeenCalledWith("landed");
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
    const el = new FakeEl(); // HAVE_NOTHING, as after a new src
    new SeekEnforcer(el, 300);
    expect(el.currentTime).toBe(0); // not at creation
    el.paused = false;
    el.fire("timeupdate"); // the load's own, before metadata: no seek
    expect(el.currentTime).toBe(0);
    el.readyState = 1;
    el.fire("loadedmetadata");
    expect(el.currentTime).toBe(300);
  });

  test("its own seek answered away (clamped) is retried, not taken as someone else's", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 2400, {}, done);
    el.fire("loadedmetadata"); // seeks, paused (autoplay refused)
    el.currentTime = 60; // no byte ranges: clamped
    el.fire("seeked"); // the answer to ours
    expect(done).not.toHaveBeenCalled();
    expect(el.currentTime).toBe(2400);
  });

  test("stands down when the listener scrubs while paused", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 300, {}, done);
    el.fire("loadedmetadata"); // seeks
    el.currentTime = 300.2; // lands on a frame boundary
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
    el.currentTime = 300.2; // lands on a frame boundary
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
    el.currentTime = 120.2;
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
    el.readyState = 1;
    Object.defineProperty(el, "currentTime", { get: () => 0, set: () => {} });
    for (let i = 0; i < 20; i++) el.fire("timeupdate"); // never a "seeked"
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith("gave-up");
    enf.cancel(); // idempotent
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("an echo of its own seek on a playing element is not a landing", () => {
    const el = new FakeEl();
    el.readyState = 1;
    const done = vi.fn();
    new SeekEnforcer(el, 2700, {}, done); // seeks at once
    expect(el.currentTime).toBe(2700);
    el.paused = false;
    el.fire("playing");
    el.fire("timeupdate"); // the echo, unconfirmed
    expect(done).not.toHaveBeenCalled();
    el.currentTime = 2700.3; // playback there
    el.fire("timeupdate");
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("armed mid-playback, it lands without another \"playing\"", () => {
    const el = new FakeEl();
    el.paused = false;
    el.readyState = 4;
    el.currentTime = 2;
    const onLanded = vi.fn();
    new SeekEnforcer(el, 90, { onLanded }); // seeks at once
    el.fire("seeked");
    el.currentTime = 90.25;
    el.fire("timeupdate");
    expect(onLanded).toHaveBeenCalledTimes(1);
  });

  test("a paused reading away from a confirmed target stands it down, vouching for nothing", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 300, {}, done);
    el.fire("loadedmetadata");
    el.currentTime = 300.2;
    el.fire("seeked"); // confirmed
    el.currentTime = 0; // a failed element, paused by the app
    el.fire("timeupdate");
    expect(done).toHaveBeenCalledWith("stood-down");
  });

  test("a seeked away with none of its own outstanding stands it down", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 300, {}, done);
    el.fire("loadedmetadata");
    el.fire("seeked"); // ours, answered at the target
    el.currentTime = 60;
    el.fire("seeked"); // someone else's
    expect(done).toHaveBeenCalledWith("stood-down");
  });

  test("a late seeked from an earlier seek doesn't confirm a newer one", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 300, {}, done);
    el.fire("loadedmetadata"); // seek 1
    el.currentTime = 0; // clamped
    el.fire("timeupdate"); // retry: seek 2, reads 300
    el.fire("seeked"); // seek 1's, late
    el.currentTime = 0; // seek 2 clamped too
    el.fire("timeupdate"); // not a confirmed target: retried, not abandoned
    expect(done).not.toHaveBeenCalled();
    expect(el.currentTime).toBe(300);
  });

  test("seeks at once on an element that already knows its media", () => {
    const el = new FakeEl();
    el.readyState = 1; // paused, metadata known: no event is coming
    el.currentTime = 1200;
    new SeekEnforcer(el, 1230);
    expect(el.currentTime).toBe(1230);
  });

  test("retarget seeks at once, and a late answer to its earlier seek isn't misread", () => {
    const el = new FakeEl();
    el.readyState = 1;
    const done = vi.fn();
    const enf = new SeekEnforcer(el, 1200, {}, done); // seeks to 1200
    expect(enf.retarget(1230)).toBe(true); // the listener's +30
    expect(el.currentTime).toBe(1230);
    expect(enf.at).toBe(1230);
    el.currentTime = 1200; // the first seek's answer arrives late
    el.fire("seeked");
    expect(done).not.toHaveBeenCalled();
    expect(el.currentTime).toBe(1230); // retried, not abandoned
  });

  test("retarget to 0 is a real seek", () => {
    const el = new FakeEl();
    el.readyState = 1;
    const enf = new SeekEnforcer(el, 1200);
    enf.retarget(0);
    expect(el.currentTime).toBe(0);
  });

  test("retarget after it ended says so", () => {
    const el = new FakeEl();
    const enf = new SeekEnforcer(el, 300);
    enf.cancel();
    expect(enf.retarget(600)).toBe(false);
  });

  test("a small retarget doesn't take the earlier seek's echo for a landing", () => {
    const el = new FakeEl();
    el.readyState = 1;
    const done = vi.fn();
    const enf = new SeekEnforcer(el, 1230, {}, done); // assigns 1230, unconfirmed
    enf.retarget(1231); // within the slack, but a seek is outstanding: re-seeks
    expect(el.currentTime).toBe(1231);
    el.paused = false;
    el.readyState = 4;
    el.fire("playing");
    el.fire("timeupdate"); // the new target's echo, still unconfirmed
    expect(done).not.toHaveBeenCalled();
  });

  test("an earlier target's echo doesn't land a retarget whose seek failed", () => {
    const el = new FakeEl();
    el.readyState = 1;
    const done = vi.fn();
    const enf = new SeekEnforcer(el, 1230, {}, done); // assigns 1230
    const now = el.currentTime; // 1230, the earlier target
    Object.defineProperty(el, "currentTime", {
      get: () => now,
      set: () => { throw new Error("not seekable"); },
    });
    enf.retarget(1231); // the assignment throws; it still reads 1230
    el.paused = false;
    el.readyState = 4;
    el.fire("playing");
    el.fire("timeupdate");
    expect(done).not.toHaveBeenCalled();
  });

  test("a drag step only moves the target; the next event seeks", () => {
    const el = new FakeEl();
    el.readyState = 1;
    const enf = new SeekEnforcer(el, 600);
    enf.moveTarget(700);
    expect(el.currentTime).toBe(600);
    expect(enf.at).toBe(700);
    el.fire("timeupdate");
    expect(el.currentTime).toBe(700);
  });

  test("after a failed assignment, a reading near the target retries instead of waiting", () => {
    const el = new FakeEl();
    el.readyState = 1;
    const enf = new SeekEnforcer(el, 1230);
    let now = 1230;
    let failing = true;
    Object.defineProperty(el, "currentTime", {
      get: () => now,
      set: (v: number) => { if (failing) throw new Error("not seekable"); now = v; },
    });
    enf.retarget(1231); // throws
    failing = false;
    el.paused = false;
    el.fire("timeupdate"); // near 1231 but unassigned: retried now, not 2 s later
    expect(now).toBe(1231);
  });

  test("the target is kept short of the end once the duration is known", () => {
    const el = new FakeEl();
    const enf = new SeekEnforcer(el, 60); // before metadata: nothing known
    expect(enf.at).toBe(60);
    el.duration = 40;
    el.fire("loadedmetadata");
    expect(enf.at).toBe(39);
    expect(el.currentTime).toBe(39);
  });

  test("created lazily, it waits for an event to seek", () => {
    const el = new FakeEl();
    el.readyState = 1;
    new SeekEnforcer(el, 600, {}, () => {}, { deferSeek: true });
    expect(el.currentTime).toBe(0);
    el.fire("timeupdate");
    expect(el.currentTime).toBe(600);
  });

  test("a drag step inside the slack doesn't let the old assignment's echo land", () => {
    const el = new FakeEl();
    el.readyState = 1;
    const done = vi.fn();
    const enf = new SeekEnforcer(el, 1200, {}, done); // assigned, unconfirmed
    enf.moveTarget(1201);
    el.paused = false;
    el.readyState = 4;
    el.fire("playing"); // re-seeks to 1201 rather than trusting 1200
    expect(el.currentTime).toBe(1201);
    el.fire("timeupdate"); // the new assignment's echo
    expect(done).not.toHaveBeenCalled();
  });

  test("a duration that moves the clamp after confirmation re-seeks, not stands down", () => {
    const el = new FakeEl();
    el.duration = 5300;
    el.fire("loadedmetadata");
    const done = vi.fn();
    const enf = new SeekEnforcer(el, 5370, {}, done); // clamped: 5299
    expect(el.currentTime).toBe(5299);
    el.fire("seeked"); // confirmed at 5299
    el.duration = 5400; // the estimate settles
    el.fire("timeupdate");
    expect(done).not.toHaveBeenCalled();
    expect(enf.at).toBe(5370);
    expect(el.currentTime).toBe(5370);
  });

  test("created lazily, a stray seeked can't stand it down or confirm it", () => {
    const el = new FakeEl();
    el.readyState = 1;
    const done = vi.fn();
    new SeekEnforcer(el, 900, {}, done, { deferSeek: true });
    el.fire("seeked"); // someone's earlier seek, reading 0
    expect(done).not.toHaveBeenCalled();
    expect(el.currentTime).toBe(900); // it seeks instead
  });

  test("a drag step given its own hooks drops the old announcement", () => {
    const el = new FakeEl();
    el.readyState = 1;
    const onLanded = vi.fn();
    const enf = new SeekEnforcer(el, 120, { onLanded }); // the skip-intro
    enf.moveTarget(2400, {}); // the listener drags away
    el.paused = false;
    el.readyState = 4;
    el.fire("playing"); // seeks to 2400
    el.fire("seeked");
    el.currentTime = 2400.3;
    el.fire("timeupdate"); // lands
    expect(onLanded).not.toHaveBeenCalled();
  });

  test("a seek already in flight when it starts isn't taken for its own", () => {
    const el = new FakeEl();
    el.readyState = 1;
    el.seeking = true; // the listener's plain seek to 0, still going
    const done = vi.fn();
    new SeekEnforcer(el, 900, {}, done); // seeks to 900
    el.fire("seeked"); // the earlier seek's answer, while it reads 900
    el.currentTime = 0; // and then the element settles back
    el.fire("timeupdate");
    expect(done).not.toHaveBeenCalled(); // not confirmed, so retried
    expect(el.currentTime).toBe(900);
  });

  test("a settling duration estimate doesn't use up the attempts", () => {
    const el = new FakeEl();
    el.readyState = 1;
    el.duration = 1000;
    const done = vi.fn();
    const enf = new SeekEnforcer(el, 5000, {}, done); // clamped to 999
    for (let d = 1001; d < 1030; d++) {
      el.duration = d;
      el.fire("timeupdate");
    }
    expect(done).not.toHaveBeenCalled();
    expect(el.currentTime).toBe(enf.at);
  });

  test("the caller's duration wins over the element's", () => {
    const el = new FakeEl();
    el.readyState = 1;
    const enf = new SeekEnforcer(el, 5000, {}, () => {}, { duration: () => 600 });
    expect(enf.at).toBe(599);
    expect(el.currentTime).toBe(599);
  });

  test("assignments that keep failing still give up", () => {
    const el = new FakeEl();
    el.readyState = 1;
    const done = vi.fn();
    new SeekEnforcer(el, 50, {}, done); // placed once
    Object.defineProperty(el, "currentTime", { get: () => 0, set: () => { throw new Error("no"); } });
    for (let i = 0; i < 200; i++) el.fire("timeupdate");
    expect(done).toHaveBeenCalledWith("gave-up");
  });

  test("a target found in place still gets the settling-estimate allowance", () => {
    const el = new FakeEl();
    el.readyState = 1;
    el.duration = 5300;
    el.currentTime = 5299;
    const done = vi.fn();
    new SeekEnforcer(el, 5370, {}, done); // clamped to 5299: already there
    for (let d = 5298; d > 5270; d--) {
      el.duration = d;
      el.fire("timeupdate");
    }
    expect(done).not.toHaveBeenCalled();
  });

  test("a new duration moving the clamp is acted on at once, even paused", () => {
    const el = new FakeEl();
    el.readyState = 1;
    el.duration = 1000;
    new SeekEnforcer(el, 5000); // clamped: 999
    el.fire("seeked");
    el.duration = 900; // the estimate drops below the placed position
    el.fire("durationchange");
    expect(el.currentTime).toBe(899);
  });

  test("a seeked reading exactly the value just assigned doesn't confirm it", () => {
    const el = new FakeEl();
    el.readyState = 1;
    const done = vi.fn();
    new SeekEnforcer(el, 300, {}, done); // assigns 300
    el.fire("seeked"); // an earlier seek's, queued before this one: reads the echo
    el.currentTime = 0; // this seek is dropped
    el.fire("timeupdate"); // paused, away: not confirmed, so retried
    expect(done).not.toHaveBeenCalled();
    expect(el.currentTime).toBe(300);
  });

  test("an endlessly re-estimated duration can't lift the attempt bound", () => {
    const el = new FakeEl();
    el.readyState = 1;
    el.duration = 1000;
    const done = vi.fn();
    new SeekEnforcer(el, 5000, {}, done); // pinned to the moving end
    Object.defineProperty(el, "currentTime", { get: () => 0, set: () => {} }); // never takes it
    for (let d = 1001; d < 1300; d++) {
      el.duration = d;
      el.fire("durationchange");
    }
    expect(done).toHaveBeenCalledWith("gave-up");
  });

  test("cancel reports cancelled", () => {
    const el = new FakeEl();
    const done = vi.fn();
    new SeekEnforcer(el, 300, {}, done).cancel();
    expect(done).toHaveBeenCalledWith("cancelled");
  });

  test("cancel removes every listener", () => {
    const el = new FakeEl();
    const enf = new SeekEnforcer(el, 300);
    enf.cancel();
    expect(el.count()).toBe(0);
  });
});
