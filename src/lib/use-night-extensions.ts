import { type RefObject } from "react";
import { useStateRef } from "./use-state-ref";
import { canExtend } from "./timer-feel";

/** The parts of a player's night a stretch moves. */
export interface NightClock {
  endTimeRef: RefObject<number | null>;
  pausedRemainingMsRef: RefObject<number | null>;
  /** The night's total (useStateRef: one setter writes state and ref). */
  totalSecondsRef: { readonly current: number };
  setTotalSeconds: (next: number) => void;
  /** The night's RestSession, which a tap is noted on as a touch. */
  restRef: { readonly current: { noteInteraction(): void } | null };
}

/** A night's timer extensions (capped per night, reloads included): a ref to
 *  the count for snapshots written from long-lived handlers, `extendTimer`
 *  for the stretch button (every tap a touch; a stretch if the cap allows,
 *  and its message said), and `canExtendMore` for the button. A stretch is
 *  snapshotted in the tap itself (`persist`, which writes once something
 *  has sounded in this page): paused and backgrounded, the next periodic
 *  snapshot may never come, and a revive would lose the stretch and reset
 *  the cap. */
export function useNightExtensions(
  initial: number,
  /** Whether it wrote (nothing before a sound in this page, or storage
   *  full): a stretch's snapshot can be skipped, carried by the next one. */
  persist: () => boolean,
  clock: NightClock,
  /** Shows what a stretch says. */
  say: (message: string) => void,
) {
  const [extensions, extensionsRef, setExtensions] = useStateRef(initial);

  /** The stretch button's tap: a touch, stretch left or not; then, if the
   *  cap allows, the night stretched by `minutes` (the time left, frozen
   *  or running, and the total), snapshotted, and said. */
  function extendTimer(minutes: number) {
    clock.restRef.current?.noteInteraction();
    if (!canExtend(extensionsRef.current)) return;
    const ms = minutes * 60 * 1000;
    if (clock.pausedRemainingMsRef.current !== null) clock.pausedRemainingMsRef.current += ms;
    else if (clock.endTimeRef.current !== null) clock.endTimeRef.current += ms;
    clock.setTotalSeconds(clock.totalSecondsRef.current + minutes * 60);
    const used = extensionsRef.current + 1;
    setExtensions(used); // the ref at once: a second tap before the render counts it too
    // Snapshotted at once: every ref the snapshot reads is already moved.
    persist();
    say(canExtend(used) ? "a little longer — sleep when you're ready" : "that's the last stretch. resting counts too.");
  }

  return { canExtendMore: canExtend(extensions), extendTimer, extensionsRef };
}
