// The morning rating (lib/rest/rested.ts): the question, asked on the Rest
// tab the morning after, and what goes with the rested mornings.
import { useState } from "react";
import type { RestNight, Rested } from "../lib/rest/types";
import { inHundred } from "./Experiments";
import { MIN_RATED, RESTED_LABEL, rateNight, restedSummary, type Measure, type RestedLink } from "../lib/rest/rested";

const SCALE: Rested[] = [1, 2, 3, 4, 5];

export function RateMorning({ night, onRated }: { night: RestNight; onRated: () => void }) {
  const [rested, setRested] = useState<Rested | undefined>(night.rested);
  return (
    <section aria-labelledby="rate-title" className="space-y-2.5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
      <div>
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--ink-3)]">this morning</h2>
        <p id="rate-title" className="font-semibold text-[var(--ink)]">How rested do you feel?</p>
      </div>
      <div role="group" aria-labelledby="rate-title" className="grid grid-cols-5 gap-1.5">
        {SCALE.map((v) => (
          <button
            key={v}
            aria-pressed={rested === v}
            onClick={() => { rateNight(night.startedAt, v); setRested(v); onRated(); }}
            className={`grid min-h-14 content-center gap-0.5 rounded-lg px-1 py-2 text-center ${rested === v ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--raised)] text-[var(--ink-2)] hover:text-[var(--ink)]"}`}
          >
            <span className="text-lg font-extrabold leading-none tabular-nums">{v}</span>
            <span className="text-[10.5px] font-semibold leading-tight">{RESTED_LABEL[v]}</span>
          </button>
        ))}
      </div>
      <p role="status" className="text-xs text-[var(--ink-3)]">
        {rested ? `Noted: ${RESTED_LABEL[rested].toLowerCase()}. You can change it this morning.` : "One tap. Over time, Sleepcast shows what your rested mornings have in common."}
      </p>
    </section>
  );
}

/** How each measure reads, when more of it or less of it went with rested mornings. */
const SAYS: Record<Measure, { name: string; more: string; less: string }> = {
  asleep: { name: "Time asleep", more: "More sleep", less: "Less sleep" },
  deep: { name: "Deep sleep", more: "More Deep sleep", less: "Less Deep sleep" },
  rem: { name: "REM sleep", more: "More REM sleep", less: "Less REM sleep" },
  awake: { name: "Time awake in the night", more: "More time awake in the night", less: "Less time awake in the night" },
  wakings: { name: "Waking in the night", more: "Waking more often", less: "Waking less often" },
  toSleep: { name: "Time to fall asleep", more: "Taking longer to fall asleep", less: "Falling asleep sooner" },
  bedtime: { name: "Bedtime", more: "Later bedtimes", less: "Earlier bedtimes" },
  played: { name: "How long Sleepcast played", more: "Sleepcast playing longer", less: "Sleepcast playing for less time" },
};

const strength = (rho: number) => (Math.abs(rho) >= 0.6 ? "strongly" : Math.abs(rho) >= 0.3 ? "fairly" : "weakly");
const plural = (n: number) => (n === 1 ? "1 morning" : `${n} mornings`);

export function RestedLinks({ nights }: { nights: RestNight[] }) {
  const s = restedSummary(nights);
  if (!s) return null;
  const clear = s.links.filter((l) => l.clear);
  const unclear = s.links.filter((l) => !l.clear);
  const usual = RESTED_LABEL[Math.min(5, Math.max(1, Math.round(s.average))) as Rested];
  return (
    <section aria-labelledby="rested-title" className="space-y-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
      <div>
        <h2 id="rested-title" className="text-[11px] font-bold uppercase tracking-widest text-[var(--ink-3)]">what goes with rested mornings</h2>
        <p className="text-[13px] text-[var(--ink-2)]">
          {`${plural(s.rated)} rated, usually ${usual.toLowerCase()} (${s.average.toFixed(1)} of 5).`}
        </p>
      </div>
      {!s.links.length ? (
        <p className="text-[13px] text-[var(--ink-3)]">
          {s.rated < MIN_RATED
            ? `Rate ${plural(MIN_RATED - s.rated)} more to see what your rested ones have in common: how long you slept, Deep and REM, wakings, bedtime.`
            : "Nothing to compare yet: your ratings, or your nights, have all been the same."}
        </p>
      ) : (
        <>
          {clear.length > 0 ? (
            <ul className="space-y-2">
              {clear.map((l) => <li key={l.measure} className="text-[13px] text-[var(--ink-2)]"><Link l={l} /></li>)}
            </ul>
          ) : (
            <p className="text-[13px] text-[var(--ink-2)]">Nothing stands out from chance yet.</p>
          )}
          {unclear.length > 0 && (
            <p className="text-xs text-[var(--ink-3)]">
              {`Not clear yet: ${unclear.map((l) => SAYS[l.measure].name).join(", ")}. `}
              {`With ${plural(s.rated)}, a link has to be strong to stand out, and ${s.links.length} things are checked at once, so one would pass by luck now and then. More mornings firm it up.`}
            </p>
          )}
          <p className="text-xs text-[var(--ink-3)]">A link isn&apos;t a cause: a late night and a tired morning can both come from a busy day.</p>
        </>
      )}
    </section>
  );
}

function Link({ l }: { l: RestedLink }) {
  const says = SAYS[l.measure];
  return (
    <>
      <span className="font-semibold text-[var(--ink)]">{`${l.rho > 0 ? says.more : says.less}`}</span>
      {` ${strength(l.rho)} went with more rested mornings, over ${plural(l.n)}. A link this strong would turn up by chance ${inHundred(l.pValue)}.`}
    </>
  );
}
