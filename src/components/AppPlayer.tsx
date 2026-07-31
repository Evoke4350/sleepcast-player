import { useState, useEffect } from "react";
import type { Episode } from "@/lib/engine";
import { formatTime } from "@/lib/engine";
import { loadLive, clearLive, clearLastNight, loadLastNight, type LiveSession, type LastNight, loadState } from "@/lib/store";
import { shouldReanchor, nextInSpread } from "@/lib/rest/reanchor";
import { DEFAULT_FEEL_MINUTES } from "@/lib/timer-feel";
import { SleepSetup } from "./SleepSetup";
import { Player } from "./Player";
import { RestView } from "./RestView";
import { ReanchorView } from "./ReanchorView";
import { shouldGreetGoodbye, markGoodbyeSeen, fmtDuration } from "@/lib/rest/surface";
import { loadNights, loadQuietUntil, saveQuietUntil, loadStepBackAsked, markStepBackAsked } from "@/lib/rest/ledger";
import { qualifiesForStepBack, isQuiet, quietUntilFrom } from "@/lib/rest/stepback";

interface ResumeDescriptor {
  episode: Episode;
  position: number;
  remainingMs: number;
  totalSeconds: number;
  playedIds: string[];
}

interface SessionState {
  pool: Episode[];
  timerMinutes: number;
  skipIntroByFeedId: Record<string, number>;
  feedTitles: Record<string, string>;
  artworkByFeedId: Record<string, string>;
  leadEpisode?: Episode | null;
  wasVaried?: boolean;
  /** Where to resume the lead episode, from "the exact one again" or a search
   *  result. Written and read since that shipped, but never declared — which
   *  is part of why typecheck has been red. */
  leadPosition?: number;
}

