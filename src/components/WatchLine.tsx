import { WATCH_STEPS } from "../lib/rest/watch";

/** A watch import's line, with the Shortcut's steps (when it names them) as
 *  a link rather than an address to retype. */
export function WatchLine({ text }: { text: string }) {
  const i = text.indexOf(WATCH_STEPS);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <a href="/watch" className="underline decoration-[#3a3325] underline-offset-4 hover:text-[#b59a76]">
        {WATCH_STEPS}
      </a>
      {text.slice(i + WATCH_STEPS.length)}
    </>
  );
}
