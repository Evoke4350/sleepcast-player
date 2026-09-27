import { describe, expect, test, vi } from "vitest";
import { createScreenLock, type WakeLockSentinelLike } from "./wake-lock";

function sentinel() {
  const release = vi.fn(() => Promise.resolve());
  return { release };
}

function host(opts: { hidden?: boolean; fails?: boolean } = {}) {
  let hidden = opts.hidden ?? false;
  const sentinels: ReturnType<typeof sentinel>[] = [];
  const request = vi.fn(() => {
    if (opts.fails) return Promise.reject(new Error("NotAllowedError"));
    const s = sentinel();
    sentinels.push(s);
    return Promise.resolve(s);
  });
  const lock = createScreenLock(request, () => hidden);
  return { lock, request, sentinels, hide: () => (hidden = true), show: () => (hidden = false) };
}

describe("holding the screen awake", () => {
  test("acquires a lock and reports holding it", async () => {
    const { lock, request } = host();
    expect(await lock.acquire()).toBe(true);
    expect(lock.held()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("a browser that refuses is not an error the night has to handle", async () => {
    // Safari on iOS, an insecure origin, a user gesture requirement not met:
    // all reject. A YouTube night is degraded without the lock, not broken —
    // the component says so in words rather than throwing.
    const { lock } = host({ fails: true });
    expect(await lock.acquire()).toBe(false);
    expect(lock.held()).toBe(false);
  });

  test("releasing hands the sentinel back and stops holding", async () => {
    const { lock, sentinels } = host();
    await lock.acquire();
    await lock.release();
    expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    expect(lock.held()).toBe(false);
  });

  test("releasing when nothing was ever acquired is harmless", async () => {
    const { lock } = host({ fails: true });
    await lock.acquire();
    await expect(lock.release()).resolves.toBeUndefined();
  });
});

describe("the lock the browser takes back", () => {
  test("re-acquires once the tab is visible again", async () => {
    // Every browser drops a screen wake lock when the tab is hidden, and none
    // give it back. Without this the screen sleeps the first time the listener
    // switches apps, and a YouTube night — which cannot survive a locked
    // screen at all — is over without saying so.
    const { lock, request, hide, show } = host();
    await lock.acquire();
    hide();
    lock.forgetHeld(); // what the browser's own release event tells us
    await lock.reacquire();
    expect(request).toHaveBeenCalledTimes(1); // still hidden: nothing to hold

    show();
    await lock.reacquire();
    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.held()).toBe(true);
  });

  test("does not stack locks when it is already holding one", async () => {
    const { lock, request } = host();
    await lock.acquire();
    await lock.reacquire();
    await lock.reacquire();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("createScreenLock races", () => {
  function deferredRequest() {
    const pending: { resolve: () => void; sentinel: { released: boolean; release(): Promise<void> } }[] = [];
    const request = () =>
      new Promise<WakeLockSentinelLike>((resolve) => {
        const sentinel = { released: false, async release() { this.released = true; } };
        pending.push({ resolve: () => resolve(sentinel), sentinel });
      });
    return { request, pending };
  }

  // The night ended (release) while the first request was still in flight.
  // The request then resolved and stored its sentinel, so the screen was held
  // awake after the player had gone.
  test("a release during a pending acquire releases the late sentinel", async () => {
    const { request, pending } = deferredRequest();
    const lock = createScreenLock(request, () => false);
    const acquiring = lock.acquire();
    await lock.release();
    pending[0].resolve();
    expect(await acquiring).toBe(false);
    expect(lock.held()).toBe(false);
    expect(pending[0].sentinel.released).toBe(true);
  });

  // acquire() checked for a sentinel before awaiting, so two overlapping calls
  // (mount + a visibility change) each requested one and the first leaked.
  test("overlapping acquires share one request", async () => {
    const { request, pending } = deferredRequest();
    const lock = createScreenLock(request, () => false);
    const a = lock.acquire();
    const b = lock.reacquire();
    expect(pending).toHaveLength(1);
    pending[0].resolve();
    expect(await a).toBe(true);
    await b;
    expect(lock.held()).toBe(true);
    await lock.release();
    expect(pending[0].sentinel.released).toBe(true);
  });

  test("can acquire again after a release", async () => {
    const { request, pending } = deferredRequest();
    const lock = createScreenLock(request, () => false);
    const a = lock.acquire();
    pending[0].resolve();
    await a;
    await lock.release();
    const b = lock.acquire();
    pending[1].resolve();
    expect(await b).toBe(true);
    expect(lock.held()).toBe(true);
  });
});

describe("createScreenLock races found in review", () => {
  function deferredRequest() {
    const pending: { resolve: () => void; sentinel: { released: boolean; release(): Promise<void> } }[] = [];
    const request = () =>
      new Promise<WakeLockSentinelLike>((resolve) => {
        const sentinel = { released: false, async release() { this.released = true; } };
        pending.push({ resolve: () => resolve(sentinel), sentinel });
      });
    return { request, pending };
  }

  // A superseded request's cleanup cleared the newer pending slot, so a
  // visibility change started a third request and two sentinels were stored,
  // the first never released.
  test("a superseded request finishing late does not open a duplicate", async () => {
    const { request, pending } = deferredRequest();
    const lock = createScreenLock(request, () => false);
    const p1 = lock.acquire();
    await lock.release();
    const p2 = lock.acquire();
    pending[0].resolve();
    await p1;
    const p3 = lock.reacquire();
    expect(pending).toHaveLength(2); // no third request
    pending[1].resolve();
    await p2; await p3;
    await lock.release();
    expect(pending.every((p) => p.sentinel.released)).toBe(true);
  });

  // The tab hid while a request was in flight. The browser revokes on hide,
  // yet the late result was stored, so on return held() said true and
  // reacquire() did nothing.
  test("forgetHeld drops a request still in flight", async () => {
    const { request, pending } = deferredRequest();
    const lock = createScreenLock(request, () => false);
    const p1 = lock.acquire();
    lock.forgetHeld();
    pending[0].resolve();
    expect(await p1).toBe(false);
    expect(lock.held()).toBe(false);
    const p2 = lock.reacquire();
    expect(pending).toHaveLength(2);
    pending[1].resolve();
    await p2;
    expect(lock.held()).toBe(true);
  });
});

describe("createScreenLock: second review", () => {
  function deferredRequest() {
    const pending: { resolve: () => void; sentinel: { released: boolean; release(): Promise<void> } }[] = [];
    const request = () =>
      new Promise<WakeLockSentinelLike>((resolve) => {
        const sentinel = { released: false, async release() { this.released = true; } };
        pending.push({ resolve: () => resolve(sentinel), sentinel });
      });
    return { request, pending };
  }

  // Mount's request was superseded by a hide/show; the newer request won
  // first. The mount's late `false` was written into "screen held" while the
  // lock was in fact held.
  test("a superseded request reports the lock that is held now", async () => {
    const { request, pending } = deferredRequest();
    const lock = createScreenLock(request, () => false);
    const mount = lock.acquire();
    lock.forgetHeld();
    const back = lock.reacquire();
    pending[1].resolve();
    await back;
    pending[0].resolve();
    expect(await mount).toBe(true);
    expect(lock.held()).toBe(true);
    expect(pending[0].sentinel.released).toBe(true);
  });

  // A request that threw synchronously left a settled `false` cached in the
  // pending slot, so the lock was never asked for again.
  test("a synchronous throw does not wedge later acquires", async () => {
    let calls = 0;
    const lock = createScreenLock(() => {
      calls++;
      if (calls === 1) throw new Error("sync");
      return Promise.resolve({ release: async () => {} });
    }, () => false);
    expect(await lock.acquire()).toBe(false);
    expect(await lock.acquire()).toBe(true);
    expect(calls).toBe(2);
  });
});
