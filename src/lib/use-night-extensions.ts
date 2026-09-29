import { useEffect, useRef, useState } from "react";

/** A night's timer extensions (capped per night, reloads included): the
 *  count, seeded from a revived night's snapshot, a ref to it for snapshots
 *  written from long-lived handlers, and a snapshot at once after the render
 *  that counts one. Paused and backgrounded, the next periodic snapshot may
 *  never come, and a revive would lose the stretch and reset the cap. */
export function useNightExtensions(initial: number, persist: () => void) {
  const [extensions, setExtensions] = useState(initial);
  const extensionsRef = useRef(extensions);
  extensionsRef.current = extensions;
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    if (extensions > 0) persistRef.current();
  }, [extensions]);
  return [extensions, setExtensions, extensionsRef] as const;
}
