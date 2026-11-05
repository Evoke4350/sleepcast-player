import { useState, type ReactNode } from "react";
import { clearAge, oldEnough, retryAt, saveAge, storedAge, MIN_AGE, type AgeAnswer } from "../lib/age";
import { initConsent } from "../lib/analytics";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const FIELD = "w-full appearance-none rounded-xl bg-[var(--raised)] px-4 py-3 text-base font-semibold text-[var(--ink)] ring-1 ring-[var(--line)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]";

/** "When were you born?": month and year, answered once and kept (see
 *  age.ts). Shared by the gate and the first-visit screens. */
export function AgeQuestion({ onAnswer }: { onAnswer: (a: AgeAnswer) => void }) {
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 101 }, (_, i) => thisYear - i);

  function submit() {
    if (!month || !year) return;
    const a: AgeAnswer = oldEnough(Number(year), Number(month), new Date()) ? "ok" : "under";
    saveAge(a);
    onAnswer(a);
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-[28px] font-extrabold leading-tight tracking-tight text-[var(--ink)]">When were you born?</h1>
        <p className="text-[15px] leading-relaxed text-[var(--ink-2)]">Sleepcast is for people {MIN_AGE} and over.</p>
      </div>
      <div className="grid grid-cols-[3fr_2fr] gap-3">
        <label className="space-y-1.5">
          <span className="block text-xs font-semibold text-[var(--ink-3)]">Month</span>
          <select id="birth-month" value={month} onChange={(e) => setMonth(e.target.value)} className={FIELD} required>
            <option value="" disabled>Month</option>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block text-xs font-semibold text-[var(--ink-3)]">Year</span>
          <select id="birth-year" value={year} onChange={(e) => setYear(e.target.value)} className={FIELD} required>
            <option value="" disabled>Year</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
      </div>
      <button type="submit" disabled={!month || !year} className="w-full rounded-full bg-[var(--accent)] px-5 py-3.5 text-base font-bold text-[var(--accent-ink)] disabled:opacity-40">
        Continue
      </button>
    </form>
  );
}

/** Under 13, with the way back for a wrong year: the date asked again,
 *  once a day has passed since the answer (see age.ts). */
export function TooYoung({ onRetry }: { onRetry: () => void }) {
  const [at] = useState(() => retryAt() ?? 0);
  const ready = Date.now() >= at;
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-extrabold tracking-tight text-[var(--ink)]">Sleepcast isn&apos;t for you yet</h1>
      <p className="text-[15px] leading-relaxed text-[var(--ink-2)]">
        Sleepcast is for people {MIN_AGE} and over. If you&apos;re looking for help sleeping, a parent or guardian is a good place to start.
      </p>
      <div className="pt-4">
        {ready ? (
          <button onClick={() => { clearAge(); onRetry(); }} className="rounded-full px-4 py-2 text-sm font-semibold text-[var(--ink-2)] ring-1 ring-[var(--line)] hover:text-[var(--ink)]">
            Entered the wrong date? Enter it again
          </button>
        ) : (
          <p className="text-[13px] text-[var(--ink-3)]">
            Entered the wrong date? You can enter it again after {new Date(at).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })}.
          </p>
        )}
      </div>
    </div>
  );
}

/** Asks when you were born, once per device, before the app; under 13,
 *  the app never loads. */
export function AgeGate({ children }: { children: ReactNode }) {
  const [answer, setAnswer] = useState<AgeAnswer | null>(storedAge);

  if (answer === "ok") return <>{children}</>;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-6 py-10">
      <div aria-hidden="true" className="text-5xl text-[var(--accent)]">☾</div>
      {answer === "under" ? (
        <TooYoung onRetry={() => setAnswer(null)} />
      ) : (
        <AgeQuestion
          onAnswer={(a) => {
            setAnswer(a);
            // The analytics banner waited for this (see initConsent).
            if (a === "ok") initConsent();
          }}
        />
      )}
    </main>
  );
}
