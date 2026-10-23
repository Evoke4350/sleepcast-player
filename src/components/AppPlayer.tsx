import { useState, useEffect, useRef } from "react";
import { cleanStoredWebData } from "../lib/web-cleanup";
import { TabBar, type AppTab } from "./TabBar";
import type { Episode } from "../lib/engine";
import { formatTime } from "../lib/engine";
import { loadLive, clearLastNight, loadLastNight, type LiveSession, type LastNight, type ResumeDescriptor, resumeFrom, nightTimerMinutes, loadState, isRevivable, resumeMode, loadBlocked } from "../lib/store";
import type { PlayMode } from "../lib/engine";
import { reanchorNext } from "../lib/rest/reanchor";
import { DEFAULT_TIMER_MINUTES } from "../lib/timer-presets";
import { SleepSetup } from "./SleepSetup";
import { Player } from "./Player";
import { RestView } from "./RestView";
import { reconcileLive, settleLive } from "../lib/rest/reconcile";
import { ReanchorView } from "./ReanchorView";
import { shouldGreetGoodbye, markGoodbyeSeen, fmtDuration } from "../lib/rest/surface";
import { loadNights, loadQuietUntil, saveQuietUntil, loadStepBackAsked, markStepBackAsked } from "../lib/rest/ledger";
import { qualifiesForStepBack, isQuiet, quietUntilFrom } from "../lib/rest/stepback";
import { importWatchSleep, watchPayloadFromHash, describeImport } from "../lib/rest/watch";

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
  // Before anything below reads storage: what the removed features left.
  const [session, setSession] = useState<SessionState | null>(() => {
    cleanStoredWebData();
    return null;
  });
  const [resume, setResume] = useState<ResumeDescriptor | null>(null);
  // The section shown when no night plays. Sleep first: it's what the app is
  // opened for, at night.
  const [tab, setTab] = useState<AppTab>("sleep");
  // Each visit to Rest reads the ledger afresh (a night may have ended since).
  const [restVisit, setRestVisit] = useState(0);
  // What the watch's sleep did, when the page was opened by the Shortcut.
  const [watchNote, setWatchNote] = useState<string | null>(null);
  // Now Playing open (a night just started) or collapsed to the mini bar.
  const [expanded, setExpanded] = useState(true);
  // A new night remounts the player: its state is the night's.
  const [nightKey, setNightKey] = useState(0);
  // Setup stays up through a night (its tabs are browsed); when the night
  // ends it is rebuilt, to read what the night wrote (the re-arm stamp, the
  // last episode, episodes marked never again, the greeting).
  const [setupKey, setSetupKey] = useState(0);
  // Browsing during a night is being awake: reported to the night's rest
  // session, set by the Player while it is mounted.
  const noteActivityRef = useRef<(() => void) | null>(null);
  // Ends the playing night, set by the Player while it is mounted.
  const endPlayingRef = useRef<(() => void) | null>(null);
  // Quiet mode: the app has been told to stop nudging for a while.
  const [quiet, setQuiet] = useState(() => isQuiet(loadQuietUntil(), Date.now()));
  // Read when a night STARTS, not at island mount. AppPlayer mounts once per
  // page load and never remounts between nights, so reading it here meant
  // ticking the box in the drawer had no effect until a full reload — the
  // whole feature silently did nothing.
  const [quarterHourRule, setQuarterHourRule] = useState(false);
  // Opt-in: the night's shuffle leans by what has put the listener under.
  const [favorWhatWorks, setFavorWhatWorks] = useState(false);
  // Read at start, not at mount: settings changed on the setup screen must
  // apply to the night about to begin.
  const [mode, setMode] = useState<PlayMode>({ kind: "minutes", minutes: 45 });
  const [feedTrim, setFeedTrim] = useState<Record<string, number>>({});
  const [leveling, setLeveling] = useState(false);

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

  // Opened by the watch Shortcut (#watch=…): match its sleep to the nights,
  // take the data out of the address bar, and show what it did on Rest.
  // After settleLive above, so a night whose tab was killed is in the ledger
  // to be matched.
  // Also on hashchange: with Sleepcast already open in the tab the link
  // lands in, only the hash changes and nothing reloads.
  useEffect(() => {
    const take = () => {
      const payload = watchPayloadFromHash(window.location.hash);
      if (payload === null) return;
      history.replaceState(null, "", window.location.pathname + window.location.search);
      setWatchNote(describeImport(importWatchSleep(payload), { brief: true }));
      setRestVisit((n) => n + 1);
      setTab("rest");
    };
    take();
    window.addEventListener("hashchange", take);
    return () => window.removeEventListener("hashchange", take);
  }, []);

  // Acknowledge it as soon as it is shown. It used to be a full-screen gate
  // with a "start tonight" button that did the marking, which meant an extra
  // tap at bedtime for a screen that says there is nothing to check. Now it is
  // a line above the setup screen and costs nothing.
  useEffect(() => {
    if (goodbye) markGoodbyeSeen(goodbye.startedAt);
  }, [goodbye?.startedAt]);

  // A night snapshotted before a reload. Offer to revive it only if enough
  // time is left and it is recent; otherwise the tab was killed and the night
  // is over, so record it (rest/reconcile.ts) rather than dropping it.
  const [live, setLive] = useState<LiveSession | null>(() => settleLive(loadLive(), Date.now()));

  const [reanchor, setReanchor] = useState<{ lastNight: LastNight; next: Episode } | null>(null);

  // The 3am catch: on mount and whenever the tab comes back to the foreground,
  // ask the gate (pure but for the blocked list, read through loadBlocked
  // only when needed) whether the user reopened in the dark soon after a night
  // that faded, with something left in the spread. getHours() is read in memory
  // only — never shown, never sent.
  useEffect(() => {
    const check = () => {
      // Resume outranks re-anchor: if a live night is still revivable, let the
      // resume card win and never show the re-anchor. (A faded night clears
      // KEY_LIVE, so normally only one of the two is present — this guards the
      // edge where an older faded night lingers under a still-live one.)
      const live = loadLive();
      if (isRevivable(live, Date.now())) {
        setReanchor(null);
        return;
      }
      const lastNight = loadLastNight();
      // Quiet mode suppresses the 3am catch — that nudge is the main thing
      // "go quiet" is meant to turn off.
      // Re-read rather than trusting the closure: this listener is registered
      // once and would otherwise hold `quiet` from the first render forever.
      const next = isQuiet(loadQuietUntil(), Date.now())
        ? null
        : reanchorNext({ lastNight, now: Date.now(), localHour: new Date().getHours(), blocked: loadBlocked });
      // (reanchorNext only finds an episode when there is a last night.)
      setReanchor(next ? { lastNight: lastNight!, next } : null);
    };
    check();
    const onVis = () => { if (!document.hidden) check(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Settings the players take as props, read fresh when a night starts or is
  // revived. A revived night used to skip this and run on the mount defaults:
  // no per-feed trim (a turned-down feed came back at full volume),
  // no leveling, no quarter-hour rule, and a 45-minute timed mode.
  function applyNightSettings(nightMode: PlayMode) {
    const settings = loadState().settings;
    setQuarterHourRule(settings.quarterHourRule);
    setMode(nightMode);
    setFeedTrim(settings.feedTrim);
    setLeveling(settings.leveling);
    setFavorWhatWorks(settings.favorWhatWorks);
  }

  /** A snapshotted night still stored is over, and recorded: the card's,
   *  or one settleLive left because it was seconds old (one tab in
   *  practice). Read from storage, not the resume card's state: a recorded
   *  snapshot is removed there, so a late second call records nothing twice.
   *  Any prior last night goes. `keepItsLastNight`: starting a night, the
   *  recorded one's own last night stays, for a re-anchor if the new one
   *  never plays; declining it ("or start fresh"), it goes too, so no
   *  re-anchor offers the night just turned down. */
  function recordStoredNight(keepItsLastNight: boolean) {
    if (keepItsLastNight) clearLastNight();
    const stored = loadLive();
    if (stored) reconcileLive(stored, Date.now());
    if (!keepItsLastNight) clearLastNight();
    setLive(null);
  }

  function handleStart(
    pool: Episode[],
    timerMinutes: number,
    skipIntroByFeedId: Record<string, number>,
    feedTitles: Record<string, string>,
    artworkByFeedId: Record<string, string>,
    leadEpisode?: Episode | null,
    wasVaried?: boolean,
    leadPosition?: number,
    modeOverride?: PlayMode
  ) {
    // A night already playing ends first, recorded as ended (an episode
    // tapped on a show's page while it plays starts a new one).
    endPlayingRef.current?.();
    setResume(null); // a fresh night, not a revival
    recordStoredNight(true);
    setExpanded(true);
    setNightKey((k) => k + 1);
    applyNightSettings(modeOverride ?? loadState().settings.mode);
    setSession({ pool, timerMinutes, skipIntroByFeedId, feedTitles, artworkByFeedId, leadEpisode, wasVaried, leadPosition });
  }

  // Revive the snapshotted night. The tap is also the autoplay gesture a
  // reload needs before audio can start again.
  function handleResume() {
    if (!live) return;
    setExpanded(true);
    setNightKey((k) => k + 1);
    applyNightSettings(resumeMode(live)); // (the lean comes with the snapshot)
    setResume(resumeFrom(live));
    setSession({
      pool: live.pool,
      timerMinutes: nightTimerMinutes(live),
      wasVaried: live.wasVaried,
      skipIntroByFeedId: live.skipIntroByFeedId,
      feedTitles: live.feedTitles,
      artworkByFeedId: live.artworkByFeedId,
    });
    setLive(null);
  }

  function handleEnd() {
    setResume(null);
    setSession(null);
    setExpanded(false);
    setSetupKey((k) => k + 1);
    // The player that held focus is gone: land on the tab you are in.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('nav [aria-current="page"]')?.focus());
    // A re-anchor found while the night played is stale now: this night
    // wrote its own last night (the next visibility check decides afresh).
    setReanchor(null);
    // A snapshot the night kept (the app gave up on a revived night) comes
    // back as the resume card, or is recorded if too old to revive.
    setLive(settleLive(loadLive(), Date.now()));
  }

  // Continue the spread as a fresh clock-blind night, led by the next unplayed
  // episode, at the default timer. Routes through handleStart so it behaves
  // like any night (persists live, re-records lastnight, catches a 2nd wake).
  function handleKeepDrifting() {
    if (!reanchor) return;
    const { lastNight, next } = reanchor;
    setReanchor(null);
    handleStart(
      lastNight.pool,
      DEFAULT_TIMER_MINUTES,
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

  // The night plays alongside the tabs: Now Playing over them, or a mini bar
  // above them while the shows are browsed.
  const player = session && (
      <Player
        key={nightKey}
        expanded={expanded}
        onExpand={() => setExpanded(true)}
        onCollapse={() => setExpanded(false)}
        endRef={endPlayingRef}
        activityRef={noteActivityRef}
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
        mode={mode}
        feedTrim={feedTrim}
        leveling={leveling}
        wasVaried={session.wasVaried ?? false}
        favorWhatWorks={favorWhatWorks}
      />
  );

  if (reanchor && !session) {
    return (
      <ReanchorView
        next={reanchor.next}
        onKeepDrifting={handleKeepDrifting}
        onDismiss={handleReanchorDismiss}
      />
    );
  }

  return (
    <main className={`flex-1 px-4 pt-8 text-[var(--ink-2)] ${session ? "pb-44" : "pb-28"}`}>
      <div className="mx-auto max-w-xl" inert={Boolean(session) && expanded} onPointerDownCapture={() => noteActivityRef.current?.()}>
        {tab === "sleep" && (<>
        {live && (
          <div className="mb-6 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
            <p className="text-center text-[0.7rem] uppercase tracking-widest text-[var(--ink-4)]">still playing from before</p>
            <p className="mt-1.5 truncate text-center text-sm text-[var(--ink)]">{live.current.title}</p>
            <p className="mt-0.5 text-center text-xs text-[var(--ink-3)]">
              {formatTime(live.position)} in · {live.modeKind === "all-night" ? "playing all night" : live.modeKind === "one-episode" ? "to the end of this one" : `${Math.round(live.remainingMs / 60_000)} min left on the timer`}
            </p>
            <button
              onClick={handleResume}
              className="mt-3 w-full rounded-lg border border-[var(--ink-4)] bg-[var(--surface)] py-2.5 text-sm font-medium text-[var(--ink)] transition-transform hover:border-[var(--ink-3)] active:scale-95"
            >
              ▶ keep going
            </button>
            <button
              onClick={() => recordStoredNight(false)}
              className="mt-2 block w-full text-center text-xs text-[var(--ink-4)] underline decoration-[var(--line)] underline-offset-4 transition-colors hover:text-[var(--ink-3)]"
            >
              or start fresh
            </button>
          </div>
        )}
        {goodbye && (
          <div className="mb-6 flex items-center justify-center gap-2 text-center text-xs text-[var(--ink-4)]">
            <span className="player-moon text-sm text-[var(--ink-3)]">☾</span>
            <span>
              you slept{goodbye.timeToSleepMs !== null ? ` — gone in ${fmtDuration(goodbye.timeToSleepMs)}` : ""}.
            </span>
          </div>
        )}
        </>)}
        <SleepSetup key={setupKey} onStart={handleStart} tab={tab === "rest" ? null : tab} />
        {tab === "rest" && (
          <>
            <RestView key={restVisit} note={watchNote} />
          {stepBack && (
            <div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
              <p className="text-[11px] font-bold uppercase tracking-widest text-[var(--ink-3)]">quick lately</p>
              <p className="mt-1 font-semibold text-[var(--ink)]">You've been falling asleep quickly for a while.</p>
              <p className="mt-1 text-xs text-[var(--ink-3)]">
                you might not need us at the moment. we can stop nudging — no 3am
                check-in, no morning note — and stay out of the way.
              </p>
              <div className="mt-3 flex gap-2 text-sm">
                <button
                  onClick={goQuiet}
                  className="rounded-full border border-[var(--ink-4)] px-4 py-1.5 text-[var(--ink)] transition-colors hover:border-[var(--ink-3)]"
                >
                  go quiet for a month
                </button>
                <button
                  onClick={stayOn}
                  className="rounded-full border border-[var(--line)] px-4 py-1.5 text-[var(--ink-3)] transition-colors hover:border-[var(--ink-4)]"
                >
                  stay as you are
                </button>
              </div>
            </div>
          )}
            </>
        )}
      </div>
      <TabBar inert={Boolean(session) && expanded} tab={tab} onTab={(t) => { noteActivityRef.current?.(); if (t === "rest") setRestVisit((n) => n + 1); setTab(t); }} />
      {player}
    </main>
  );
}
