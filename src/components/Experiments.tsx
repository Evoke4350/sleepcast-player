// Experiments on the Rest tab (lib/rest/experiment.ts): start one, follow
// it, and read its result. While one runs, its counts are shown but not its
// times: a result read early is the one most likely to be chance.
import { useReducer, useState } from "react";
import type { RestNight } from "../lib/rest/types";
import {
  currentExperiment, endExperiment, experimentResult, extendExperiment, pastExperiments, startExperiment,
  type Arm, type Experiment,
} from "../lib/rest/experiment";
import { TIMER_PRESETS } from "../lib/timer-presets";
import { fmtLong } from "./NightChart";

const NIGHTS_EACH = [5, 7, 10];

export function armName(arm: Arm, titles: Record<string, string>): string {
  return arm.kind === "show" ? (titles[arm.feedId] ?? "a show you removed") : `${arm.minutes}-minute timer`;
}

/** "less than 1 time in 100", "4 times in 100". */
export function inHundred(p: number): string {
  const n = Math.round(p * 100);
  return n < 1 ? "less than 1 time in 100" : n === 1 ? "about 1 time in 100" : `about ${n} times in 100`;
}

const fmtTime = (ms: number | null) => (ms === null ? "—" : ms === Infinity ? "no sleep" : fmtLong(ms));

