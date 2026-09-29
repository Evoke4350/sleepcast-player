import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { canExtend } from "./timer-feel";
import { stretchLive, type LiveNight } from "./store";

/** The parts of a player's night a stretch moves, and which night it is. */
export interface NightClock {
  endTimeRef: RefObject<number | null>;
  pausedRemainingMsRef: RefObject<number | null>;
  totalSecondsRef: RefObject<number>;
  setTotalSeconds: Dispatch<SetStateAction<number>>;
  /** This night's stored-snapshot identity (liveNightOf); null before it begins. */
  night: () => LiveNight | null;
}

/** A night's timer extensions (capped per night, reloads included): a ref to
 *  the count for snapshots written from long-lived handlers, `extend`, the
 *  one rule for a stretch, and `canExtendMore` for the button. Each stretch
 *  reaches storage at once, after the render that counts it: a full
 *  snapshot (`persist`, which says whether it wrote), else, where none can
 *  be written yet (an episode not yet played), the minutes stretched since
 *  added to this night's stored one. Paused and backgrounded, the next
 *  periodic snapshot may never come, and a revive would lose the stretch
 *  and reset the cap. */
export function useNightExtensions(initial: number, persist: () => boolean, clock: NightClock) {
  const [extensions, setExtensions] = useState(initial);
  const extensionsRef = useRef(extensions);
  extensionsRef.current = extensions;
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const clockRef = useRef(clock);
  clockRef.current = clock;
  // Minutes stretched and not yet stored, and the count last stored (a
  // revived night's own count at mount is not a stretch).
  const unstoredMinutesRef = useRef(0);
  const storedCountRef = useRef(initial);

  useEffect(() => {
    if (extensions === storedCountRef.current) return;
    if (!persistRef.current()) {
      const night = clockRef.current.night();
      if (!night) return; // kept unstored: the next write carries it
      stretchLive(night, unstoredMinutesRef.current, extensions);
    }
    unstoredMinutesRef.current = 0;
    storedCountRef.current = extensions;
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
    unstoredMinutesRef.current += minutes;
    const used = extensionsRef.current + 1;
    extensionsRef.current = used; // a second tap before the render counts it too
    setExtensions(used);
    return canExtend(used) ? "a little longer — sleep when you're ready" : "that's the last stretch. resting counts too.";
  }

  return { canExtendMore: canExtend(extensions), extend, extensionsRef };
}
