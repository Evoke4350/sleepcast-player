import { useEffect, useRef, useState } from "react";
import { useLazyRef } from "../lib/use-lazy-ref";
import { useNightShuffle } from "../lib/use-night-shuffle";
import { useStateRef } from "../lib/use-state-ref";
import { useNightExtensions } from "../lib/use-night-extensions";

import type { Episode, PlayMode } from "../lib/engine";
import { formatTime, feedVolume, secondsToEnd } from "../lib/engine";
import { getPlays, recordHeardPlay, saveLive, noteSounded, SNAPSHOT_EVERY_TICKS, counterAfterStartSnapshot, rememberPosition, forgetPosition, blockEpisode } from "../lib/store";
import { NetworkHold, isOffline } from "../lib/network-hold";
import { SeekEnforcer, type SeekHooks } from "../lib/seek-enforcer";
import { mediaTransport } from "../lib/media/transport";
import { barPosition, DurationLatch, remainingOf, shortOfEnd, spanOf } from "../lib/duration";
import { heardDelta } from "../lib/heard";
import { rearmsWatchdogOnTap } from "../lib/witness";
import { clearLockScreen, mediaSession, publishLockScreen, publishLockScreenMetadata, setActionHandlers } from "../lib/lock-screen";
import { decideSkip, skipMessage, stillAtStart } from "../lib/skip-intro";
import { pickNextEpisode, HEARD_SEC } from "../lib/plays";
import type { ResumeDescriptor } from "../lib/store";
import { shouldTick } from "../lib/tick-gate";
import { RestSession, revivedNightStart } from "../lib/rest/session";
import { recordNightEnd } from "../lib/night-end";
import type { RestNight } from "../lib/rest/types";
import { MAX_FAILS } from "../lib/episode-end";
import { OfflineAudio } from "../lib/offline-audio";

// The night's last minute: reaching it untouched is the sleep detector's gate.
const END_WINDOW_SECONDS = 60;
// Just under a second, so a jittery 1s interval isn't swallowed by the gate it
// shares with the ~4Hz timeupdate stream.
const TICK_MIN_MS = 900;

// A pool this small is a curated lineup (varied night), not a whole archive:
// show it, so the night's spread is something you can see.
const LINEUP_MAX = 12;

export interface PlayerProps {
  pool: Episode[];
  timerMinutes: number;
  mode: PlayMode;
  /** feedId → 0.5..1.5 gain trim; absent means 1.0. */
  feedTrim: Record<string, number>;
  /** Save the episode playing and the next one on the device, so a dropped
   *  network doesn't stop the night (lib/offline-audio). */
  saveAhead?: boolean;
  skipIntroByFeedId: Record<string, number>;
  feedTitles: Record<string, string>;
  artworkByFeedId: Record<string, string>;
  onEnd: () => void;
  // Present when reviving a night after a reload: start from this episode at
  // this position with this much time left, instead of a fresh spin + timer.
  resume?: ResumeDescriptor | null;
  // "the exact one again": lead a fresh night with this episode (the same show
  // the returning listener drifted off to), then shuffle on as usual.
  leadEpisode?: Episode | null;
  // Where to resume the lead episode, when the listener chose "from where you
  // drifted". 0 means start at the top (skip-intro still applies).
  leadPosition?: number;
  wasVaried?: boolean;
  /** Opt-in: the shuffle leans by feed (rest/sleepscore shuffleWeights).
   *  Read once, at the night's start (useNightShuffle); a later change does
   *  nothing to this night. */
  favorWhatWorks?: boolean;
  /** Now Playing full screen, or the mini bar above the tabs. */
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  /** Set to end this night ("ended"), for a night started elsewhere (a
   *  show's episode tapped while this one plays). */
  endRef?: { current: (() => void) | null };
  /** Set to report the listener's activity outside the player (browsing the
   *  tabs) to this night's rest session: awake, not quiet. */
  activityRef?: { current: (() => void) | null };
}

/** How long a publish the platform rejected stands before the same one is
 *  tried again (a rejection that lasts shouldn't be retried every tick). */
const LOCK_RETRY_MS = 10_000;
/** Element events after which the lock screen is re-synced: play state
 *  (play, pause, playing, waiting), position (seeked), length
 *  (loadedmetadata, durationchange), rate (ratechange: the platform
 *  extrapolates at it) and a new load (loadstart, which clears
 *  the last episode's scrubber until the new length is known). */
const LOCK_SYNC_EVENTS = ["play", "pause", "playing", "waiting", "seeked", "loadedmetadata", "durationchange", "ratechange", "loadstart"] as const;

