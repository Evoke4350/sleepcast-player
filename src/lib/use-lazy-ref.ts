import { useRef } from "react";

/** A ref holding an object built once per mount: useRef(new X()) would build
 *  (and throw away) a new X on every render. Read-only to callers: the one
 *  object is the point. */
export function useLazyRef<T>(make: () => T): { readonly current: T } {
  const ref = useRef<T | null>(null);
  if (ref.current === null) ref.current = make();
  return ref as { readonly current: T };
}
