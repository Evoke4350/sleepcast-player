import { QUIET_LINK } from "./quiet-link";
import { WATCH_STEPS } from "../lib/rest/watch";

/** A watch import's line, with the Shortcut's steps (when it names them) as
 *  a link rather than an address to retype. */
export function WatchLine({ text }: { text: string }) {
  const i = text.indexOf(WATCH_STEPS);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <a href="/watch" className={QUIET_LINK}>
        {WATCH_STEPS}
      </a>
      {text.slice(i + WATCH_STEPS.length)}
    </>
  );
}