function PlayIcon({ big = false }: { big?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="currentColor" className={big ? "h-7 w-7" : "h-4 w-4"} aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>;
}
function PauseIcon({ big = false }: { big?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="currentColor" className={big ? "h-7 w-7" : "h-4 w-4"} aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>;
}
/** The playing show's artwork, or a quiet square while there is none. */
function NowArt({ src, big = false, small = false }: { src?: string; big?: boolean; small?: boolean }) {
  const [broken, setBroken] = useState(false);
  const cls = big ? "aspect-square w-full rounded-[18px] shadow-[0_16px_48px_rgba(0,0,0,0.35)]" : small ? "aspect-square w-10 rounded-md" : "aspect-square w-11 rounded-lg";
  return src && !broken
    ? <img src={src} alt="" onError={() => setBroken(true)} className={`${cls} bg-[var(--raised)] object-cover`} />
    : <div aria-hidden="true" className={`${cls} grid place-items-center bg-[var(--raised)] text-[var(--accent)]`}><span className={big ? "text-6xl" : "text-lg"}>☾</span></div>;
}

export function Player({ pool, timerMinutes, mode, feedTrim, saveAhead = true, skipIntroByFeedId, feedTitles, artworkByFeedId, onEnd, resume = null, leadEpisode = null, leadPosition = 0, wasVaried = false, favorWhatWorks = false, expanded, onExpand, onCollapse, endRef, activityRef }: PlayerProps) {
  const shuffle = useNightShuffle(favorWhatWorks, pool, resume);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const endTimeRef = useRef<number | null>(null);
  const pausedRemainingMsRef = useRef<number | null>(null);
  const tickHandleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTickRef = useRef(0);
  const poolRef = useRef(pool);
  const skipIntroRef = useRef(skipIntroByFeedId);
  const feedTitlesRef = useRef(feedTitles);
  const artworkRef = useRef(artworkByFeedId);
  const onEndRef = useRef(onEnd);
  /** The seek the current load is enforcing (see landAt), if any. */
  const pendingSeekRef = useRef<SeekEnforcer | null>(null);
  /** The episode's skip-intro, in seconds, until it is decided (checkSkip). */
  const skipRef = useRef<number | null>(null);
  /** The skip's own seek once armed, with the skip it is for, so a reload
   *  before it lands can re-arm it with its announcement. */
  const skipSeekRef = useRef<{ seek: SeekEnforcer; skipSec: number } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Watchdog: a track that hasn't reached "playing" within the window is
  // stuck (silent play() rejection, stalled load, dead enclosure URL) —
  // skip it instead of sitting in silence. Bounded so a fully-broken pool
  // can't spin forever.
  const watchRef = useRef<{ src: string; at: number } | null>(null);
  /** Waiting out a dropped network (see holdForNetwork). */
  const netHoldRef = useLazyRef(() => new NetworkHold());
  /** Tonight's episodes saved on the device (see planAhead). */
  const offlineRef = useLazyRef(() => new OfflineAudio());
  /** The episode picked to follow this one, picked early so it can be
   *  saved before it is needed. playNext takes it while it is still a
   *  valid pick. */
  const plannedNextRef = useRef<Episode | null>(null);
  /** Where the episode is, as far as anyone can tell (see resumePosition),
   *  when no seek is pending: the element's own trustworthy reading (see
   *  notePosition), or the target a seek left behind when it ended without
   *  landing (kept short of the known end), or a load's start of 0. */
  const knownPosRef = useRef(0);
  /** The last publish to the lock screen: state, rate and span (the length,
   *  to skip a publish that would change nothing, and the position, null
   *  with no length), and when (to tell a correction from steady playback,
   *  which moves at the rate only while the state is "playing"). taken:
   *  whether the platform accepted it; a rejected one says only what was
   *  tried and when, for its retry (LOCK_RETRY_MS). Null when nothing is
   *  published. */
  const publishedRef = useRef<{
    state: "playing" | "paused";
    rate: number;
    span: { pos: number; dur: number } | null;
    atMs: number;
    taken: boolean;
  } | null>(null);
  /** The current episode's duration once its element has reported one: kept
   *  across a reload (whose element knows nothing yet), reset per episode. */
  const durationLatchRef = useLazyRef(() => new DurationLatch());
  const failsRef = useRef(0);
  // Whether anything has actually played in this page (see endSession and
  // recordNightEnd for what a night that never did records).
  const hasEverPlayedRef = useRef(false);
  // Whether the CURRENT episode has reached "playing". Until it has, its
  // element reads 0 (src just set, the resume seek waits for metadata), so
  // resume points and periodic snapshots wait for it; a snapshot taken
  // meanwhile records the load's start (resumePosition), not that 0.
  const epPlayedRef = useRef(false);
  const restRef = useRef<RestSession | null>(null);
  const lastRestTickRef = useRef(0);
  // The full episode now playing (nowPlaying state omits the url we need to
  // revive it), the live timer total, and a throttle so we snapshot the night
  // to storage every ~10s rather than every tick.
  const currentEpRef = useRef<Episode | null>(null);
  /** The episode last tried as "the exact one again" (see noteSounded),
   *  so the save is tried once per episode, not on every sound. */
  const triedEpRef = useRef<Episode | null>(null);
  const persistCounterRef = useRef(0);
  // Play-ledger accounting for the episode currently playing (see heardTick).
  const heardSecRef = useRef(0); // real playback accumulated, seconds
  const lastPosRef = useRef(0); // previous audio.currentTime, to diff against
  const heardSavedAtRef = useRef(-1e9); // heardSec at the last ledger write
  const epStartedAtRef = useRef(0); // epoch ms this episode began
  const wasVariedRef = useRef(wasVaried);
  const modeRef = useRef(mode);
  const currentFeedRef = useRef<string | null>(null);
  const feedTrimRef = useRef<Record<string, number>>(feedTrim);

  const [nowPlaying, setNowPlaying] = useState<{ id: string; title: string; feedId: string } | null>(null);
  // The played set: state for the lineup, ref for same-tick snapshots, one
  // setter for both (the restore and each start).
  const [playedIds, playedIdsRef, setPlayed] = useStateRef<ReadonlySet<string>>(new Set());
  const [countdown, setCountdown] = useState(timerMinutes * 60);
  const [paused, setPaused] = useState(false);
  // The night's total length: state for the ring, ref for snapshots, one setter.
  const [totalSeconds, totalSecondsRef, setTotalSeconds] = useStateRef(timerMinutes * 60);
  const [epPos, setEpPos] = useState<{ cur: number; dur: number } | null>(null);
  const [toast, setToast] = useState("");
  const [holdPct, setHoldPct] = useState(0);
  // Stretches used this night (see useNightExtensions), kept across a revive.
  const { canExtendMore, extendTimer, extensionsRef } = useNightExtensions(resume?.extensions ?? 0, persistLive, {
    endTimeRef, pausedRemainingMsRef, totalSecondsRef, setTotalSeconds, restRef,
  }, (m) => showToast(m));
  const [blockedTonight, setBlockedTonight] = useState<ReadonlySet<string>>(new Set());
  const collapseBtnRef = useRef<HTMLButtonElement | null>(null);
  const openBtnRef = useRef<HTMLButtonElement | null>(null);
  // Focus follows the player: into Now Playing when it opens (the control
  // that opened it is now underneath), back to the mini bar when it closes.
  useEffect(() => {
    (expanded ? collapseBtnRef : openBtnRef).current?.focus();
  }, [expanded]);
  /** The latest askForSound(), for handlers registered once at mount. */
  const askForSoundRef = useRef<() => void>(() => {});
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep refs in sync
  useEffect(() => { poolRef.current = pool; }, [pool]);
  useEffect(() => { skipIntroRef.current = skipIntroByFeedId; }, [skipIntroByFeedId]);
  useEffect(() => { feedTitlesRef.current = feedTitles; }, [feedTitles]);
  useEffect(() => { artworkRef.current = artworkByFeedId; }, [artworkByFeedId]);
  useEffect(() => { onEndRef.current = onEnd; }, [onEnd]);
  useEffect(() => { wasVariedRef.current = wasVaried; }, [wasVaried]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { feedTrimRef.current = feedTrim; }, [feedTrim]);

  function playEpisode(ep: Episode, startAt = 0) {
    const audio = audioRef.current;
    if (!audio) return;

    setNowPlaying({ id: ep.id, title: ep.title, feedId: ep.feedId });
    setPlayed(new Set(playedIdsRef.current).add(ep.id));
    currentFeedRef.current = ep.feedId;
    // The rest session infers WHEN sleep began; only the player knows WHAT was
    // playing. Told here rather than reconstructed later, because the play
    // ledger de-duplicates by episode id and cannot answer this for any night
    // but the most recent.
    restRef.current?.noteEpisode(ep.feedId, ep.id);
    audio.src = offlineRef.current.sourceFor(ep);
    currentEpRef.current = ep;
    // A new episode: the last one's length means nothing now (before the
    // start seek below reads it).
    durationLatchRef.current.reset();
    epPlayedRef.current = false;
    netHoldRef.current.cancel(); // a new episode: any wait was for the last one

    const skipMin = skipIntroRef.current[ep.feedId] ?? 0;
    const skipSec = skipMin * 60;
    // Reviving a night: land where the sleeper left off; 0 just clears the
    // last episode's seek. The skip-intro waits for the duration (checkSkip),
    // and applies only near the start: a revive from a snapshot taken a
    // second in still gets it, one from mid-episode doesn't.
    startLoadAt(audio, startAt);
    // Only from a start near the beginning: a revive deep in is not the
    // skip's, whatever the element reads if its seek is dropped later.
    skipRef.current = stillAtStart(startAt, skipSec) ? skipSec : null;

    watchRef.current = { src: ep.url, at: Date.now() };
    playOrWait(audio);
    // An episode is no longer "heard" the instant it starts — heardTick records
    // it once HEARD_SEC of real playback has accumulated, so a track skipped
    // after three seconds stays in the pool.
    heardSecRef.current = 0;
    lastPosRef.current = 0;
    heardSavedAtRef.current = -1e9;
    epStartedAtRef.current = Date.now();

    publishLockScreenMetadata(ep.title, feedTitlesRef.current[ep.feedId], artworkRef.current[ep.feedId]);
    // And a snapshot now, at its start (see counterAfterStartSnapshot).
    persistCounterRef.current = counterAfterStartSnapshot(persistLive());
    planAhead();
  }

  /** Name what the night needs saved: the episode playing, and the next
   *  one once it is likely to play (its length known, and the timer, if
   *  there is one, outlasting it). Every tick; a no-op unless it changes. */
  function planAhead() {
    const ep = currentEpRef.current;
    const audio = audioRef.current;
    if (!saveAhead || !ep || !audio) return;
    const kind = modeRef.current.kind;
    let next: Episode | null = null;
    if (kind !== "one-episode") {
      const epLeft = remainingOf(episodeSpan(audio));
      const timerLeft = kind === "minutes" ? (pausedRemainingMsRef.current ?? (endTimeRef.current ?? 0) - Date.now()) / 1000 : Infinity;
      if (epLeft !== null && timerLeft > epLeft) {
        const choices = nextChoices();
        const planned = plannedNextRef.current;
        next = planned && choices?.some((e) => e.id === planned.id) ? planned : choices ? pickFrom(choices) : null;
        plannedNextRef.current = next;
      }
    }
    offlineRef.current.keep(next ? [ep, next] : [ep]);
  }

  /** The night has lost the network while this episode streams: play the
   *  saved copy from where it is, if there is one. Returns whether it did. */
  function switchToSaved(ep: Episode): boolean {
    const audio = audioRef.current;
    if (!audio || !offlineRef.current.has(ep)) return false;
    if (audio.getAttribute("src") === offlineRef.current.sourceFor(ep)) return false;
    notePosition(audio);
    return reloadCurrent(ep);
  }

  /** Count one more consecutive failure (a stuck track, a source error). Past
   *  MAX_FAILS the whole pool looks broken and the night ends; returns whether
   *  it did. It used to pause instead, which froze the night for good (the
   *  clock stops on pause): it never ended or recorded. Ended as an app
   *  give-up, so a restored night whose sources all fail keeps its snapshot
   *  (offline failures don't get here: see holdForNetwork). */
  function countFailure(): boolean {
    failsRef.current++;
    if (failsRef.current <= MAX_FAILS) return false;
    endSession("ended", { gaveUp: true });
    return true;
  }

  /** Offline: hold the night instead of spending the pool on a dropped
   *  network (see NetworkHold). Clock frozen and shown paused, every time,
   *  even when already holding. When the network is back, or on a tap, the
   *  same episode reloads where it was, or where its load was meant to start
   *  if it never played. */
  function holdForNetwork() {
    const audio = audioRef.current;
    const ep = currentEpRef.current;
    if (!audio || !ep) return;
    // Saved on the device: no need to wait for anything.
    if (!audio.paused && switchToSaved(ep)) return;
    // Read before pausing: paused already means by the listener (a paused
    // element's buffering can fail too; see NetworkHold).
    const paused = audio.paused;
    watchRef.current = null;
    freezeClock();
    audio.pause();
    setPaused(true);
    netHoldRef.current.hold(
      () => {
        // Not into a night that has ended or moved on.
        if (tickHandleRef.current === null) return false;
        if (currentEpRef.current !== ep) return false;
        // Where it is at resume: the pending seek's target (the skip may have
        // been decided during the hold), or the last trustworthy position,
        // which includes a scrub made during the hold.
        return reloadCurrent(ep);
      },
      paused,
    );
  }

  /** Where a new load (a new episode, or a reload) starts: enforced at
   *  `at`, or no seek at all at 0. `skipSec`: the load is the skip's seek
   *  being reloaded, which keeps its announcement. */
  function startLoadAt(audio: HTMLAudioElement, at: number, skipSec?: number) {
    skipSeekRef.current = null;
    knownPosRef.current = Math.max(0, at); // this load's, not the last one's
    if (at <= 0) {
      // No seek: tear down the last one (a leftover would force-seek this
      // load to its spot).
      pendingSeekRef.current?.cancel();
      return;
    }
    if (skipSec !== undefined) armSkip(skipSec, (hooks) => landAt(audio, at, hooks));
    else landAt(audio, at);
  }

  /** Enforce landing at `at` (see SeekEnforcer), replacing any seek
   *  pending. While it is pending, resumePosition reads its target; after,
   *  the element's position if it landed, else the target it leaves behind. */
  function landAt(audio: HTMLAudioElement, at: number, hooks: SeekHooks = {}, { deferSeek = false }: { deferSeek?: boolean } = {}): SeekEnforcer {
    pendingSeekRef.current?.cancel();
    const seek = new SeekEnforcer(audio, at, hooks, (end) => {
      if (skipSeekRef.current?.seek === seek) skipSeekRef.current = null;
      if (pendingSeekRef.current !== seek) return;
      pendingSeekRef.current = null;
      // heardTick's baseline: where it ended up, so the landing's own step
      // (up to the enforcer's slack past the target) isn't counted as heard.
      lastPosRef.current = audio.seeking ? NaN : audio.currentTime;
      // Cancelled: whoever cancelled sets the position and the lock screen.
      if (end === "cancelled") return;
      // Only a position it ended on for real: one that gave up or stood down
      // may leave a stalled or failed element's reading behind (the app's
      // own pause in a hold ends a seek that way). A listener's seek before
      // playback is enforced here too, and so is recorded once it lands.
      // A target left behind by a seek that didn't land stands, as the
      // enforcer keeps it (never past the end as now known), until the
      // element's next trustworthy reading says where it really is.
      if (end !== "landed") knownPosRef.current = seek.at;
      // The position the lock screen runs from may have changed (a landing
      // takes a fresh reading first).
      if (end === "landed") refreshLockScreen(audio);
      else syncLockScreen();
    }, { deferSeek, duration: () => episodeDuration(audio) });
    pendingSeekRef.current = seek;
    return seek;
  }

  /** Take the element's own position as where the episode is, when it can
   *  be trusted: not while a seek is being enforced (Safari can read ~0
   *  until it is corrected), not before the element knows its media (a new
   *  load reads 0), and not from a failed element, which can read 0 too.
   *  Returns whether the reading counted. */
  function notePosition(audio: HTMLAudioElement): boolean {
    // Nor mid-seek: a fastSeek's currentTime can still read where it left.
    if (pendingSeekRef.current || audio.seeking) return false;
    if (audio.error || audio.readyState < HTMLMediaElement.HAVE_METADATA) return false;
    knownPosRef.current = audio.currentTime;
    return true;
  }

  /** Enforce a seek to `to`: by aiming the one still pending there (it keeps
   *  count of its own seeks in flight, so their late answers aren't
   *  misread), else with a new one. `move`: a drag step, which only moves
   *  the target (the next event seeks). */
  function aimAt(audio: HTMLAudioElement, to: number, hooks: SeekHooks = {}, { move = false }: { move?: boolean } = {}): SeekEnforcer {
    const pending = pendingSeekRef.current;
    if (pending && (move ? pending.moveTarget(to, hooks) : pending.retarget(to, hooks))) return pending;
    return landAt(audio, to, hooks, { deferSeek: move });
  }

  /** Seek past the intro once the duration is known, unless the episode is
   *  too short for it (then it plays whole) or has moved on from its start
   *  (see lib/skip-intro). Kept across a reload of the same episode. */
  function checkSkip(audio: HTMLAudioElement) {
    const skipSec = skipRef.current;
    if (skipSec === null || audio.readyState < HTMLMediaElement.HAVE_METADATA) return;
    // Where the episode is, not the raw reading: after a reload the element
    // reads 0 until the reload's own seek lands. Fresh: a durationchange on
    // a locked phone can come long after the last (throttled) timeupdate.
    // The episode's length as known (through a reload's NaN), else what the
    // element says (Infinity for a stream, which counts as long).
    const decision = decideSkip(skipSec, episodeDuration(audio) ?? audio.duration, freshPosition(audio));
    if (decision === "wait") return;
    skipRef.current = null;
    if (decision !== "skip") return;
    armSkip(skipSec, (hooks) => aimAt(audio, skipSec, hooks));
  }

  /** The skip's seek, the one way it is armed (first, and again on a
   *  reload): made with its announcement, and remembered with its skipSec. */
  function armSkip(skipSec: number, seekWith: (hooks: SeekHooks) => SeekEnforcer) {
    const seek = seekWith({ onLanded: () => showToast(skipMessage(skipSec)) });
    skipSeekRef.current = { seek, skipSec };
  }

  /** One toast at a time: a new one replaces the last, timer and all. */
  function showToast(message: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(""), 4200);
  }

  /** play(), and if autoplay is refused (a track change or a reload while the
   *  screen is locked), show paused with the clock frozen: retrying won't
   *  help, and one tap on Resume restores the night. Anything else (a bad
   *  source, an abort) is left to the error event or the watchdog. */
  function playOrWait(audio: HTMLAudioElement) {
    audio.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        watchRef.current = null;
        // The pause EVENT does not fire here, so without this the timer keeps
        // counting through silence, and an untouched timer is recorded as a
        // night they slept through when nothing ever played.
        freezeClock();
        setPaused(true);
        syncLockScreen(); // no "pause" event either
      }
    });
  }

  /** Reload the current episode's source at resumePosition(): a pending
   *  seek's target (the skip's, re-armed with its announcement), else the
   *  last trustworthy position. Not playEpisode: this is the same listening
   *  resumed, so the play ledger and the rest timeline are left alone.
   *  Returns whether it reloaded. */
  function reloadCurrent(ep: Episode): boolean {
    const audio = audioRef.current;
    if (!audio) return false;
    // The reload reads 0 until its seek lands: until it plays again, no
    // resume point or periodic snapshot (see epPlayedRef).
    epPlayedRef.current = false;
    const at = resumePosition();
    audio.src = offlineRef.current.sourceFor(ep);
    // A fresh enforcer (the old one's state belongs to the load that failed),
    // with the skip's announcement if it is the skip's seek being reloaded:
    // skipSeekRef is set only while that seek is the pending one.
    const skip = skipSeekRef.current;
    startLoadAt(audio, at, skip?.skipSec);
    lastPosRef.current = at; // the new load's baseline, for a reload at 0 too
    watchRef.current = { src: ep.url, at: Date.now() };
    playOrWait(audio);
    return true;
  }

  /** Where this episode is, for a reload or a snapshot: the target of a
   *  seek still being enforced (Safari can read ~0 after "playing" until it
   *  is corrected), else the last position the element itself reported
   *  (see notePosition): a failed element may read 0, and a load that has
   *  not reported yet is where it was meant to start. */
  function resumePosition(): number {
    return pendingSeekRef.current?.at ?? knownPosRef.current;
  }

  /** resumePosition() after a fresh reading (notePosition records only
   *  trustworthy ones), for a caller with no element event behind it. */
  function freshPosition(audio: HTMLAudioElement): number {
    notePosition(audio);
    return resumePosition();
  }

  /** A request for sound: the toggle's play half and the media session's.
   *  Read through askForSoundRef by handlers registered at mount. */
  function askForSound() {
    const audio = audioRef.current;
    if (!audio) return;
    // Held for the network: this retries the reload (see NetworkHold).
    if (netHoldRef.current.resumeNow(true)) return;
    // An episode that hasn't played yet gets its watchdog back (a pause of a
    // loading or stalled element, the lock screen's stop, stood it down), by
    // the tap rule every player uses.
    const src = audio.getAttribute("src");
    if (src && rearmsWatchdogOnTap(epPlayedRef.current, mediaTransport(audio))) watchRef.current = { src, at: Date.now() };
    // A refused play stands the watchdog down again (see playOrWait).
    playOrWait(audio);
  }

  /** Park the remaining time, so the countdown holds while nothing plays.
   *  Only if not already parked: re-parking from a stale end time would
   *  lose the minutes frozen so far. onPlay thaws it. */
  function freezeClock() {
    if (endTimeRef.current !== null && pausedRemainingMsRef.current === null) {
      pausedRemainingMsRef.current = endTimeRef.current - Date.now();
    }
  }

  /** What the next episode can be, or null when nothing can play. */
  function nextChoices(): Episode[] | null {
    // Exclude what is playing now. The ledger only records an episode after
    // HEARD_SEC, so on a fresh varied mix every episode is still a candidate
    // and Next had a real chance of restarting the same story from 0:00.
    const available = poolRef.current;
    const current = currentEpRef.current;
    const choices = current
      ? available.filter((e) => e.id !== current.id)
      : available;
    return choices.length ? choices : available.length ? available : null;
  }

  function pickFrom(choices: Episode[]): Episode | null {
    return pickNextEpisode(choices, getPlays(), Math.random, shuffle.weightOf);
  }

  function playNext() {
    const choices = nextChoices();
    // The one picked ahead (and maybe saved), while it is still a valid pick:
    // not blocked since, nor the one playing.
    const planned = plannedNextRef.current;
    plannedNextRef.current = null;
    const ep = !choices ? null : planned && choices.some((e) => e.id === planned.id) ? planned : pickFrom(choices);
    // Nothing left (the last episode was just blocked, or past the one-way
    // door no feed is playable): end rather than keep playing the one the
    // listener said "never again" to, or fake-play silence. Not a give-up:
    // attachment only happens after something has played.
    if (ep) playEpisode(ep);
    else endSession("ended");
  }

  // Accumulate real playback for the current episode and write it to the play
  // ledger. Driven by "timeupdate" (~4Hz) rather than the 1s interval, because
  // that keeps firing while the phone is locked — the dominant sleep case.
  //
  // What counts as listening is lib/heard's heardDelta.
  function heardTick() {
    const audio = audioRef.current;
    const ep = currentEpRef.current;
    if (!audio || !ep) return;

    const t = audio.currentTime;
    const prev = lastPosRef.current;
    // Mid-seek the reading can still be the spot the seek left: keep no
    // baseline until it lands, so the landing's step isn't counted.
    lastPosRef.current = audio.seeking ? NaN : t;
    // Not while a seek is being enforced: its jumps and its landing aren't
    // listening (landAt resets the baseline when it ends).
    heardSecRef.current += heardDelta(prev, t, pendingSeekRef.current !== null || audio.seeking);
    // Not playback's steady advance (which the lock screen extrapolates),
    // but a correction: the position somewhere other than where the lock
    // screen thinks it is (a seek that didn't land, say), or a play state
    // that has changed without an event. Only on a reading that counted.
    // (syncLockScreen publishes only what changed: the state, length, rate,
    // or a position off its extrapolation.)
    if (notePosition(audio)) syncLockScreen();

    // Save on crossing the threshold, then refresh roughly every minute so the
    // ledger reflects how long a long episode actually ran. recordHeardPlay
    // replaces by episode id, so these are updates, not duplicates.
    if (
      heardSecRef.current >= HEARD_SEC &&
      heardSecRef.current - heardSavedAtRef.current >= 60
    ) {
      heardSavedAtRef.current = heardSecRef.current;
      recordHeardPlay({
        id: ep.id,
        title: ep.title,
        feedId: ep.feedId,
        startedAt: epStartedAtRef.current,
        heardSec: Math.round(heardSecRef.current),
      });
    }
  }

  // Snapshot the night so a reload can revive it. remainingMs (not an absolute
  // end) so a paused stretch is preserved; saveLive bounds the pool it stores.
  // Where the listener is in the *current* episode, kept beyond the life of
  // this night so "the exact one again" can offer to resume rather than
  // restarting a 90-minute story from the top.
  function rememberCurrentPosition() {
    const audio = audioRef.current;
    const ep = currentEpRef.current;
    if (!audio || !ep || !epPlayedRef.current) return; // see epPlayedRef
    rememberPosition(ep.id, resumePosition(), episodeDuration(audio) ?? NaN);
  }

  // "never again": drop this episode from tonight's pool, remember the choice,
  // and move on. The pool ref is mutated so the spread list and every later
  // pick in this session stop offering it without waiting for a remount.
  function handleBlock() {
    const ep = currentEpRef.current;
    if (!ep) return;
    blockEpisode(ep.id);
    restRef.current?.noteSkip(ep.feedId);
    forgetPosition(ep.id);
    poolRef.current = poolRef.current.filter((e) => e.id !== ep.id);
    // The spread renders the pool PROP, so it also has to be told — otherwise
    // the blocked title stays in tonight's list and tapping it plays it.
    setBlockedTonight((prev) => new Set(prev).add(ep.id));
    showToast("never again");
    restRef.current?.noteInteraction();
    playNext();
  }

  /** Snapshot the night; whether it wrote one. */
  function persistLive(): boolean {
    const audio = audioRef.current;
    const ep = currentEpRef.current;
    if (!audio || !ep || tickHandleRef.current === null) return false;
    // Timerless modes have no remaining time to restore; 0 records "revive the
    // night, there is no clock to resume".
    const remainingMs =
      endTimeRef.current === null
        ? 0
        : pausedRemainingMsRef.current ?? endTimeRef.current - Date.now();
    if (endTimeRef.current !== null && remainingMs <= 0) return false;
    // Only once something has played in this page: before that there is
    // nothing of its own to record, and a revived night's stored snapshot
    // (the one it was revived from) stays as it is, to be revived again.
    // The position is resumePosition() (the load's start, or its pending seek's target,
    // until a trustworthy reading), never a new load's 0.
    if (!hasEverPlayedRef.current) return false;
    return saveLive({
      savedAt: Date.now(),
      nightStartedAt: restRef.current?.startedAt,
      timerMinutes: restRef.current?.timerMinutes,
      modeKind: modeRef.current.kind,
      interactions: restRef.current?.interactionCount,
      extensions: extensionsRef.current,
      wasVaried: wasVariedRef.current,
      shuffleLean: shuffle.lean,
      remainingMs,
      totalSeconds: totalSecondsRef.current,
      position: resumePosition(),
      current: ep,
      playedIds: [...playedIdsRef.current],
      pool: poolRef.current,
      skipIntroByFeedId: skipIntroRef.current,
      feedTitles: feedTitlesRef.current,
      artworkByFeedId: artworkRef.current,
    });
  }

  // Feed the sleep detector at a wall-clock 15s cadence, driven by BOTH the 1s
  // interval (foreground) AND the audio's "timeupdate" event — which keeps
  // firing while the tab is backgrounded / the phone is locked (the dominant
  // sleep case, where setInterval is throttled and the last-minute tick would
  // otherwise never arrive). The lastRestTickRef guard dedupes the two sources.
  function restTick() {
    const r = restRef.current;
    if (!r || pausedRemainingMsRef.current !== null || tickHandleRef.current === null) return;
    // pausedRemainingMsRef is only set in minutes mode. In one-episode and
    // all-night a pause kept feeding quiet ticks, and with the episode near
    // its end (fadingOrDone) the detector could infer sleep during a pause.
    if (audioRef.current?.paused) return;
    if (Date.now() - lastRestTickRef.current < 15_000) return;
    lastRestTickRef.current = Date.now();
    // The detector's gate is an unattended end (the night's last minute), so
    // it has to watch whichever clock ends the night in this mode — the timer
    // in minutes mode, the episode in one-episode mode. Keyed to the timer
    // alone, the detector would never see an end in one-episode mode and
    // could never conclude.
    //
    // In all-night there is no end by design, so no night can be scored. That
    // is a consequence of the gated model (docs/gated-model.md), not an
    // oversight: precision comes from the end, and without one there is no
    // evidence that separates asleep from awake-and-resting.
    const audio = audioRef.current;
    const kind = modeRef.current.kind;
    const timerRemaining =
      kind === "minutes" && endTimeRef.current !== null
        ? (endTimeRef.current - Date.now()) / 1000
        : Infinity;
    const epRemaining = audio ? remainingOf(episodeSpan(audio)) : null;
    const toEnd = secondsToEnd(kind, timerRemaining, epRemaining);
    r.tick({
      now: Date.now(),
      hidden: typeof document !== "undefined" && document.hidden,
      fadingOrDone: toEnd <= END_WINDOW_SECONDS,
    });
  }

  // Every caller goes through here, never straight to tick().
  //
  // setInterval alone was not enough: browsers throttle background intervals
  // to about once a minute, and the phone is locked for nearly all of a sleep
  // timer, so the stop landed late, by up to a minute. "timeupdate" keeps
  // firing while backgrounded, which is why the sleep detector and the play
  // ledger were already driven from it; the stop was simply left behind.
  function tickGuarded() {
    const now = Date.now();
    const sessionActive = tickHandleRef.current !== null;
    if (!shouldTick({ lastRunAt: lastTickRef.current, now, minIntervalMs: TICK_MIN_MS, sessionActive })) return;
    lastTickRef.current = now;
    tick();
  }

  function tick() {
    const audio = audioRef.current;
    if (!audio) return;

    // In one-episode and all-night modes there is no timer to run down, so the
    // countdown is Infinity (one-episode ends with the episode; see onEnded).
    const kind = modeRef.current.kind;
    const remaining =
      kind === "minutes"
        ? (pausedRemainingMsRef.current ?? endTimeRef.current! - Date.now()) / 1000
        : Infinity;

    restTick();

    if (remaining <= 0) {
      endSession();
      return;
    }

    // Where the episode is and how long, as the rest of the player sees it
    // (not a reading Safari hasn't corrected yet, and not lost on a reload),
    // once per pass for the bar.
    const span = episodeSpan(audio);

    // The feed's trim, not a hard 1, so a turned-down feed stays down.
    audio.volume = feedVolume(feedTrimRef.current[currentFeedRef.current ?? ""] ?? 1.0);
    setCountdown(kind === "minutes" ? remaining : 0);
    setEpPos((prev) => barPosition(prev, span));

    planAhead();

    const w = watchRef.current;
    if (w && Date.now() - w.at > 25_000) {
      watchRef.current = null;
      if (isOffline()) holdForNetwork();
      else if (!countFailure()) playNext();
      // Everything below concerns the episode just replaced (or the night just
      // ended).
      return;
    }

    // Spent only once the episode has played, so a new episode's first
    // periodic snapshot lands as soon as it plays, not ten ticks after a
    // count used up while it was still loading.
    if (++persistCounterRef.current >= SNAPSHOT_EVERY_TICKS && epPlayedRef.current) {
      persistCounterRef.current = 0;
      persistLive();
      rememberCurrentPosition();
    }
  }

  /** `gaveUp`: the app, not the listener, is ending a night that never
   *  played, so its snapshot is kept (see NightEnd.gaveUp). */
  function endSession(reason: RestNight["endedVia"] = "faded", { gaveUp = false }: { gaveUp?: boolean } = {}) {
    // "faded" is the natural end — the timer ran out untouched. Stamp it so
    // the setup screen can offer a smaller re-arm to someone who wakes back
    // up inside the window. A manual stop is not an invitation to resume.
    //
    // A night that never played in this page records what recordNightEnd
    // decides: nothing for a fresh one (its snapshot cleared unless the app
    // gives up), or, for a revived one, the night it continues.
    netHoldRef.current.cancel();
    offlineRef.current.stop();
    plannedNextRef.current = null;
    pendingSeekRef.current?.cancel(); // nothing may act on the stopped element
    recordNightEnd({
      reason,
      played: hasEverPlayedRef.current,
      revivedFrom: resume?.savedAt,
      gaveUp,
      timerMinutes,
      modeKind: modeRef.current.kind,
      lastNight: {
        pool: poolRef.current,
        playedIds: [...playedIdsRef.current],
        feedTitles: feedTitlesRef.current,
        artworkByFeedId: artworkRef.current,
        skipIntroByFeedId: skipIntroRef.current,
        wasVaried: wasVariedRef.current,
      },
      rest: restRef.current,
      now: Date.now(),
    });
    restRef.current = null;
    watchRef.current = null;
    if (tickHandleRef.current !== null) {
      clearInterval(tickHandleRef.current);
      tickHandleRef.current = null;
    }
    endTimeRef.current = null;
    pausedRemainingMsRef.current = null;

    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      // Removing src alone keeps the resource, its buffer and connection;
      // load() with no src releases them.
      audio.load();
      audio.volume = 1;
    }

    // Cleared here: load() drops the stop's queued "pause" event, so neither
    // onPause nor the lock-screen listener runs for it.
    clearAllLockScreen();

    onEndRef.current();
  }

  // Start session on mount
  useEffect(() => {
    pausedRemainingMsRef.current = null;
    endTimeRef.current =
      mode.kind === "minutes"
        ? Date.now() + (resume ? resume.remainingMs : timerMinutes * 60 * 1000)
        : null; // timerless modes: the episode ends the night, not a clock
    // A revived night continues the one that began before the reload: its
    // time-to-sleep, timeline and snapshots count from the real start, not
    // from the tap on "keep going".
    const nightStart = revivedNightStart(resume?.nightStartedAt, Date.now());
    restRef.current = new RestSession(nightStart, timerMinutes, shuffle.lean !== undefined);
    restRef.current.seedInteractions(resume?.interactions ?? 0);
    if (resume) {
      setTotalSeconds(resume.totalSeconds);
      setCountdown(Math.max(0, resume.remainingMs / 1000));
      setPlayed(new Set(resume.playedIds)); // restore which of the spread you'd heard
    }

    const audio = audioRef.current!;

    // pause handler: freeze timer unless it's an episode-end transition
    const onPause = () => {
      setPaused(true);
      watchRef.current = null; // a paused track isn't a stuck track
      if (!audio.ended) freezeClock();
      // A fresh reading first (lockSync's comes after this handler): a
      // locked phone's throttled timeupdates can leave it seconds old.
      notePosition(audio);
      persistLive(); // capture the pause with its frozen remaining time
    };

    // play handler: recompute endTime from frozen remaining
    const onPlay = () => {
      setPaused(false);
      if (pausedRemainingMsRef.current !== null) {
        endTimeRef.current = Date.now() + pausedRemainingMsRef.current;
        pausedRemainingMsRef.current = null;
      }
    };

    const onEnded = () => {
      const done = currentEpRef.current;
      if (done) forgetPosition(done.id); // played out: nothing left to resume
      if (tickHandleRef.current === null) return;
      // One-episode mode means one episode: the night is over. Playing on
      // started the next episode and the night never ended.
      if (modeRef.current.kind === "one-episode") {
        endSession("faded");
        return;
      }
      playNext();
    };

    // Playback genuinely started: stand the watchdog down.
    const onPlaying = () => {
      watchRef.current = null;
      netHoldRef.current.cancel(); // the network is evidently fine
      failsRef.current = 0;
      hasEverPlayedRef.current = true;
      epPlayedRef.current = true;
      triedEpRef.current = noteSounded(triedEpRef.current, currentEpRef.current);
    };

    const onError = () => {
      // Offline, first: a network drop says nothing about this enclosure or
      // its feed's CORS headers, and must not condemn either.
      if (isOffline() && tickHandleRef.current !== null && audio.getAttribute("src")) {
        holdForNetwork();
        return;
      }
      // Saved on the device and still streaming: the saved copy, from where
      // it was, before anything else is concluded about this episode.
      const failed = currentEpRef.current;
      if (failed && tickHandleRef.current !== null && switchToSaved(failed)) return;
      if (tickHandleRef.current !== null && audio.getAttribute("src")) {
        // Counted like the watchdog's stuck tracks. Uncounted, a pool whose
        // sources all fail at once (network gone at 2am, every enclosure a
        // 404) switched tracks forever, since onPlaying never resets anything.
        if (!countFailure()) playNext();
      }
    };

    audio.addEventListener("pause", onPause);
    audio.addEventListener("play", onPlay);
    // heardTick first: it notes the position, which tick (the stop, the bar)
    // and restTick then read fresh.
    audio.addEventListener("timeupdate", heardTick); // accumulates real playback for the play ledger
    audio.addEventListener("timeupdate", tickGuarded); // the stop must survive a locked screen
    audio.addEventListener("timeupdate", restTick); // keeps the sleep detector fed while backgrounded
    // The skip-intro decides as soon as the duration is known.
    const onDuration = () => {
      const dur = episodeDuration(audio);
      // (A seek aimed before this was known is kept short of the end by
      // the enforcer itself.) A target left behind before the length was
      // known may lie past it.
      if (dur !== null && !pendingSeekRef.current) knownPosRef.current = shortOfEnd(knownPosRef.current, dur);
      checkSkip(audio);
    };
    audio.addEventListener("loadedmetadata", onDuration);
    audio.addEventListener("durationchange", onDuration);
    // The lock screen follows every element change of position or play state
    // from one listener set (registered after the other handlers set up at
    // mount, so it sees what they recorded; a seek enforcer's, added later,
    // runs after it, and every enforcer end syncs), not a call at each site.
    // A fresh reading first (notePosition's rules decide whether it counts):
    // with timeupdates throttled while locked, knownPosRef can be seconds old
    // when "playing", "waiting" or a new duration arrive.
    const lockSync = () => refreshLockScreen(audio);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    // The network gone while an episode saved in full still streams: move to
    // the saved copy now, while the buffer still plays, rather than waiting
    // for the stall or the error (which can take minutes) and a gap after.
    const onOffline = () => {
      const ep = currentEpRef.current;
      if (ep && tickHandleRef.current !== null && !audio.paused) switchToSaved(ep);
    };
    window.addEventListener("offline", onOffline);
    // Turned off: nothing saved stays.
    if (!saveAhead) offlineRef.current.keep([]);
    for (const ev of LOCK_SYNC_EVENTS) audio.addEventListener(ev, lockSync);

    const clearHandlers = setActionHandlers({
      play: () => {
        restRef.current?.noteInteraction();
        // The lock screen shows "paused" while loading or stalled, so its
        // play button is the only one offered then: on an element that is
        // in fact trying to play, the tap means stop.
        if (mediaTransport(audio) === "buffering") audio.pause();
        else askForSoundRef.current();
      },
      pause: () => { restRef.current?.noteInteraction(); audio.pause(); },
      // Routed through handleNext, not playNext directly: a lock-screen or
      // Bluetooth skip is still a rejection of the feed being left, and for
      // someone already in bed with the phone locked, this is most skips —
      // splitting the path here would mean the model never sees them.
      nexttrack: () => handleNext(),
      // Lock-screen / headphone scrubbing, with the platform's own step when
      // it gives one (a headset's 15 s).
      seekbackward: (d) => skipBy(-(d.seekOffset ?? 30)),
      seekforward: (d) => skipBy(d.seekOffset ?? 30),
      // The lock-screen scrubber: through listenerSeek like any listener
      // seek, not the browser's default, which would bypass it. Every step
      // marks the listener active and counts toward wakefulness; only the
      // night's record (RestSession.interactionCount) merges a drag's burst.
      seekto: (d) => {
        if (listenerSeek(d.seekTime ?? NaN, d.fastSeek === true)) restRef.current?.noteInteraction();
      },
    });

    if (resume) playEpisode(resume.episode, resume.position);
    else if (leadEpisode) playEpisode(leadEpisode, leadPosition); // "the exact one again"
    else playNext();
    tickHandleRef.current = setInterval(tickGuarded, 1000);
    tick(); // paint the first frame immediately; the gate would hold it back

    return () => {
      if (tickHandleRef.current !== null) clearInterval(tickHandleRef.current);
      netHoldRef.current.cancel();
      pendingSeekRef.current?.cancel();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      // A hold still counting at unmount would call endSession on a player
      // that is gone, and through onEnd end whatever night came next.
      if (holdTimerRef.current) clearInterval(holdTimerRef.current);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("timeupdate", tickGuarded);
      audio.removeEventListener("timeupdate", restTick);
      audio.removeEventListener("timeupdate", heardTick);
      for (const ev of LOCK_SYNC_EVENTS) audio.removeEventListener(ev, lockSync);
      clearAllLockScreen(); // the player is gone: no phantom control left behind
      audio.removeEventListener("loadedmetadata", onDuration);
      audio.removeEventListener("durationchange", onDuration);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      window.removeEventListener("offline", onOffline);
      offlineRef.current.stop();
      clearHandlers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function skipBy(seconds: number) {
    // From where the episode is, not the element's reading: a failed element
    // (in a network hold), one still being put on its start, or one without
    // metadata yet may read anything. A fresh reading first (notePosition
    // records only trustworthy ones): a locked phone's throttled timeupdates
    // can leave the known position seconds old, and a lock-screen ±30 s
    // comes with no element event.
    // A tap is a touch whether or not it can seek (no length yet, say).
    restRef.current?.noteInteraction();
    const audio = audioRef.current;
    if (!audio) return;
    listenerSeek(freshPosition(audio) + seconds);
  }

  /** The lock screen's scrubber and play state, from the player's own view
   *  (the element's reading can be ~0 while a seek is enforced or a reload
   *  loads, and a nudge of that thumb would throw the position away). Set
   *  when something changes: a seek, a new length, play, pause, a new load;
   *  the platform extrapolates in between, at the rate given, and not at
   *  all while the state says paused. Cleared while the length is unknown
   *  (a new episode, a stream), so no stale scrubber is left behind.
   *  A listener's own seek passes `moved`: any change of position is
   *  published then, however small, whatever the drift slack. */
  function syncLockScreen(moved = false) {
    const audio = audioRef.current;
    if (!audio || !mediaSession()) return;
    // No src: endSession, the one place it is removed, has cleared it.
    if (!audio.getAttribute("src")) return;
    // Display only: which readings count is notePosition's business.
    // Only moving when it is: stalled ("waiting"), still loading after
    // play(), or seeking, it shows paused, so the platform doesn't
    // extrapolate past audio that isn't advancing (a rate of 0 isn't allowed).
    const moving = mediaTransport(audio) === "playing";
    const span = episodeSpan(audio);
    const rate = audio.playbackRate || 1;
    // Nothing to publish when it would say what the lock screen already
    // shows ("play" then "playing", loadedmetadata then durationchange).
    const state = moving ? "playing" : "paused";
    const last = publishedRef.current;
    if (last && last.state === state && (last.span?.dur ?? null) === (span?.dur ?? null) && last.rate === rate) {
      const since = Date.now() - last.atMs;
      // Rejected: the same publish again only after a while (at once if the
      // clock stepped back, or for a listener's own seek).
      if (!last.taken) {
        if (!moved && since >= 0 && since < LOCK_RETRY_MS) return;
      } else {
        // No length (a stream, not yet known), so no position, on both
        // sides (the same length): nothing to be off from until a length
        // arrives and syncs.
        if (!span || !last.span) return;
        // Where the lock screen, extrapolating from the last publish,
        // thinks it is. A listener's seek, or paused with the element truly
        // paused: any change is real. Otherwise (playing, or buffering yet
        // moving) it drifts by the extrapolation's slack, or it would
        // republish every tick.
        const expected = last.span.pos + (moving ? (since / 1000) * rate : 0);
        const exact = moved || (!moving && audio.paused);
        if (Math.abs(span.pos - expected) <= (exact ? 0.25 : 2)) return;
      }
    }
    const taken = publishLockScreen(state, span, rate);
    publishedRef.current = { state, rate, span, atMs: Date.now(), taken };
  }

  /** Clear the lock screen, and what the player remembers publishing. */
  function clearAllLockScreen() {
    publishedRef.current = null;
    clearLockScreen();
  }

  /** A fresh reading (by notePosition's rules), then the lock screen from it. */
  function refreshLockScreen(audio: HTMLAudioElement) {
    notePosition(audio);
    syncLockScreen();
  }

  /** Where the episode is and how long it is, as the player sees it, with
   *  the position kept within it: the one view the bar, the lock screen and
   *  the stop all read. Null while the length is unknown. */
  function episodeSpan(audio: HTMLAudioElement): { pos: number; dur: number } | null {
    return spanOf(resumePosition(), episodeDuration(audio));
  }

  /** The episode's duration, as far as anyone knows: the element's, or the
   *  one it reported before a reload. */
  function episodeDuration(audio: HTMLAudioElement): number | null {
    return durationLatchRef.current.read(audio.duration);
  }

  /** Every listener seek (the scrubber, ±30 s, the lock screen). Known here,
   *  so nothing has to guess it from events later, and recorded at once,
   *  even on a failed element in a network hold (where the reload will
   *  land). Clamped to the episode, never onto its very end (which would
   *  end it); nothing when nothing is loaded. It replaces the skip-intro,
   *  pending or decided. Before playback every seek, back to 0 included, is
   *  enforced through aimAt: the pending seek retargeted, or a new one (a
   *  lock-screen drag step, `fast`, only moves the target, the next event
   *  seeking). After playback any pending seek gives way to a plain one,
   *  where a drag step can use the browser's fastSeek. */
  function listenerSeek(to: number, fast = false): boolean {
    const audio = audioRef.current;
    if (!audio || !audio.getAttribute("src") || !Number.isFinite(to)) return false;
    skipRef.current = null;
    skipSeekRef.current = null;
    if (!epPlayedRef.current) {
      // Before playback, a plain seek is what Safari resets: enforce it,
      // back to 0 too (a plain seek there would leave a "seeked" in flight
      // for the next enforcer to misread). A drag step only moves the
      // target; the drag's final seek enforces. (Its own hooks, none: a
      // skip-intro's announcement isn't the listener's seek.) The enforcer
      // keeps it short of the end itself, on the same duration.
      aimAt(audio, to, {}, { move: fast });
    } else {
      const at = shortOfEnd(to, episodeDuration(audio));
      pendingSeekRef.current?.cancel();
      knownPosRef.current = at;
      // A jump, not time heard (after the cancel's rebase). fastSeek, where
      // used, lands only near `at`, so its first reading sets the baseline.
      const useFastSeek = fast && typeof audio.fastSeek === "function";
      lastPosRef.current = useFastSeek ? NaN : at;
      try {
        if (useFastSeek) audio.fastSeek(at);
        else audio.currentTime = at;
      } catch { /* not seekable now: the reload lands there */ }
    }
    // At once: a paused element may not seek until played, and a drag's
    // steps come faster than "seeked".
    syncLockScreen(true);
    return true;
  }

  // End must survive 2am thumbs: press and hold for a full second, a ring
  // fills to show intent registering, release early and nothing happens.
  function holdEndStart() {
    // A second press (another finger, a pointerdown with no pointerup) must
    // not orphan the first timer: nothing could cancel it, and it went on to
    // end the night the listener had let go of.
    holdEndCancel();
    let pct = 0;
    holdTimerRef.current = setInterval(() => {
      pct += 8;
      setHoldPct(pct);
      if (pct >= 100) {
        holdEndCancel();
        endSession("ended");
      }
    }, 80);
  }

  function holdEndCancel() {
    if (holdTimerRef.current) clearInterval(holdTimerRef.current);
    holdTimerRef.current = null;
    setHoldPct(0);
  }

  // The scrubber by keyboard: arrows skip 30 seconds, Home is the start.
  function seekByKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") skipBy(30);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") skipBy(-30);
    else if (e.key === "Home") { restRef.current?.noteInteraction(); listenerSeek(0); }
    else return;
    e.preventDefault();
  }

  function seekToRatio(e: React.MouseEvent<HTMLDivElement>) {
    // A tap is a touch whether or not it can seek.
    restRef.current?.noteInteraction();
    const audio = audioRef.current;
    // Scaled by the bar as drawn, so the click lands where the listener
    // aimed, and only while the bar is this episode's: nothing while its
    // length is unknown, or while the bar still shows the last episode's (a
    // tick after a track change). listenerSeek clamps.
    const dur = audio ? episodeDuration(audio) : null;
    if (!epPos || dur === null || epPos.dur !== dur) return;
    const rect = e.currentTarget.getBoundingClientRect();
    listenerSeek(((e.clientX - rect.left) / rect.width) * dur);
  }

  function handleTogglePause() {
    restRef.current?.noteInteraction();
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) askForSound();
    else audio.pause();
  }

  askForSoundRef.current = askForSound;

  function handleNext() {
    restRef.current?.noteInteraction();
    const leaving = currentEpRef.current;
    if (leaving) restRef.current?.noteSkip(leaving.feedId);
    playNext();
  }

  const countdownStr = formatTime(countdown);
  const timerLabel = mode.kind === "minutes" ? countdownStr : mode.kind === "one-episode" ? "one episode" : "all night";
  // The room dims as the night wanes: the artwork only, so the words and
  // controls keep their contrast.
  const dim = Math.max(0.55, 1 - 0.45 * (1 - countdown / Math.max(1, totalSeconds)));
  const nowArt = artworkByFeedId[nowPlaying?.feedId ?? ""];
  const nowShow = nowPlaying ? (feedTitles[nowPlaying.feedId] ?? "") : "";
  const epPct = epPos ? Math.min(100, (epPos.cur / epPos.dur) * 100) : 0;
  const spread = pool.filter((e) => !blockedTonight.has(e.id));

  // Ending this night from outside (another night started), always through
  // this render's endSession.
  useEffect(() => {
    if (!endRef) return;
    endRef.current = () => endSession("ended");
    return () => { endRef.current = null; };
  });
  useEffect(() => {
    if (!activityRef) return;
    activityRef.current = () => restRef.current?.noteInteraction();
    return () => { activityRef.current = null; };
  });
  // Coming back to the page mid-night is a touch too: a locked phone keeps it
  // hidden, so seeing it again means someone unlocked the phone and opened
  // Sleepcast, which nobody does asleep. Without this, checking the time in
  // the app left the night looking untouched.
  useEffect(() => {
    const onVis = () => { if (!document.hidden) restRef.current?.noteInteraction(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  // Opening or closing the player is a touch like any other.
  const expandPlayer = () => { restRef.current?.noteInteraction(); onExpand(); };
  const collapsePlayer = () => { restRef.current?.noteInteraction(); onCollapse(); };

  return (
    <>
      <audio ref={audioRef} preload="none" />
      {/* Notes like "skipped the intro" read out, whichever view is up. */}
      <div role="status" className="sr-only">{toast}</div>

      {/* Collapsed: a mini bar above the tabs (at the foot of a wide screen,
          where the tabs run along the top), so the shows can be browsed
          while the night plays. */}
      {!expanded && (
        <div className="fixed inset-x-0 bottom-[calc(4.4rem+env(safe-area-inset-bottom,0px))] z-40 px-2.5 md:bottom-[calc(1.25rem+env(safe-area-inset-bottom,0px))]">
          <div className="relative mx-auto grid max-w-lg grid-cols-[44px_1fr_auto] items-center gap-2.5 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-2 shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
            <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-[var(--line)]"><span className="block h-full rounded-full bg-[var(--accent-text)]" style={{ width: `${epPct}%` }} /></span>
            <button ref={openBtnRef} onClick={expandPlayer} className="col-span-2 grid min-w-0 grid-cols-[44px_1fr] items-center gap-2.5 rounded-xl text-left" aria-label={`Open the player: ${nowPlaying?.title ?? "loading"}, ${timerLabel}`}>
              <NowArt key={nowPlaying?.feedId} src={nowArt} />
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-semibold text-[var(--ink)]">{nowPlaying?.title ?? "loading…"}</span>
                <span className="block truncate text-xs text-[var(--ink-3)]">
                  {nowPlaying ? (feedTitles[nowPlaying.feedId] ?? "") : ""}
                  {" · "}
                  <b className="font-bold text-[var(--accent-text)]">{timerLabel}</b>
                </span>
              </span>
            </button>
            <button
              onClick={handleTogglePause}
              aria-label={paused ? "Resume" : "Pause"}
              className="grid h-10 w-10 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)]"
            >
              {paused ? <PlayIcon /> : <PauseIcon />}
            </button>
          </div>
        </div>
      )}

      {/* Expanded: Now Playing. The show's artwork, blurred, colours the
          room (and dims with it as the night wanes); on a wide screen the
          cover sits beside the controls. */}
      {expanded && (
        <div role="dialog" aria-modal="true" aria-label="Now playing" className="fixed inset-0 z-45 overflow-y-auto bg-[var(--ground)] [z-index:45] [scroll-padding-bottom:0]">
          <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden dream-sink" style={{ opacity: dim }}>
            {nowArt ? (
              <img key={nowArt} src={nowArt} alt="" className="h-full w-full scale-125 object-cover opacity-75 blur-3xl saturate-150" />
            ) : null}
            <div className="absolute inset-0" style={{ background: "linear-gradient(to bottom, color-mix(in srgb, var(--ground) 20%, transparent), color-mix(in srgb, var(--ground) 60%, transparent) 45%, var(--ground) 90%)" }} />
          </div>

          <div className="relative mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-[calc(0.75rem+env(safe-area-inset-top,0px))] lg:grid lg:max-w-5xl lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:content-start lg:gap-x-14 lg:px-10">
            <div className="grid grid-cols-[40px_1fr_40px] items-center lg:col-span-2">
              <button ref={collapseBtnRef} onClick={collapsePlayer} aria-label="Close the player, keep it playing" className="grid h-10 w-10 place-items-center rounded-full text-[var(--ink)] hover:bg-[var(--raised)]">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
              </button>
              <div className="min-w-0 text-center leading-tight">
                <div className="text-[11px] font-semibold text-[var(--ink-3)]">Playing from</div>
                <div className="truncate text-sm font-bold text-[var(--ink)]">{nowShow || "your shuffle"}</div>
              </div>
            </div>

            <div className="mx-auto w-full max-w-[340px] lg:sticky lg:top-8 lg:max-w-[440px] lg:self-start"><NowArt key={nowPlaying?.feedId} src={nowArt} big /></div>

            <div className="flex flex-col gap-6">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="line-clamp-2 text-[22px] font-extrabold leading-tight tracking-tight text-[var(--ink)]">{nowPlaying?.title ?? "loading…"}</h2>
                  <div className="mt-1 truncate text-[15px] text-[var(--ink-2)]">{nowShow}</div>
                </div>
                {/* The only per-episode negative control. Disabling a whole feed
                    used to be the only way to escape one jarring episode. */}
                <button onClick={handleBlock} className="mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold text-[var(--ink-2)] ring-1 ring-[var(--line)] hover:text-[var(--ink)]">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></svg>
                  Never again
                </button>
              </div>

              <div>
                <div
                  className="relative cursor-pointer py-2"
                  onClick={seekToRatio}
                  onKeyDown={seekByKey}
                  tabIndex={0}
                  role="slider"
                  aria-label="Position in the episode"
                  aria-valuemin={0}
                  aria-valuemax={epPos ? Math.round(epPos.dur) : 0}
                  aria-valuenow={epPos ? Math.round(epPos.cur) : 0}
                  aria-valuetext={epPos ? `${formatTime(epPos.cur)} of ${formatTime(epPos.dur)}` : "not started"}
                >
                  <div className="ep-progress"><span style={{ width: `${epPct}%` }} /></div>
                  <span aria-hidden="true" className="ep-knob" style={{ left: `${epPct}%` }} />
                </div>
                <div className="mt-0.5 flex justify-between text-xs tabular-nums text-[var(--ink-3)]">
                  <span>{epPos ? formatTime(epPos.cur) : "0:00"}</span>
                  <span>{epPos ? `-${formatTime(Math.max(0, epPos.dur - epPos.cur))}` : ""}</span>
                </div>
              </div>

              <div className="grid grid-cols-5 items-center justify-items-center">
                {/* The timer within reach of the controls; the card below has
                    the rest. */}
                <button
                  onClick={() => document.getElementById("timer-title")?.scrollIntoView({ behavior: "smooth", block: "center" })}
                  aria-label={`Sleep timer: ${timerLabel}`}
                  className="inline-flex h-12 items-center gap-1 text-[var(--accent-text)]"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 shrink-0" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></svg>
                  {mode.kind === "minutes" && <span className="text-xs font-bold tabular-nums">{Math.ceil(countdown / 60)}m</span>}
                </button>
                <button onClick={() => skipBy(-30)} aria-label="Back 30 seconds" className="relative grid h-12 w-12 place-items-center text-[var(--ink)]">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-9 w-9" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v4h4" /></svg>
                  <span className="absolute pt-0.5 text-[10px] font-extrabold">30</span>
                </button>
                <button onClick={handleTogglePause} aria-label={paused ? "Resume" : "Pause"} className="grid h-[72px] w-[72px] place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] shadow-[0_8px_24px_rgba(0,0,0,0.25)] active:scale-95">
                  {paused ? <PlayIcon big /> : <PauseIcon big />}
                </button>
                <button onClick={() => skipBy(30)} aria-label="Forward 30 seconds" className="relative grid h-12 w-12 place-items-center text-[var(--ink)]">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-9 w-9" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v4h-4" /></svg>
                  <span className="absolute pt-0.5 text-[10px] font-extrabold">30</span>
                </button>
                <button onClick={handleNext} aria-label="Next episode" title="Next episode" className="grid h-12 w-12 place-items-center text-[var(--ink)]">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-7 w-7" aria-hidden="true"><path d="M5 5.5v13l10-6.5z" /><rect x="16.5" y="5.5" width="2.5" height="13" rx="1" /></svg>
                </button>
              </div>
              <div aria-hidden="true" className="-my-3 min-h-4 text-center text-xs text-[var(--ink-3)]">
                {toast && <span className="player-toast inline-block">{toast}</span>}
              </div>

              <section aria-labelledby="timer-title" className="space-y-3 rounded-2xl bg-[color-mix(in_srgb,var(--surface)_85%,transparent)] p-4 ring-1 ring-[var(--line)] backdrop-blur">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="timer-title" className="inline-flex items-center gap-2 text-base font-bold text-[var(--ink)]">
                    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-[var(--accent-text)]" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></svg>
                    Sleep timer
                  </h3>
                  <b className="text-2xl font-extrabold tabular-nums tracking-tight text-[var(--ink)]">{timerLabel}</b>
                </div>
                <p className="text-[13px] text-[var(--ink-3)]">
                  {mode.kind === "minutes"
                    ? "Stops when the timer runs out. Add time up to three times a night."
                    : mode.kind === "one-episode"
                      ? "Stops at the end of this episode."
                      : "Plays on until you end it."}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {/* Only a timed night has a timer to stretch. Past the cap the
                      offer is withdrawn rather than disabled: a greyed-out button
                      is still an invitation to keep trying. */}
                  {mode.kind === "minutes" && (
                    canExtendMore ? (
                      <button onClick={() => extendTimer(15)} className="rounded-full bg-[var(--raised)] px-4 py-2.5 text-sm font-semibold text-[var(--ink)]">+15 min</button>
                    ) : (
                      <p className="text-xs text-[var(--ink-3)]">It isn&apos;t the timer: no more time tonight.</p>
                    )
                  )}
                  <button
                    onPointerDown={holdEndStart}
                    onPointerUp={holdEndCancel}
                    onPointerLeave={holdEndCancel}
                    // The same hold by keyboard: Space or Enter held down.
                    onKeyDown={(e) => {
                      if (e.key !== " " && e.key !== "Enter") return;
                      e.preventDefault();
                      if (!e.repeat) holdEndStart();
                    }}
                    onKeyUp={(e) => { if (e.key === " " || e.key === "Enter") holdEndCancel(); }}
                    onBlur={holdEndCancel}
                    onContextMenu={(e) => e.preventDefault()}
                    className="relative flex-1 select-none touch-none overflow-hidden rounded-full bg-[var(--raised)] px-4 py-2.5 text-sm font-bold text-[var(--ink-2)]"
                    aria-label="Hold to end the night"
                    aria-describedby="hold-end-hint"
                  >
                    {holdPct > 0 ? "keep holding…" : "Hold to end the night"}
                    <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1 origin-left bg-[var(--accent-text)]" style={{ transform: `scaleX(${holdPct / 100})` }} />
                  </button>
                </div>
                <p id="hold-end-hint" className="sr-only">Press and hold, or hold Space, for about a second.</p>
              </section>

              {/* Tonight's spread: the curated lineup, current episode marked,
                  already-played ones settling back like turned pages. */}
              {spread.length <= LINEUP_MAX && (
                <section aria-labelledby="spread-title" className="rounded-2xl bg-[color-mix(in_srgb,var(--surface)_85%,transparent)] p-4 ring-1 ring-[var(--line)] backdrop-blur">
                  <h3 id="spread-title" className="pb-3 text-base font-bold text-[var(--ink)]">Tonight&apos;s spread</h3>
                  <ul className="-mx-2 space-y-0.5">
                  {spread.map((ep) => {
                    const isNow = nowPlaying?.id === ep.id;
                    const wasPlayed = playedIds.has(ep.id) && !isNow;
                    return (
                      <li key={ep.id}>
                      <button
                        aria-current={isNow ? "true" : undefined}
                        onClick={() => { if (!isNow) { restRef.current?.noteInteraction(); playEpisode(ep); } }}
                        className={`grid w-full grid-cols-[40px_1fr_auto] items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-[var(--raised)] ${wasPlayed ? "opacity-50" : ""}`}
                      >
                        <NowArt src={artworkByFeedId[ep.feedId]} small />
                        <span className="min-w-0">
                          {(isNow || wasPlayed) && <span className="sr-only">{isNow ? "Now playing: " : "Played: "}</span>}
                          <span className={`block truncate text-sm ${isNow ? "font-bold text-[var(--accent-text)]" : "font-semibold text-[var(--ink)]"}`}>{ep.title}</span>
                          <span className="block truncate text-xs text-[var(--ink-3)]">{feedTitles[ep.feedId] ?? ep.feedId}</span>
                        </span>
                        <span aria-hidden="true" className="text-xs font-semibold text-[var(--ink-3)]">{isNow ? <span className="text-[var(--accent-text)]">Now</span> : wasPlayed ? "Played" : ""}</span>
                      </button>
                      </li>
                    );
                  })}
                  </ul>
                </section>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
