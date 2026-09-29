import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { canExtend } from "./timer-feel";
import { stretchLive, type LiveNight } from "./store";

/** The parts of a player's night clock an extension moves. */
export interface NightClock {
  endTimeRef: RefObject<number | null>;
  pausedRemainingMsRef: RefObject<number | null>;
  totalSecondsRef: RefObject<number>;
  setTotalSeconds: Dispatch<SetStateAction<number>>;
  /** Which night's stored snapshot a stretch is patched into; null before
   *  the night has begun. */
  night: () => LiveNight | null;
}

/** A night's timer extensions (capped per night, reloads included): the
 *  count, seeded from a revived night's snapshot, a ref to it for snapshots
 *  written from long-lived handlers, `extend`, the one rule for a stretch,
 *  and `canExtendMore` for the button. Each stretch reaches storage at
 *  once: patched into the stored snapshot, then a full snapshot after the
 *  render that counts it where one can be written. Paused and backgrounded,
 *  the next periodic snapshot may never come, and a revive would lose the
 *  stretch and reset the cap. */
export function useNightExtensions(initial: number, persist: () => void, clock: NightClock) {
  const [extensions, setExtensions] = useState(initial);
  const extensionsRef = useRef(extensions);
  extensionsRef.current = extensions;
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    if (extensions > 0) persistRef.current();
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
    const night = clock.night();
    if (night) stretchLive(night, minutes, used);
    return canExtend(used) ? "a little longer — sleep when you're ready" : "that's the last stretch. resting counts too.";
  }

  return { extensions, canExtendMore: canExtend(extensions), extend, extensionsRef };
}
