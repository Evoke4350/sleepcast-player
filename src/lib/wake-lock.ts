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

  async function acquire(): Promise<boolean> {
    if (sentinel) return true;
    try {
      sentinel = await request();
      return true;
    } catch {
      // Unsupported, insecure origin, or refused. Degraded, not broken — the
      // component tells the listener to keep the screen on themselves.
      sentinel = null;
      return false;
    }
  }

  return {
    acquire,
    held: () => sentinel !== null,
    forgetHeld: () => { sentinel = null; },
    async reacquire() {
      // A hidden tab cannot hold one, and asking throws. Wait for the return.
      if (sentinel || isHidden()) return;
      await acquire();
    },
    async release() {
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
