// Keeping the screen on.
//
// A YouTube night needs this in a way a podcast night does not. Audio keeps
// playing through a locked screen; an embedded video does not — mobile
// browsers suspend it, and there is no API that changes that. So for the
// YouTube path the screen staying on is not a comfort, it is the requirement.
//
// The Screen Wake Lock API has one behaviour that turns a working feature into
// a silently broken one: the browser revokes the lock whenever the tab becomes
// hidden, and never returns it. Ask once at the start of the night and the
// screen sleeps the first time the listener checks a message. So the lock is
// re-acquired on the way back, which is the whole reason this is a module
// rather than a single call.

export interface WakeLockSentinelLike {
  release(): Promise<void>;
}

export interface ScreenLock {
  acquire(): Promise<boolean>;
  /** Take it back if it was lost and the tab can hold one again. */
  reacquire(): Promise<void>;
  release(): Promise<void>;
  held(): boolean;
  /** Record that the browser revoked the lock underneath us. */
  forgetHeld(): void;
}

export function createScreenLock(
  request: () => Promise<WakeLockSentinelLike>,
  isHidden: () => boolean,
): ScreenLock {
  let sentinel: WakeLockSentinelLike | null = null;
  // The request in flight, shared by overlapping acquire() calls. Checking
  // `sentinel` alone let two calls (mount and a visibility change) each
  // request a lock, and the first was never released.
  let pending: Promise<boolean> | null = null;
  // Bumped by release() and forgetHeld(). A request that resolves after either
  // belongs to a lock that should no longer be held: a night that has ended,
  // or a tab the browser already revoked on hiding. Storing it held the screen
  // awake after the player had gone (or reported a revoked lock as held), so
  // it is released on arrival instead.
  let generation = 0;

  function invalidate(): void {
    generation++;
    pending = null;
  }

  function acquire(): Promise<boolean> {
    if (sentinel) return Promise.resolve(true);
    if (pending) return pending;
    // Each request owns a generation; release() and forgetHeld() bump it too.
    // Only one request runs per generation (`pending` dedupes), so a request
    // is current exactly when the generation is still its own.
    const gen = ++generation;
    // A request() that throws synchronously is a refusal like any other. It
    // is caught here, before `pending` exists, because the async body's
    // finally would otherwise run before `pending` was assigned and leave a
    // settled `false` cached there for good. Past this point the body always
    // awaits a promise first, so its finally runs after the assignment.
    let requested: Promise<WakeLockSentinelLike>;
    try {
      requested = request();
    } catch {
      return Promise.resolve(sentinel !== null);
    }
    pending = (async () => {
      try {
        const s = await requested;
        if (gen !== generation) {
          // Superseded. Never keep it: storing it held the screen awake after
          // a night ended, or kept a lock the browser revoked on hiding. Report
          // whether a lock is held now, not this request's stale outcome, since
          // callers write the result straight into their "screen held" state.
          await s.release().catch(() => {});
          return sentinel !== null;
        }
        sentinel = s;
        return true;
      } catch {
        // Unsupported, insecure origin, or refused. Degraded, not broken — the
        // component tells the listener to keep the screen on themselves.
        return sentinel !== null;
      } finally {
        // Only the current request clears the slot; a superseded one finishing
        // late must not clear a newer one, or a duplicate could start.
        if (gen === generation) pending = null;
      }
    })();
    return pending;
  }

  return {
    acquire,
    held: () => sentinel !== null,
    forgetHeld: () => {
      sentinel = null;
      invalidate();
    },
    async reacquire() {
      // A hidden tab cannot hold one, and asking throws. Wait for the return.
      if (sentinel || isHidden()) return;
      await acquire();
    },
    async release() {
      invalidate();
      const s = sentinel;
      sentinel = null;
      try {
        await s?.release();
      } catch {
        // Already revoked by the browser. Nothing to undo.
      }
    },
  };
}

/** The browser's own wake lock, or null where there isn't one. */
export function browserScreenLock(): ScreenLock | null {
  const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & {
    wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
  });
  if (!nav?.wakeLock) return null;
  return createScreenLock(
    () => nav.wakeLock!.request("screen"),
    () => typeof document !== "undefined" && document.hidden,
  );
}
