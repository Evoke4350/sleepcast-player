import { useRef, useState, type RefObject } from "react";

/** A value kept as state (for rendering) and as a ref (read the same tick by
 *  snapshots and long-lived handlers), with one setter that writes both, so
 *  the two can't drift: the only way it changes. */
export function useStateRef<T>(initial: T): [T, RefObject<T>, (next: T) => void] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  function set(next: T) {
    ref.current = next;
    setValue(next);
  }
  return [value, ref, set];
}
