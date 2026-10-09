import { WATCH_STEPS } from "../lib/rest/watch";

/** A watch import's line, with the Shortcut's steps (when it names them) as
 *  a link rather than an address to retype. */
export function WatchLine({ text }: { text: string }) {
  const [before, after] = text.split(WATCH_STEPS);
  if (after === undefined) return <>{text}</>;
  return (
    <>
      {before}
      <a href="/watch" className="underline decoration-[#3a3325] underline-offset-4 hover:text-[#b59a76]">
        {WATCH_STEPS}
      </a>
      {after}
    </>
  );
}
