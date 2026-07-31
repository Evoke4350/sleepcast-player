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
// brain gets one choice and no numbers. Shown only when shouldReanchor() is
// true (reopened in the dark soon after a faded night, with more to play).
export function ReanchorView({ next, onKeepDrifting, onDismiss }: ReanchorViewProps) {
  useEffect(() => { beacon("reanchor_shown"); }, []);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-10 bg-[#050508] px-8 text-center">
      <p className="text-sm text-[#4a4540]">still here?</p>
      <button
        onClick={() => { beacon("reanchor_tapped"); onKeepDrifting(); }}
        className="rounded-2xl border border-[#241f30] bg-[#0c0a12] px-10 py-6 text-lg text-[#d9c9a8] transition-transform active:scale-95"
      >
        keep drifting
      </button>
      <button
        onClick={() => { beacon("reanchor_dismissed"); onDismiss(); }}
        className="text-xs text-[#3a3630] underline decoration-[#241f30] underline-offset-4"
      >
        I'm up
      </button>
    </main>
  );
}
