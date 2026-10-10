import { useState, useEffect, type ReactNode } from "react";
import type { Episode } from "../lib/engine";
import { formatTime } from "../lib/engine";
import { loadLive, clearLive, clearLastNight, loadLastNight, type LiveSession, type LastNight, type ResumeDescriptor, resumeFrom, nightTimerMinutes, loadState, isRevivable, resumeMode, loadBlocked } from "../lib/store";
import type { PlayMode } from "../lib/engine";
import type { NoiseSettings } from "../lib/store";
import { reanchorNext } from "../lib/rest/reanchor";
import { importWatch, MAX_PAYLOAD_CHARS, watchNotice, watchPayloadFromHash } from "../lib/rest/watch";
import { WATCH_PENDING_KEY, WATCH_HASH } from "../lib/rest/watch-hash";
import { DEFAULT_FEEL_MINUTES } from "../lib/timer-feel";
import { SleepSetup } from "./SleepSetup";
import { Player } from "./Player";
import { YouTubeNight } from "./YouTubeNight";
import { Night } from "./Night";
import { isYouTubeLineup, isMixedLineup } from "../lib/youtube-night";
import { RestView } from "./RestView";
import { WatchLine } from "./WatchLine";
import { reconcileLive, resumeTarget, settleStoredLive } from "../lib/rest/reconcile";
import { ReanchorView } from "./ReanchorView";
import { shouldGreetGoodbye, markGoodbyeSeen } from "../lib/rest/surface";
import { fmtOnsetMinutes } from "../lib/rest/sleepscore";
import { loadNights, loadQuietUntil, saveQuietUntil, loadStepBackAsked, markStepBackAsked } from "../lib/rest/ledger";
import { qualifiesForStepBack, isQuiet, quietUntilFrom } from "../lib/rest/stepback";
import { QUIET_LINK } from "./quiet-link";

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

/** A #watch= link's import, if the page loaded with one (the head script
 *  took it out of the address), and the line saying what it did. Run once
 *  per page load (an initializer called twice gets the first call's line),
 *  as it writes to storage: the module lives as long as the page, and the
 *  site has no client-side routing, so a page load is a mount. */
let watchLinkLine: string | null | undefined; // undefined: not yet run
function takeWatchLink(): string | null {
  if (watchLinkLine !== undefined) return watchLinkLine;
  const payload = watchPayloadFromHash(takeHeldHash() ?? "");
  watchLinkLine = payload === null ? null : watchNotice(importWatch(payload));
  return watchLinkLine;
}

declare global {
  interface Window {
    /** A #watch= fragment, moved out of the address by PlayerLayout's head
     *  script before analytics could read it. */
    __sleepcastWatch?: string | null;
  }
}

/** The #watch= fragment the head script took, once. */
function takeHeldHash(): string | null {
  const h = window.__sleepcastWatch ?? null;
  window.__sleepcastWatch = null;
  return h;
}

/** Hands a held link on to the next page load, through session storage
 *  (the head script reads it), never back through the address. Whether it
 *  could (blocked storage can't). */
function handOn(held: string): boolean {
  try {
    sessionStorage.setItem(WATCH_PENDING_KEY, held);
    return true;
  } catch {
    return false;
  }
}

/** Reads a held link: hands it on and reloads, so it is read as on any page
 *  load. If it can't be handed on (session storage blocked), false: no
 *  reload, which would lose it unread. */
function readHeldLink(held: string): boolean {
  if (!handOn(held)) return false;
  window.location.reload();
  return true;
}

const HELD_LINK_STUCK = "this browser wouldn't keep your watch's night across a reload: close this tab and run the shortcut again.";

/** One quiet line above setup (the goodbye, the watch's result). */
function HomeLine({ mark, markClass = "", children }: { mark: string; markClass?: string; children: ReactNode }) {
  return (
    <div className="mb-6 flex items-center justify-center gap-2 text-center text-xs text-[#6e5d44]">
      <span className={`${markClass} text-sm text-[#8a7a5c]`.trim()}>{mark}</span>
      <span>{children}</span>
    </div>
  );
}

