import { useEffect } from "react";
import type { Episode } from "../lib/engine";

// No-PII aggregate beacon, same shape as SleepSetup's — a single allowlisted
// name, GET + keepalive (Astro's CSRF guard forbids the POST form).
function beacon(name: string) {
  try {
    fetch(`/api/_event?e=${encodeURIComponent(name)}`, { method: "GET", keepalive: true, cache: "no-store" });
  } catch { /* ignore */ }
}

interface ReanchorViewProps {
  next: Episode;
  onKeepDrifting: () => void;
  onDismiss: () => void;
}

// The middle-night re-entry: near-black, no time, one tap. The half-asleep
// brain gets one choice and no numbers. Shown only when reanchorNext() finds
// an episode (reopened in the dark soon after a faded night, with more to play).
export function ReanchorView({ next, onKeepDrifting, onDismiss }: ReanchorViewProps) {
  useEffect(() => { beacon("reanchor_shown"); }, []);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-[var(--ground)] px-8 text-center">
      <span className="player-moon text-6xl text-[var(--accent)]" aria-hidden="true">☾</span>
      <div className="max-w-xs space-y-2">
        <h1 className="text-2xl font-bold text-[var(--ink)]">Still here?</h1>
        <p className="text-sm text-[var(--ink-3)]">
          You woke within a few hours of last night's fade. Keep drifting picks up the same shows where they went quiet, on a fresh timer.
        </p>
      </div>
      <button
        onClick={() => { beacon("reanchor_tapped"); onKeepDrifting(); }}
        className="rounded-full bg-[var(--accent)] px-8 py-3.5 text-base font-bold text-[var(--accent-ink)] transition-transform active:scale-95"
      >
        Keep drifting
      </button>
      <button
        onClick={() => { beacon("reanchor_dismissed"); onDismiss(); }}
        className="text-sm font-semibold text-[var(--ink-3)]"
      >
        I'm up
      </button>
    </main>
  );
}
