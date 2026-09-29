import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { canExtend } from "./timer-feel";
import { recordStretch, type LiveNight } from "./store";

/** The parts of a player's night an extension moves, and which night it is. */
export interface NightClock {
  endTimeRef: RefObject<number | null>;
  pausedRemainingMsRef: RefObject<number | null>;
  totalSecondsRef: RefObject<number>;
  setTotalSeconds: Dispatch<SetStateAction<number>>;
  /** The night's RestSession (its start), null before the night begins. */
  restRef: RefObject<{ readonly startedAt: number } | null>;
  /** When the snapshot this night was revived from was saved, if it was. */
  revivedSavedAt: number | undefined;
}

/** A night's timer extensions (capped per night, reloads included): a ref to
 *  the count for snapshots written from long-lived handlers, `extend`, the
 *  one rule for a stretch, `canExtendMore` for the button, and `liveNight`,
 *  which stored snapshot is this night's. Each stretch reaches storage at
 *  once, after the render that counts it: a full snapshot (`persist`, which
 *  says whether it wrote), else, where none can be written yet (an episode
 *  not yet played), the stretch patched into this night's stored one.
 *  Paused and backgrounded, the next periodic snapshot may never come, and a
 *  revive would lose the stretch and reset the cap. */
export function useNightExtensions(initial: number, persist: () => boolean, clock: NightClock) {
  const [extensions, setExtensions] = useState(initial);
  const extensionsRef = useRef(extensions);
  extensionsRef.current = extensions;
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const clockRef = useRef(clock);
  clockRef.current = clock;

  function liveNight(): LiveNight | null {
    const { restRef, revivedSavedAt } = clockRef.current;
    return restRef.current ? { startedAt: restRef.current.startedAt, revivedSavedAt } : null;
  }

  useEffect(() => {
    if (extensions === 0 || persistRef.current()) return;
    const c = clockRef.current;
    const night = liveNight();
    if (!night || c.endTimeRef.current === null) return;
    recordStretch(night, {
      extensions,
      totalSeconds: c.totalSecondsRef.current,
      remainingMs: c.pausedRemainingMsRef.current ?? c.endTimeRef.current - Date.now(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions]);

  /** Stretch the night by `minutes` (the time left, frozen or running, and
   *  the total), if the cap allows. What to tell the listener, or null when
   *  no stretch is left. */
  function extend(minutes: number): string | null {
    if (!canExtend(extensionsRef.current)) return null;
    const ms = minutes * 60 * 1000;
    if (clock.pausedRemainingMsRef.current !== null) clock.pausedRemainingMsRef.current += ms;
    else if (clock.endTimeRef.current !== null) clock.endTimeRef.current += ms;
    clock.totalSecondsRef.current += minutes * 60;
    clock.setTotalSeconds((t) => t + minutes * 60);
    const used = extensionsRef.current + 1;
    extensionsRef.current = used; // a second tap before the render counts it too
    setExtensions(used);
    return canExtend(used) ? "a little longer — sleep when you're ready" : "that's the last stretch. resting counts too.";
  }

  return { canExtendMore: canExtend(extensions), extend, extensionsRef, liveNight };
}
