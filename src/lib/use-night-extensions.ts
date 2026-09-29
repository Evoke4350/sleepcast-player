import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { canExtend } from "./timer-feel";

/** The parts of a player's night a stretch moves. */
export interface NightClock {
  endTimeRef: RefObject<number | null>;
  pausedRemainingMsRef: RefObject<number | null>;
  totalSecondsRef: RefObject<number>;
  setTotalSeconds: Dispatch<SetStateAction<number>>;
}

/** A night's timer extensions (capped per night, reloads included): a ref to
 *  the count for snapshots written from long-lived handlers, `extend`, the
 *  one rule for a stretch, and `canExtendMore` for the button. Each stretch
 *  is snapshotted at once (`persist`), after the render that counts it:
 *  paused and backgrounded, the next periodic snapshot may never come, and a
 *  revive would lose the stretch and reset the cap. */
export function useNightExtensions(initial: number, persist: () => void, clock: NightClock) {
  const [extensions, setExtensions] = useState(initial);
  const extensionsRef = useRef(extensions);
  extensionsRef.current = extensions;
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const clockRef = useRef(clock);
  clockRef.current = clock;
  useEffect(() => {
    // A revived night's own count at mount is not a stretch (the count only
    // rises from it).
    if (extensions === initial) return;
    persistRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions]);

  /** Stretch the night by `minutes` (the time left, frozen or running, and
   *  the total), if the cap allows. What to tell the listener, or null when
   *  no stretch is left. */
  function extend(minutes: number): string | null {
    if (!canExtend(extensionsRef.current)) return null;
    const c = clockRef.current;
    const ms = minutes * 60 * 1000;
    if (c.pausedRemainingMsRef.current !== null) c.pausedRemainingMsRef.current += ms;
    else if (c.endTimeRef.current !== null) c.endTimeRef.current += ms;
    c.totalSecondsRef.current += minutes * 60;
    c.setTotalSeconds((t) => t + minutes * 60);
    const used = extensionsRef.current + 1;
    extensionsRef.current = used; // a second tap before the render counts it too
    setExtensions(used);
    return canExtend(used) ? "a little longer — sleep when you're ready" : "that's the last stretch. resting counts too.";
  }

  return { canExtendMore: canExtend(extensions), extend, extensionsRef };
}