export function Experiments({ nights, feeds, favoring = false, learning = true }: { nights: RestNight[]; feeds: { id: string; title: string; enabled: boolean }[]; favoring?: boolean; learning?: boolean }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const titles = Object.fromEntries(feeds.map((f) => [f.id, f.title]));
  const e = currentExperiment();
  const past = pastExperiments();

  return (
    <section aria-labelledby="experiment-title" className="space-y-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
      <h2 id="experiment-title" className="text-[11px] font-bold uppercase tracking-widest text-[var(--ink-3)]">experiment</h2>
      {e ? <Running e={e} nights={nights} titles={titles} favoring={favoring} learning={learning} onChange={redraw} /> : <Start feeds={feeds} onStart={redraw} />}
      {past.length > 0 && (
        <details className="text-xs text-[var(--ink-3)]">
          <summary className="cursor-pointer rounded font-semibold text-[var(--ink-2)]">Past experiments</summary>
          <ul className="mt-2 space-y-1.5">
            {[...past].reverse().map((p) => (
              <li key={p.id}>{pastLine(p, nights, titles)}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function pastLine(p: Experiment, nights: RestNight[], titles: Record<string, string>): string {
  const r = experimentResult(p, nights);
  const names = `${armName(p.arms[0], titles)} vs ${armName(p.arms[1], titles)}`;
  // Its nights have left the ledger (it keeps 90), but its result was kept.
  if (!r.done && p.winner !== undefined) {
    return p.winner === null ? `${names}: no clear difference.` : `${names}: ${armName(p.arms[p.winner], titles)} was faster.`;
  }
  if (!r.done) return `${names}: ended after ${r.sides[0].nights + r.sides[1].nights} nights, before a result.`;
  return r.winner === null
    ? `${names}: no clear difference (${fmtTime(r.sides[0].medianMs)} vs ${fmtTime(r.sides[1].medianMs)}).`
    : `${names}: ${armName(p.arms[r.winner], titles)} was faster (${fmtTime(r.sides[0].medianMs)} vs ${fmtTime(r.sides[1].medianMs)}).`;
}

function Running({ e, nights, titles, favoring, learning, onChange }: { e: Experiment; nights: RestNight[]; titles: Record<string, string>; favoring: boolean; learning: boolean; onChange: () => void }) {
  const r = experimentResult(e, nights);
  const [a, b] = e.arms.map((arm) => armName(arm, titles));
  const [confirmEnd, setConfirmEnd] = useState(false);
  return (
    <div className="space-y-2.5">
      <p className="font-semibold text-[var(--ink)]">{`${a} vs ${b}`}</p>
      {!r.done ? (
        <>
          <ul className="space-y-1 text-[13px] text-[var(--ink-2)]">
            {r.sides.map((s, k) => (
              <li key={k} className="flex justify-between gap-2">
                <span>{k === 0 ? a : b}</span>
                <span className="tabular-nums text-[var(--ink-3)]">{`${Math.min(s.times.length, e.perArm)} of ${e.perArm} nights`}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--ink-3)]">
            {`Next: ${e.next === 0 ? a : b}, from the moon. Times stay hidden until both have ${e.perArm} nights, so an early lucky streak can't decide it. Nights started any other way don't count.`}
          </p>
        </>
      ) : (
        <>
          <ul className="space-y-1 text-[13px] text-[var(--ink-2)]">
            {r.sides.map((s, k) => (
              <li key={k} className="flex items-baseline justify-between gap-3">
                <span className={`min-w-0 flex-1 ${r.winner === k ? "font-semibold text-[var(--ink)]" : ""}`}>
                  {k === 0 ? a : b}
                  <span className="block text-[11px] font-normal text-[var(--ink-3)]">{`${s.times.length} nights`}</span>
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  {fmtTime(s.medianMs)}
                  <span className="block text-[11px] text-[var(--ink-3)]">to fall asleep</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-[var(--ink-2)]">
            {r.winner !== null
              ? `${r.winner === 0 ? a : b} put you to sleep faster. A difference this clear would come up by chance ${inHundred(r.pValue!)}.`
              : `No clear difference: one this size comes up by chance ${inHundred(r.pValue!)}. More nights could tell them apart, or they may just be as good as each other.`}
          </p>
          {r.winner !== null && e.arms[0].kind === "show" && (
            <p className="text-xs text-[var(--ink-3)]">
              {favoring
                ? `"Favour what puts me under" now leans your shuffle toward ${r.winner === 0 ? a : b} as strongly as it leans toward any show, and not toward ${r.winner === 0 ? b : a}.`
                : `Turn on "Favour what puts me under" in Settings and your shuffle will lean toward ${r.winner === 0 ? a : b}.`}
            </p>
          )}
          {r.winner !== null && e.arms[0].kind === "timer" && (
            <p className="text-xs text-[var(--ink-3)]">
              {learning
                ? `It's your timer now: the Sleep screen sets the ${r.winner === 0 ? a : b} each night, in place of the learned one. A timer you pick by hand still holds for that night.`
                : `Turn on "Learn my timer" in Settings and the Sleep screen will set the ${r.winner === 0 ? a : b} each night.`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {r.winner === null && (
              <button onClick={() => { extendExperiment(5); onChange(); }} className="rounded-lg bg-[var(--raised)] px-3 py-2 text-sm font-semibold text-[var(--ink-2)] hover:text-[var(--ink)]">
                5 more nights each
              </button>
            )}
            <button onClick={() => { endExperiment(); onChange(); }} className="rounded-lg bg-[var(--raised)] px-3 py-2 text-sm font-semibold text-[var(--ink-2)] hover:text-[var(--ink)]">
              Done
            </button>
          </div>
        </>
      )}
      {!r.done && (
        confirmEnd ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ink-3)]">
            <span>End it now, without a result?</span>
            <button onClick={() => { endExperiment(); onChange(); }} className="rounded-lg bg-[var(--raised)] px-3 py-1.5 font-semibold text-[var(--danger)]">End experiment</button>
            <button onClick={() => setConfirmEnd(false)} className="rounded-lg px-3 py-1.5 underline decoration-[var(--line)] underline-offset-4">Keep going</button>
          </div>
        ) : (
          <button onClick={() => setConfirmEnd(true)} className="text-xs text-[var(--ink-3)] underline decoration-[var(--line)] underline-offset-4 hover:text-[var(--ink-2)]">
            End early
          </button>
        )
      )}
    </div>
  );
}

function Start({ feeds, onStart }: { feeds: { id: string; title: string; enabled: boolean }[]; onStart: () => void }) {
  const on = feeds.filter((f) => f.enabled);
  const [kind, setKind] = useState<"show" | "timer">(on.length >= 2 ? "show" : "timer");
  const [showA, setShowA] = useState(on[0]?.id ?? "");
  const [showB, setShowB] = useState(on[1]?.id ?? "");
  const [timerA, setTimerA] = useState<number>(TIMER_PRESETS[0]);
  const [timerB, setTimerB] = useState<number>(TIMER_PRESETS[1]);
  const [each, setEach] = useState(7);
  const same = kind === "show" ? showA === showB : timerA === timerB;
  const select = "w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2 py-2 text-sm text-[var(--ink)]";

  function start() {
    const arms: [Arm, Arm] =
      kind === "show"
        ? [{ kind: "show", feedId: showA }, { kind: "show", feedId: showB }]
        : [{ kind: "timer", minutes: timerA }, { kind: "timer", minutes: timerB }];
    startExperiment(arms, each);
    onStart();
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-[var(--ink-2)]">
        Find out which of two shows, or two timers, puts you to sleep faster. Each night you tap the moon gets one of the two at random, so neither gets the easier nights.
      </p>
      <div role="radiogroup" aria-label="Compare" className="flex gap-2">
        {(["show", "timer"] as const).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={kind === k}
            disabled={k === "show" && on.length < 2}
            onClick={() => setKind(k)}
            className={`flex-1 rounded-lg py-2 text-sm font-semibold disabled:opacity-40 ${kind === k ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--raised)] text-[var(--ink-2)]"}`}
          >
            {k === "show" ? "Two shows" : "Two timers"}
          </button>
        ))}
      </div>
      {kind === "show" && on.length < 2 && <p className="text-xs text-[var(--ink-3)]">Turn on two shows in Podcasts to compare them.</p>}
      <div className="grid grid-cols-2 gap-2">
        {kind === "show" ? (
          <>
            <label className="space-y-1 text-xs text-[var(--ink-3)]">
              <span>First</span>
              <select id="experiment-show-a" value={showA} onChange={(ev) => setShowA(ev.target.value)} className={select}>
                {on.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs text-[var(--ink-3)]">
              <span>Second</span>
              <select id="experiment-show-b" value={showB} onChange={(ev) => setShowB(ev.target.value)} className={select}>
                {on.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
              </select>
            </label>
          </>
        ) : (
          <>
            <label className="space-y-1 text-xs text-[var(--ink-3)]">
              <span>First</span>
              <select id="experiment-timer-a" value={timerA} onChange={(ev) => setTimerA(Number(ev.target.value))} className={select}>
                {TIMER_PRESETS.map((m) => <option key={m} value={m}>{`${m} minutes`}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs text-[var(--ink-3)]">
              <span>Second</span>
              <select id="experiment-timer-b" value={timerB} onChange={(ev) => setTimerB(Number(ev.target.value))} className={select}>
                {TIMER_PRESETS.map((m) => <option key={m} value={m}>{`${m} minutes`}</option>)}
              </select>
            </label>
          </>
        )}
      </div>
      <label className="flex items-center justify-between gap-2 text-xs text-[var(--ink-3)]">
        <span>Nights each</span>
        <select id="experiment-nights" value={each} onChange={(ev) => setEach(Number(ev.target.value))} className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--ink)]">
          {NIGHTS_EACH.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <p className="text-xs text-[var(--ink-3)]">
        {`About ${each * 2} nights in all. Timed by your watch when it has the night, otherwise by Sleepcast's own guess.`}
      </p>
      <button
        onClick={start}
        disabled={same || (kind === "show" && on.length < 2)}
        className="w-full rounded-lg bg-[var(--accent)] py-2 text-sm font-semibold text-[var(--accent-ink)] disabled:opacity-40"
      >
        {same ? "Pick two different ones" : "Start experiment"}
      </button>
    </div>
  );
}