// The player (the page at /): the setup screen until a night begins, then the
// immersive player. A night in progress is snapshotted to localStorage
// (store.saveLive), so a full reload — including iOS reclaiming the
// backgrounded tab — can offer to resume it rather than waking you to
// silence.
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
  // Opt-in: the night's shuffle leans by what has put the listener under.
  const [favorWhatWorks, setFavorWhatWorks] = useState(false);
  // Read at start, not at mount: settings changed on the setup screen must
  // apply to the night about to begin.
  const [mode, setMode] = useState<PlayMode>({ kind: "minutes", minutes: 45 });
  const [feedTrim, setFeedTrim] = useState<Record<string, number>>({});
  const [noise, setNoise] = useState<NoiseSettings>({ on: false, level: 0.15 });
  const [leveling, setLeveling] = useState(false);

  // An Apple Watch import (sleepcast.pro/#watch=..., from the iOS Shortcut;
  // rest/watch.ts). Read before the goodbye below, so last night's line
  // shows the watch's time. A night whose tab was killed is only in the
  // ledger once its snapshot is recorded, and that is the night the morning
  // Shortcut most needs to time, so the import records it (killedNightToRecord;
  // the `live` state below then finds no snapshot). The fragment is cleared
  // at once: a reload, or the link shared, mustn't import it again.
  // The morning's line is about the night before: gone once a night starts
  // or is resumed (handleStart, handleResume).
  const [watchLine, setWatchLine] = useState(takeWatchLink);
  // The link can also land in a tab already open, where only the fragment
  // changes. It is held (heldLink: not in the address, where a reload
  // mid-night would import it and end the night; lost if the page goes
  // first, which the next morning's two-day run makes up) and offered on
  // the home screen and above a 3am re-anchor, read by a reload when the
  // listener taps it: everything here (the resume card, setup's label offer,
  // the goodbye) was worked out from the ledger before the import, and a
  // reload by itself could end a night still on (a tab frozen mid-night) or
  // lose what was being typed.
  const [heldLink, setHeldLink] = useState<string | null>(null);
  useEffect(() => {
    // The head script has already moved it out of the address (analytics).
    const onLink = () => {
      const hash = takeHeldHash();
      if (hash === null) return;
      setHeldLink(hash);
    };
    window.addEventListener("sleepcast-watch", onLink);
    onLink(); // one that landed between the first render and this effect
    return () => window.removeEventListener("sleepcast-watch", onLink);
  }, []);

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
  // time is left and it is recent; otherwise the tab was killed and the night
  // is over, so record it (rest/reconcile.ts) rather than dropping it.
  const [live, setLive] = useState<LiveSession | null>(() => settleStoredLive(Date.now()));

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
      // (A night a watch import closed has its last night "ended", which no
      // re-anchor continues: killedNightToRecord.)
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
  // no per-feed trim (a turned-down feed came back at full volume), no noise,
  // no leveling, no quarter-hour rule, and a 45-minute timed mode.
  function applyNightSettings(nightMode: PlayMode) {
    const settings = loadState().settings;
    setQuarterHourRule(settings.quarterHourRule);
    setMode(nightMode);
    setFeedTrim(settings.feedTrim);
    setNoise(settings.noise);
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
    // Gone either way: a night turned down or replaced mustn't be offered
    // again, even if storage was too full to record it.
    if (stored && !reconcileLive(stored, Date.now())) clearLive();
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
    setResume(null); // a fresh night, not a revival
    // A held link predates this new night (one that lands during a night is
    // kept for when it ends; resuming a night keeps one too).
    setHeldLink(null);
    setWatchLine(null);
    recordStoredNight(true);
    applyNightSettings(modeOverride ?? loadState().settings.mode);
    setSession({ pool, timerMinutes, skipIntroByFeedId, feedTitles, artworkByFeedId, leadEpisode, wasVaried, leadPosition });
  }

  // Revive the snapshotted night. The tap is also the autoplay gesture a
  // reload needs before audio can start again.
  function handleResume() {
    if (!live) return;
    // The card may be stale (resumeTarget): revive what is stored now, or
    // show what storage holds now.
    const t = resumeTarget(live, Date.now());
    if (!("revive" in t)) {
      setLive(t.card);
      return;
    }
    const target = t.revive;
    setWatchLine(null);
    applyNightSettings(resumeMode(target)); // (the lean comes with the snapshot)
    setResume(resumeFrom(target));
    setSession({
      pool: target.pool,
      timerMinutes: nightTimerMinutes(target),
      wasVaried: target.wasVaried,
      skipIntroByFeedId: target.skipIntroByFeedId,
      feedTitles: target.feedTitles,
      artworkByFeedId: target.artworkByFeedId,
    });
    setLive(null);
  }

  function handleEnd() {
    setResume(null);
    setSession(null);
    // A re-anchor found while the night played is stale now: this night
    // wrote its own last night (the next visibility check decides afresh).
    setReanchor(null);
    // A snapshot the night kept (the app gave up on a revived night) comes
    // back as the resume card, or is recorded if too old to revive.
    setLive(settleStoredLive(Date.now()));
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
    // A lineup of videos goes to the embed, everything else to the audio
    // element. Decided on the lineup rather than on a flag because a revived
    // night arrives from localStorage with no flag to read — the episodes
    // themselves are the only thing that survives a reload.
    //
    // Mixed goes to the new orchestrator; the two single-kind paths keep their
    // existing components untouched. That split is the whole risk posture —
    // Player.tsx works, has no tests, and is what gets slept to.
    if (isMixedLineup(session.pool)) {
      return (
        <Night
          pool={session.pool}
          timerMinutes={session.timerMinutes}
          skipIntroByFeedId={session.skipIntroByFeedId}
          feedTitles={session.feedTitles}
          artworkByFeedId={session.artworkByFeedId}
          onEnd={handleEnd}
          resume={resume}
          leadEpisode={session.leadEpisode}
          leadPosition={session.leadPosition ?? 0}
          mode={mode}
          feedTrim={feedTrim}
          noise={noise}
          wasVaried={session.wasVaried ?? false}
          favorWhatWorks={favorWhatWorks}
        />
      );
    }
    if (isYouTubeLineup(session.pool)) {
      return (
        <YouTubeNight
          pool={session.pool}
          timerMinutes={session.timerMinutes}
          skipIntroByFeedId={session.skipIntroByFeedId}
          feedTitles={session.feedTitles}
          artworkByFeedId={session.artworkByFeedId}
          onEnd={handleEnd}
          resume={resume}
          leadEpisode={session.leadEpisode}
          leadPosition={session.leadPosition ?? 0}
          mode={mode}
          feedTrim={feedTrim}
          noise={noise}
          wasVaried={session.wasVaried ?? false}
          favorWhatWorks={favorWhatWorks}
        />
      );
    }
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
        mode={mode}
        feedTrim={feedTrim}
        noise={noise}
        leveling={leveling}
        wasVaried={session.wasVaried ?? false}
        favorWhatWorks={favorWhatWorks}
      />
    );
  }

  // The watch's line and a held link's offer: on the home screen, and above
  // a 3am re-anchor (not during a night, nor in the rest view).
  const watchNote =
    heldLink !== null || watchLine ? (
      <>
        {heldLink !== null && (
          <HomeLine mark="⌚︎">
            <button
              onClick={() => {
                // Too long to read: said as any import says it, not handed on.
                if (heldLink.length > MAX_PAYLOAD_CHARS + WATCH_HASH.length) {
                  setHeldLink(null);
                  setWatchLine(watchNotice(importWatch(watchPayloadFromHash(heldLink) ?? "")));
                } else if (!readHeldLink(heldLink)) {
                  setHeldLink(null);
                  setWatchLine(HELD_LINK_STUCK);
                }
              }}
              className={QUIET_LINK}
            >
              your watch's night came in: read it
            </button>
          </HomeLine>
        )}
        {watchLine && (
          <HomeLine mark="⌚︎">
            <WatchLine text={watchLine} />
          </HomeLine>
        )}
      </>
    ) : null;

  if (reanchor) {
    return (
      <ReanchorView
        next={reanchor.next}
        onKeepDrifting={handleKeepDrifting}
        onDismiss={handleReanchorDismiss}
        note={watchNote}
      />
    );
  }

  // A paste's reload doesn't hand a held link on: it is older than the
  // paste, and imported after it would undo the paste's times.
  if (view === "rest") return <RestView onClose={(changed) => (changed ? window.location.reload() : setView("player"))} />;
  return (
    <main className="flex-1 px-4 py-8 text-[#b59a76]">
      <div className="mx-auto max-w-xl">
        {live && (
          <div className="mb-6 rounded-xl border border-[#3a3325] bg-[#171310] p-4">
            <p className="text-center text-[0.7rem] uppercase tracking-widest text-[#6e5d44]">still playing from before</p>
            <p className="mt-1.5 truncate text-center text-sm text-[#d9c9a8]">{live.current.title}</p>
            <p className="mt-0.5 text-center text-xs text-[#8a7a5c]">
              {formatTime(live.position)} in · {live.modeKind === "all-night" ? "playing all night" : live.modeKind === "one-episode" ? "to the end of this one" : `${Math.round(live.remainingMs / 60_000)} min left on the timer`}
            </p>
            <button
              onClick={handleResume}
              className="mt-3 w-full rounded-lg border border-[#6e5d44] bg-[#1a1b26] py-2.5 text-sm font-medium text-[#f0dcb8] transition-transform hover:border-[#8a7a5c] active:scale-95"
            >
              ▶ keep going
            </button>
            <button
              onClick={() => recordStoredNight(false)}
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
        {watchNote}
        {goodbye && (
          <HomeLine mark="☾" markClass="player-moon">
            you slept{goodbye.timeToSleepMs !== null ? ` — gone in ${fmtOnsetMinutes(goodbye.timeToSleepMs)}` : ""}.
          </HomeLine>
        )}
        <SleepSetup onStart={handleStart} />
        <button onClick={() => setView("rest")} className="mt-8 block w-full text-center text-xs text-[#4a4540] underline decoration-[#2a2620] underline-offset-4 hover:text-[#8a7a5c]">
          your rest
        </button>
      </div>
    </main>
  );
}
