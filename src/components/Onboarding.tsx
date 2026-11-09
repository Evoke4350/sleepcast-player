import { useState } from "react";
import { AgeQuestion, TooYoung } from "./AgeGate";
import { CONSENT_KEY, initConsent } from "../lib/analytics";
import { STARTER_SHOWS, applyStarterShows, markOnboarded } from "../lib/onboarding";

type Step = "welcome" | "age" | "under" | "shows" | "analytics";

/** The steps a progress bar counts (the welcome and a refusal don't). */
const COUNTED: Step[] = ["age", "shows", "analytics"];

/**
 * The first visit (see lib/onboarding): a welcome, the age question, a few
 * shows to start with, and the analytics choice, as screens of their own
 * rather than a banner over the app. Then the app, on the Sleep tab.
 */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function finish(consent: "granted" | "denied") {
    try { localStorage.setItem(CONSENT_KEY, consent); } catch { /* the banner asks again */ }
    markOnboarded();
    initConsent(); // analytics now, if allowed; no banner, it's been answered
    onDone();
  }

  const at = COUNTED.indexOf(step);
  const back: Step | null = step === "shows" ? "age" : step === "analytics" ? "shows" : null;

  if (step === "welcome") return <Welcome onStart={() => setStep("age")} />;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-[calc(1rem+env(safe-area-inset-top,0px))]">
      {at >= 0 && (
        <div className="mb-8 grid grid-cols-[40px_1fr_40px] items-center gap-3">
          {back ? (
            <button onClick={() => setStep(back)} aria-label="Back" className="grid h-10 w-10 place-items-center rounded-full text-[var(--ink)] hover:bg-[var(--raised)]">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
          ) : <span />}
          <div role="progressbar" aria-label="Getting set up" aria-valuemin={1} aria-valuemax={COUNTED.length} aria-valuenow={at + 1} className="grid grid-cols-3 gap-1.5">
            {COUNTED.map((s, i) => (
              <span key={s} className={`h-1 rounded-full ${i <= at ? "bg-[var(--accent)]" : "bg-[var(--line)]"}`} />
            ))}
          </div>
          <span />
        </div>
      )}

      {step === "age" && (
        <div className="mx-auto w-full max-w-sm flex-1 pt-6">
          <AgeQuestion onAnswer={(a) => setStep(a === "ok" ? "shows" : "under")} />
        </div>
      )}

      {step === "under" && (
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6">
          <div aria-hidden="true" className="text-5xl text-[var(--accent)]">☾</div>
          <TooYoung onRetry={() => setStep("age")} />
        </div>
      )}

      {step === "shows" && (
        <div className="flex flex-1 flex-col">
          <div className="space-y-2">
            <h1 className="text-[28px] font-extrabold leading-tight tracking-tight text-[var(--ink)]">Pick a few shows</h1>
            <p className="text-[15px] leading-relaxed text-[var(--ink-2)]">Sleepcast shuffles between the ones you pick. You can change them any time in Podcasts.</p>
          </div>
          <ul className="mt-6 grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4">
            {STARTER_SHOWS.map((s) => {
              const on = picked.has(s.key);
              return (
                <li key={s.key}>
                  <button onClick={() => toggle(s.key)} aria-pressed={on} className="group w-full text-left">
                    <span className={`relative block overflow-hidden rounded-xl transition ${on ? "ring-[3px] ring-[var(--accent)]" : "ring-1 ring-[var(--line)]"}`}>
                      <img src={s.art} alt="" loading="lazy" className={`aspect-square w-full bg-[var(--raised)] object-cover transition ${on ? "opacity-70" : "group-hover:opacity-90"}`} />
                      {on && (
                        <span aria-hidden="true" className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] shadow">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M5 12l5 5L19 7" /></svg>
                        </span>
                      )}
                    </span>
                    <span className="mt-1.5 line-clamp-2 block text-[13px] font-semibold leading-snug text-[var(--ink)]">{s.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {/* Held at the foot of the screen while the covers scroll. */}
          <div className="sticky bottom-0 -mx-6 mt-6 bg-gradient-to-t from-[var(--ground)] from-60% to-transparent px-6 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] pt-8">
            <button
              onClick={() => { applyStarterShows(picked); setStep("analytics"); }}
              disabled={picked.size === 0}
              className="mx-auto block w-full max-w-sm rounded-full bg-[var(--accent)] px-5 py-3.5 text-base font-bold text-[var(--accent-ink)] disabled:opacity-40"
            >
              {picked.size === 0 ? "Pick at least one" : `Continue with ${picked.size} ${picked.size === 1 ? "show" : "shows"}`}
            </button>
          </div>
        </div>
      )}

      {step === "analytics" && (
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col pt-6">
          <div className="space-y-2">
            <h1 className="text-[28px] font-extrabold leading-tight tracking-tight text-[var(--ink)]">Help make Sleepcast better?</h1>
            <p className="text-[15px] leading-relaxed text-[var(--ink-2)]">
              Sleepcast can use Google Analytics to understand how the app is used. It stays off unless you allow it. <a href="/privacy" className="font-semibold text-[var(--ink)] underline underline-offset-2">How Sleepcast handles your data</a>
            </p>
          </div>
          <div className="mt-8 space-y-3">
            <button onClick={() => finish("granted")} className="w-full rounded-full bg-[var(--accent)] px-5 py-3.5 text-base font-bold text-[var(--accent-ink)]">Allow analytics</button>
            <button onClick={() => finish("denied")} className="w-full rounded-full bg-[var(--raised)] px-5 py-3.5 text-base font-bold text-[var(--ink)] ring-1 ring-[var(--line)]">No thanks</button>
          </div>
        </div>
      )}
    </main>
  );
}

/** Rows of covers drifting behind the welcome, under a night sky. */
function Welcome({ onStart }: { onStart: () => void }) {
  const arts = STARTER_SHOWS.map((s) => s.art);
  const rows = [0, 1, 2].map((r) => {
    const row = arts.filter((_, i) => i % 3 === r);
    return [...row, ...row]; // twice over, so the drift never shows an end
  });
  return (
    <main className="relative flex min-h-dvh flex-col overflow-hidden">
      <div aria-hidden="true" className="sleep-sky absolute inset-0" />
      <div aria-hidden="true" className="relative -mx-10 mt-[calc(2.5rem+env(safe-area-inset-top,0px))] -rotate-6 space-y-3 opacity-90 [mask-image:linear-gradient(to_bottom,black_45%,transparent)]">
        {rows.map((row, r) => (
          <div key={r} className={`flex w-max gap-3 ob-drift ${r % 2 ? "ob-drift-back" : ""}`}>
            {row.map((src, i) => (
              <img key={i} src={src} alt="" className="h-24 w-24 shrink-0 rounded-xl object-cover shadow-[0_6px_20px_rgba(0,0,0,0.35)] sm:h-32 sm:w-32" />
            ))}
          </div>
        ))}
      </div>
      <div className="relative mx-auto mt-auto w-full max-w-sm space-y-6 px-6 pb-[calc(2rem+env(safe-area-inset-bottom,0px))]">
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[var(--accent)]">
            <span aria-hidden="true" className="text-2xl">☾</span>
            <span className="font-serif-display text-xl text-[var(--ink)]">sleepcast</span>
          </div>
          <h1 className="text-[34px] font-extrabold leading-[1.08] tracking-tight text-[var(--ink)]">Fall asleep to a story.</h1>
          <p className="text-base leading-relaxed text-[var(--ink-2)]">Calm podcasts on shuffle, with a timer that stops them once you&apos;ve drifted off.</p>
        </div>
        <button onClick={onStart} className="w-full rounded-full bg-[var(--accent)] px-5 py-3.5 text-base font-bold text-[var(--accent-ink)]">Get started</button>
      </div>
    </main>
  );
}