// The /app player: the setup screen until a night begins, then the immersive
// player. A night in progress is snapshotted to localStorage (store.saveLive),
// so a full reload — including iOS reclaiming the backgrounded tab — can offer
// to resume it rather than waking you to silence.
export function AppPlayer() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [resume, setResume] = useState<ResumeDescriptor | null>(null);
  const [view, setView] = useState<"player" | "rest">("player");
  // Quiet mode: the app has been told to stop nudging for a while.
  const [quiet, setQuiet] = useState(() => isQuiet(loadQuietUntil(), Date.now()));
  // Read when a night STARTS, not at island mount. AppPlayer mounts once per
  // page load and never remounts between nights, so reading it here meant
  // ticking the box in the drawer had no effect until a full reload — the
  // whole feature silently did nothing.
  const [quarterHourRule, setQuarterHourRule] = useState(false);

  const [goodbye] = useState(() => (isQuiet(loadQuietUntil(), Date.now()) ? null : shouldGreetGoodbye(Date.now())));

  // Offer to step back after a long run of falling asleep quickly. Asked at
  // most once per quiet period — repeatedly raising it would be the nagging
  // the offer exists to remove.
  const [stepBack, setStepBack] = useState(() => {
    const now = Date.now();
    if (isQuiet(loadQuietUntil(), now)) return false;
    const asked = loadStepBackAsked();
    if (asked !== null && isQuiet(quietUntilFrom(asked), now)) return false;
    return qualifiesForStepBack(loadNights());
  });

  function goQuiet() {
    const now = Date.now();
    saveQuietUntil(quietUntilFrom(now));
    markStepBackAsked(now);
    setQuiet(true);
    setStepBack(false);
  }

  function stayOn() {
    markStepBackAsked(Date.now());
    setStepBack(false);
  }

  // Acknowledge it as soon as it is shown. It used to be a full-screen gate
  // with a "start tonight" button that did the marking, which meant an extra
  // tap at bedtime for a screen that says there is nothing to check. Now it is
  // a line above the setup screen and costs nothing.
  useEffect(() => {
    if (goodbye) markGoodbyeSeen(goodbye.startedAt);
  }, [goodbye?.startedAt]);

  // A night snapshotted before a reload. Offer to revive it only if enough
  // time is left to be worth it; a stale one gets cleared.
  const [live, setLive] = useState<LiveSession | null>(() => {
    const l = loadLive();
    if (l && l.remainingMs > 60_000) return l;
    if (l) clearLive();
    return null;
  });

  const [reanchor, setReanchor] = useState<{ lastNight: LastNight; next: Episode } | null>(null);

  // The 3am catch: on mount and whenever the tab comes back to the foreground,
  // ask the pure gate whether the user reopened in the dark soon after a night
  // that faded, with something left in the spread. getHours() is read in memory
  // only — never shown, never sent.
  useEffect(() => {
    const check = () => {
      // Resume outranks re-anchor: if a live night is still revivable, let the
      // resume card win and never show the re-anchor. (A faded night clears
      // KEY_LIVE, so normally only one of the two is present — this guards the
      // edge where an older faded night lingers under a still-live one.)
      const live = loadLive();
      if (live && live.remainingMs > 60_000) {
        setReanchor(null);
        return;
      }
      const lastNight = loadLastNight();
      // Quiet mode suppresses the 3am catch — that nudge is the main thing
      // "go quiet" is meant to turn off.
      // Re-read rather than trusting the closure: this listener is registered
      // once and would otherwise hold `quiet` from the first render forever.
      if (isQuiet(loadQuietUntil(), Date.now()) || !shouldReanchor({ lastNight, now: Date.now(), localHour: new Date().getHours() })) {
        setReanchor(null);
        return;
      }
      const next = nextInSpread(lastNight!.pool, lastNight!.playedIds);
      if (next) setReanchor({ lastNight: lastNight!, next });
    };
    check();
    const onVis = () => { if (!document.hidden) check(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  function handleStart(
    pool: Episode[],
    timerMinutes: number,
    skipIntroByFeedId: Record<string, number>,
    feedTitles: Record<string, string>,
    artworkByFeedId: Record<string, string>,
    leadEpisode?: Episode | null,
    wasVaried?: boolean,
    leadPosition?: number
  ) {
    setResume(null); // a fresh night, not a revival
    setLive(null);
    setQuarterHourRule(loadState().settings.quarterHourRule);
    clearLastNight(); // a new night supersedes any prior faded one
    setSession({ pool, timerMinutes, skipIntroByFeedId, feedTitles, artworkByFeedId, leadEpisode, wasVaried, leadPosition });
  }

  // Revive the snapshotted night. The tap is also the autoplay gesture a
  // reload needs before audio can start again.
  function handleResume() {
    if (!live) return;
    setResume({
      episode: live.current,
      position: live.position,
      remainingMs: live.remainingMs,
      totalSeconds: live.totalSeconds,
      playedIds: live.playedIds ?? [],
    });
    setSession({
      pool: live.pool,
      timerMinutes: Math.max(1, Math.round(live.totalSeconds / 60)),
      skipIntroByFeedId: live.skipIntroByFeedId,
      feedTitles: live.feedTitles,
      artworkByFeedId: live.artworkByFeedId,
    });
    setLive(null);
  }

  function handleEnd() {
    setResume(null);
    setSession(null);
  }

  // Continue the spread as a fresh clock-blind night, led by the next unplayed
  // episode, at the default feel-timer. Routes through handleStart so it behaves
  // like any night (persists live, re-records lastnight, catches a 2nd wake).
  function handleKeepDrifting() {
    if (!reanchor) return;
    const { lastNight, next } = reanchor;
    setReanchor(null);
    handleStart(
      lastNight.pool,
      DEFAULT_FEEL_MINUTES,
      lastNight.skipIntroByFeedId,
      lastNight.feedTitles,
      lastNight.artworkByFeedId,
      next,
      lastNight.wasVaried
    );
  }

  function handleReanchorDismiss() {
    clearLastNight(); // don't nag again this night
    setReanchor(null);
  }

  if (session) {
    return (
      <Player
        pool={session.pool}
        timerMinutes={session.timerMinutes}
        skipIntroByFeedId={session.skipIntroByFeedId}
        feedTitles={session.feedTitles}
        artworkByFeedId={session.artworkByFeedId}
        onEnd={handleEnd}
        resume={resume}
        leadEpisode={session.leadEpisode}
        leadPosition={session.leadPosition ?? 0}
        quarterHourRule={quarterHourRule}
        wasVaried={session.wasVaried ?? false}
      />
    );
  }

  if (reanchor) {
    return (
      <ReanchorView
        next={reanchor.next}
        onKeepDrifting={handleKeepDrifting}
        onDismiss={handleReanchorDismiss}
      />
    );
  }

  if (view === "rest") return <RestView onClose={() => setView("player")} />;
  return (
    <main className="flex-1 px-4 py-8 text-[#b59a76]">
      <div className="mx-auto max-w-xl">
        {live && (
          <div className="mb-6 rounded-xl border border-[#3a3325] bg-[#171310] p-4">
            <p className="text-center text-[0.7rem] uppercase tracking-widest text-[#6e5d44]">still playing from before</p>
            <p className="mt-1.5 truncate text-center text-sm text-[#d9c9a8]">{live.current.title}</p>
            <p className="mt-0.5 text-center text-xs text-[#8a7a5c]">
              {formatTime(live.position)} in · {Math.round(live.remainingMs / 60_000)} min left on the timer
            </p>
            <button
              onClick={handleResume}
              className="mt-3 w-full rounded-lg border border-[#6e5d44] bg-[#1a1b26] py-2.5 text-sm font-medium text-[#f0dcb8] transition-transform hover:border-[#8a7a5c] active:scale-95"
            >
              ▶ keep going
            </button>
            <button
              onClick={() => { clearLive(); setLive(null); }}
              className="mt-2 block w-full text-center text-xs text-[#4a4540] underline decoration-[#2a2620] underline-offset-4 transition-colors hover:text-[#8a7a5c]"
            >
              or start fresh
            </button>
          </div>
        )}
        {stepBack && (
          <div className="mb-6 rounded-xl border border-[#3a3325] bg-[#171310] p-4 text-center">
            <p className="text-sm text-[#d9c9a8]">you've been falling asleep quickly for a while.</p>
            <p className="mt-1 text-xs text-[#8a7a5c]">
              you might not need us at the moment. we can stop nudging — no 3am
              check-in, no morning note — and stay out of the way.
            </p>
            <div className="mt-3 flex justify-center gap-3 text-sm">
              <button
                onClick={goQuiet}
                className="rounded-full border border-[#6e5d44] px-4 py-1.5 text-[#f0dcb8] transition-colors hover:border-[#8a7a5c]"
              >
                go quiet for a month
              </button>
              <button
                onClick={stayOn}
                className="rounded-full border border-[#3a3325] px-4 py-1.5 text-[#8a7a5c] transition-colors hover:border-[#6e5d44]"
              >
                stay as you are
              </button>
            </div>
          </div>
        )}
        {goodbye && (
          <div className="mb-6 flex items-center justify-center gap-2 text-center text-xs text-[#6e5d44]">
            <span className="player-moon text-sm text-[#8a7a5c]">☾</span>
            <span>
              you slept{goodbye.timeToSleepMs !== null ? ` — gone in ${fmtDuration(goodbye.timeToSleepMs)}` : ""}.
            </span>
          </div>
        )}
        <SleepSetup onStart={handleStart} />
        <button onClick={() => setView("rest")} className="mt-8 block w-full text-center text-xs text-[#4a4540] underline decoration-[#2a2620] underline-offset-4 hover:text-[#8a7a5c]">
          your rest
        </button>
      </div>
    </main>
  );
}
