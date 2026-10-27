// "What wakes you" (lib/rest/wakes.ts): whether waking follows a new
// episode or the sound stopping more than chance, with what to try.
import type { RestNight } from "../lib/rest/types";
import { MIN_EVENTS, wakeAudit, type WakeAudit as Audit } from "../lib/rest/wakes";

const WHAT: Record<Audit["cause"], { name: string; fix: string }> = {
  episode: {
    name: "A new episode starting",
    fix: "Try the One episode timer, or shows with longer episodes, so fewer start while you sleep.",
  },
  stop: {
    name: "The sound stopping",
    fix: "Try a longer timer, or All night, so the sound doesn't stop while you're asleep.",
  },
};

const VERDICT: Record<Audit["verdict"], string> = {
  wakes: "Seems to wake you",
  doesnt: "Doesn't seem to wake you",
  unclear: "Too early to tell",
};

const about = (x: number) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));

export function WakeAudit({ nights }: { nights: RestNight[] }) {
  const audit = wakeAudit(nights);
  if (!audit.length) return null;
  return (
    <section aria-labelledby="wakes-title" className="space-y-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
      <div>
        <h2 id="wakes-title" className="text-[11px] font-bold uppercase tracking-widest text-[var(--ink-3)]">what wakes you</h2>
        <p className="text-[13px] text-[var(--ink-3)]">
          Wakings your watch saw within 3 minutes of something Sleepcast did while you slept, against how often you&apos;d wake that soon anyway.
        </p>
      </div>
      <ul className="space-y-3">
        {audit.map((a) => (
          <li key={a.cause} className="space-y-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="font-semibold text-[var(--ink)]">{WHAT[a.cause].name}</span>
              <span className={`text-xs font-semibold ${a.verdict === "wakes" ? "text-[var(--danger)]" : "text-[var(--ink-3)]"}`}>{VERDICT[a.verdict]}</span>
            </div>
            <p className="text-[13px] text-[var(--ink-2)]">
              {`${a.events === 1 ? "Once" : `${a.events} times`} while you slept, and ${a.woke === 0 ? "you never woke within 3 minutes" : `you woke within 3 minutes ${a.woke === 1 ? "once" : `${a.woke} times`}`}. Chance alone: about ${about(a.expected)}.`}
              {a.events < MIN_EVENTS ? ` ${MIN_EVENTS - a.events} more to say either way.` : ""}
            </p>
            {a.verdict === "wakes" && <p className="text-[13px] text-[var(--ink-2)]">{WHAT[a.cause].fix}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
