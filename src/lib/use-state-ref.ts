import { useCallback, useRef, useState } from "react";

/** A value kept as state (for rendering) and as a ref (read the same tick by
 *  snapshots and long-lived handlers), with one setter that writes both, so
 *  the two can't drift: the only way it changes (the ref is read-only to
 *  callers). The setter is stable, like useState's. */
export function useStateRef<T>(initial: T): [T, { readonly current: T }, (next: T) => void] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(() => next); // as a value even when T is a function
  }, []);
  return [value, ref, set];
}
