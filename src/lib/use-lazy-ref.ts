import { useRef, type RefObject } from "react";

/** A ref holding an object built once per mount: useRef(new X()) would build
 *  (and throw away) a new X on every render. */
export function useLazyRef<T>(make: () => T): RefObject<T> {
  const ref = useRef<T | null>(null);
  if (ref.current === null) ref.current = make();
  return ref as RefObject<T>;
}
