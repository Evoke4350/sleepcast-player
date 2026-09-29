import { lazy, Suspense, useEffect, useRef, useState } from "react";

// The drift game (three.js) loads only when opened — the player's own
// bundle stays featherweight.
const DriftGame = lazy(() => import("./DriftGame"));
import type { Episode, PlayMode } from "../lib/engine";
import { fadeVolume, formatTime, effectiveVolume, fadeDriverSeconds } from "../lib/engine";
import { getPlays, recordHeardPlay, saveLive, rememberPosition, forgetPosition, blockEpisode } from "../lib/store";
import { NetworkHold, isOffline } from "../lib/network-hold";
import { SeekEnforcer, type SeekHooks } from "../lib/seek-enforcer";
import { mediaTransport } from "../lib/media/transport";
import { DurationLatch, shortOfEnd } from "../lib/duration";
import { heardDelta } from "../lib/heard";
import { rearmsWatchdogOnTap } from "../lib/witness";
import { clearLockScreen, mediaSession, publishLockScreen, publishLockScreenMetadata, setActionHandlers } from "../lib/lock-screen";
import { decideSkip, skipMessage, stillAtStart } from "../lib/skip-intro";
import { pickNextEpisode, HEARD_SEC } from "../lib/plays";
import { canExtend } from "../lib/timer-feel";
import type { NoiseSettings } from "../lib/store";
import { BrownNoise, noiseGain } from "../lib/noise";
import { Leveler } from "../lib/leveler";
import { shouldTick } from "../lib/tick-gate";
import { shouldSuggestGettingUp } from "../lib/rest/quarterhour";
import { RestSession, revivedNightStart } from "../lib/rest/session";
import { recordNightEnd } from "../lib/night-end";
import type { RestNight } from "../lib/rest/types";
import { MAX_FAILS } from "../lib/episode-end";

const FADE_SECONDS = 60;
// Just under a second, so a jittery 1s interval isn't swallowed by the gate it
// shares with the ~4Hz timeupdate stream.
const TICK_MIN_MS = 900;

// Feeds whose enclosures rejected CORS playback this session — don't retry.
// Module-level and intentionally outliving a Player mount: a new mount on the
// next episode shouldn't rediscover a feed's CORS support from scratch.
const corsBadFeeds = new Set<string>();
// Feeds that have proven a successful CORS playback this session. The
// compressor only attaches once EVERY feed in the pool is known-good, because
// createMediaElementSource is a one-way door: a feed that turns out to lack
// CORS headers afterwards produces silence rather than an error event, and
// cannot be detected at runtime.
const corsGoodFeeds = new Set<string>();

// iOS suspends AudioContext the moment the screen locks, and
// createMediaElementSource permanently rewires the element's output through
// that context — there is no way back once attached. So on iOS an attached
// compressor means: lock the phone, the context suspends, and the night plays
// in silence while currentTime advances, the fade runs and the timer completes
// normally. Nothing reports a failure; the listener just gets nothing.
//
// Detected rather than inferred where possible: iPadOS reports itself as Mac,
// so the touch-point check is the standard way to catch it.
function suspendsWebAudioOnLock(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iOSLike = /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return iOSLike;
}
const IS_TOUCH = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
// A pool this small is a curated lineup (varied night), not a whole archive:
// show it, so the night's spread is something you can see.
const LINEUP_MAX = 12;

export interface PlayerProps {
  pool: Episode[];
  timerMinutes: number;
  mode: PlayMode;
  /** feedId → 0.5..1.5 gain trim; absent means 1.0. */
  feedTrim: Record<string, number>;
  noise: NoiseSettings;
  /** Opt-in loudness compressor. Ignored where Web Audio dies on lock. */
  leveling: boolean;
  skipIntroByFeedId: Record<string, number>;
  feedTitles: Record<string, string>;
  artworkByFeedId: Record<string, string>;
  onEnd: () => void;
  // Present when reviving a night after a reload: start from this episode at
  // this position with this much time left, instead of a fresh spin + timer.
  resume?: {
    episode: Episode;
    position: number;
    remainingMs: number;
    totalSeconds: number;
    playedIds: string[];
    /** When the revived night really began (snapshot's nightStartedAt). */
    nightStartedAt?: number;
    /** Transport touches before the reload. */
    interactions?: number;
  } | null;
  // "the exact one again": lead a fresh night with this episode (the same show
  // the returning listener drifted off to), then shuffle on as usual.
  leadEpisode?: Episode | null;
  // Where to resume the lead episode, when the listener chose "from where you
  // drifted". 0 means start at the top (skip-intro still applies).
  leadPosition?: number;
  /** Opt-in stimulus control (rest/quarterhour.ts). Off unless asked for. */
  quarterHourRule?: boolean;
  wasVaried?: boolean;
}

/** Element events after which the lock screen is re-synced: play state
 *  (play, pause, playing, waiting), position (seeked), length
 *  (loadedmetadata, durationchange) and a new load (loadstart, which clears
 *  the last episode's scrubber until the new length is known). */
/** How long a publish the platform rejected stands before the same one is
 *  tried again (a rejection that lasts shouldn't be retried every tick). */
const LOCK_RETRY_MS = 10_000;
const LOCK_SYNC_EVENTS = ["play", "pause", "playing", "waiting", "seeked", "loadedmetadata", "durationchange", "loadstart"] as const;

export function Player({ pool, timerMinutes, mode, feedTrim, noise, leveling, skipIntroByFeedId, feedTitles, artworkByFeedId, onEnd, resume = null, leadEpisode = null, leadPosition = 0, quarterHourRule = false, wasVaried = false }: PlayerProps) {
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
  const netHoldRef = useRef<NetworkHold>(null!);
  netHoldRef.current ??= new NetworkHold();
  /** Where the episode is, as far as anyone can tell (see resumePosition),
   *  when no seek is pending: the element's own trustworthy reading (see
   *  notePosition), or the target a seek left behind when it ended without
   *  landing (kept short of the known end), or a load's start of 0. */
  const knownPosRef = useRef(0);
  /** What the lock screen was last told: state, length and rate (to skip a
   *  publish that would change nothing), and the position with when it was
   *  published (to tell a correction from steady playback, which moves at
   *  the rate only while the state is "playing"). pos null: no length, so
   *  no position published. taken: whether the platform accepted it (see
   *  LOCK_RETRY_MS). Null when nothing is published. */
  const publishedRef = useRef<{
    state: "playing" | "paused";
    dur: number | null;
    rate: number;
    pos: number | null;
    atMs: number;
    taken: boolean;
  } | null>(null);
  /** The current episode's duration once its element has reported one: kept
   *  across a reload (whose element knows nothing yet), reset per episode. */
  const durationLatchRef = useRef<DurationLatch>(null!);
  durationLatchRef.current ??= new DurationLatch();
  const failsRef = useRef(0);
  // Whether anything has actually played this night. A night that never did
  // records nothing when it ends (see endSession).
  const hasEverPlayedRef = useRef(false);
  // Whether the CURRENT episode has reached "playing". Until it has, its
  // position reads 0 (src just set, the resume seek waits for metadata), so
  // snapshots and resume points wait for it rather than save that 0 over a
  // revived night's position.
  const epPlayedRef = useRef(false);
  const restRef = useRef<RestSession | null>(null);
  const lastRestTickRef = useRef(0);
  // The full episode now playing (nowPlaying state omits the url we need to
  // revive it), the live timer total, and a throttle so we snapshot the night
  // to storage every ~10s rather than every tick.
  const currentEpRef = useRef<Episode | null>(null);
  /** The last episode that actually played tonight (see NightEnd.lastHeard). */
  const lastHeardEpRef = useRef<Episode | null>(null);
  const totalSecondsRef = useRef(timerMinutes * 60);
  const persistCounterRef = useRef(0);
  // Play-ledger accounting for the episode currently playing (see heardTick).
  const heardSecRef = useRef(0); // real playback accumulated, seconds
  const lastPosRef = useRef(0); // previous audio.currentTime, to diff against
  const heardSavedAtRef = useRef(-1e9); // heardSec at the last ledger write
  const epStartedAtRef = useRef(0); // epoch ms this episode began
  const playedIdsRef = useRef<ReadonlySet<string>>(new Set());
  const wasVariedRef = useRef(wasVaried);
  const modeRef = useRef(mode);
  // The user asked to stop and a short courtesy fade is running. While it is,
  // it owns audio.volume — see tick().
  const stopFadeRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentFeedRef = useRef<string | null>(null);
  const feedTrimRef = useRef<Record<string, number>>(feedTrim);
  const brownRef = useRef<BrownNoise | null>(null);
  const levelerRef = useRef<Leveler | null>(null);
  // Whether the compressor has captured the element. Per-mount, unlike the
  // CORS sets: the AudioContext it guards doesn't survive a mount either.
  const attachedRef = useRef(false);
  const levelingRef = useRef(leveling);

  const [nowPlaying, setNowPlaying] = useState<{ id: string; title: string; feedId: string } | null>(null);
  const [playedIds, setPlayedIds] = useState<ReadonlySet<string>>(new Set());
  const [countdown, setCountdown] = useState(timerMinutes * 60);
  // The time left stays veiled behind the moon — a running countdown
  // invites doing arithmetic against your own sleep. Tap to peek.
  const [peekUntil, setPeekUntil] = useState(0);
  const peeking = Date.now() < peekUntil;
  const [paused, setPaused] = useState(false);
  const [totalSeconds, setTotalSeconds] = useState(timerMinutes * 60);
  const [epPos, setEpPos] = useState<{ cur: number; dur: number } | null>(null);
  const [toast, setToast] = useState("");
  const [holdPct, setHoldPct] = useState(0);
  const [drifting, setDrifting] = useState(false);
  // Stretches used this night (see canExtend). Resets with the component.
  const [extensions, setExtensions] = useState(0);
  const [blockedTonight, setBlockedTonight] = useState<ReadonlySet<string>>(new Set());
  // The quarter-hour rule has fired and playback is held. Once dismissed it
  // does not fire again for the rest of the night.
  const [gettingUp, setGettingUp] = useState(false);
  /** Set with the state, not after the render: the hold reads it at once. */
  const gettingUpRef = useRef(false);
  /** The latest askForSound(), for handlers registered once at mount. */
  const askForSoundRef = useRef<() => void>(() => {});
  const ruleSpentRef = useRef(false);
  const nightStartedAtRef = useRef(Date.now());
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep refs in sync
  useEffect(() => { poolRef.current = pool; }, [pool]);
  useEffect(() => { skipIntroRef.current = skipIntroByFeedId; }, [skipIntroByFeedId]);
  useEffect(() => { feedTitlesRef.current = feedTitles; }, [feedTitles]);
  useEffect(() => { artworkRef.current = artworkByFeedId; }, [artworkByFeedId]);
  useEffect(() => { onEndRef.current = onEnd; }, [onEnd]);
  useEffect(() => { playedIdsRef.current = playedIds; }, [playedIds]);
  useEffect(() => { wasVariedRef.current = wasVaried; }, [wasVaried]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { feedTrimRef.current = feedTrim; }, [feedTrim]);
  useEffect(() => { levelingRef.current = leveling; }, [leveling]);

  function playEpisode(ep: Episode, startAt = 0) {
    const audio = audioRef.current;
    if (!audio) return;

    setNowPlaying({ id: ep.id, title: ep.title, feedId: ep.feedId });
    setPlayedIds((prev) => new Set(prev).add(ep.id));
    currentFeedRef.current = ep.feedId;
    // The rest session infers WHEN sleep began; only the player knows WHAT was
    // playing. Told here rather than reconstructed later, because the play
    // ledger de-duplicates by episode id and cannot answer this for any night
    // but the most recent.
    restRef.current?.noteEpisode(ep.feedId, ep.id);
    // crossOrigin is required before the compressor can ever capture the
    // element, but it also makes playback fail outright on a host that serves
    // no CORS headers — so it is only requested for feeds not already known
    // bad, and onError retries plain before condemning one.
    if (levelingRef.current && !corsBadFeeds.has(ep.feedId)) {
      audio.crossOrigin = "anonymous";
    } else {
      audio.removeAttribute("crossorigin");
    }
    audio.src = ep.url;
    currentEpRef.current = ep;
    // A new episode: the last one's length means nothing now (before the
    // start seek below reads it).
    durationLatchRef.current.reset();
    epPlayedRef.current = false;
    netHoldRef.current.cancel(); // a new episode: any wait was for the last one
    // Snapshot the new episode to storage promptly, not up to 10s later.
    persistCounterRef.current = 10;

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
    // Read before pausing: paused already means by the listener (a paused
    // element's buffering can fail too; see NetworkHold).
    const paused = audio.paused;
    watchRef.current = null;
    freezeClock();
    audio.pause();
    setPaused(true);
    netHoldRef.current.hold(
      () => {
        // Not into a night that is ending (a fade-out) or has moved on. A
        // tap through the get-up prompt is the listener's choice, as it is
        // without a hold.
        if (tickHandleRef.current === null || stopFadeRef.current !== null) return false;
        if (currentEpRef.current !== ep) return false;
        // Where it is at resume: the pending seek's target (the skip may have
        // been decided during the hold), or the last trustworthy position,
        // which includes a scrub made during the hold.
        return reloadCurrent(ep);
      },
      paused,
      // Not by itself over the get-up hold the listener opted into.
      () => !gettingUpRef.current,
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
    const seek = landAt(audio, at, skipSec !== undefined ? skipHooks(skipSec) : {});
    if (skipSec !== undefined) skipSeekRef.current = { seek, skipSec };
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
   *  load reads 0), and not from a failed element, which can read 0 too. */
  /** Returns whether the reading counted. */
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
    // reads 0 until the reload's own seek lands.
    // The episode's length as known (through a reload's NaN), else what the
    // element says (Infinity for a stream, which counts as long).
    const decision = decideSkip(skipSec, episodeDuration(audio) ?? audio.duration, resumePosition());
    if (decision === "wait") return;
    skipRef.current = null;
    if (decision !== "skip") return;
    const seek = aimAt(audio, skipSec, skipHooks(skipSec));
    skipSeekRef.current = { seek, skipSec };
  }

  /** The skip's seek hooks: it says so when it lands. */
  function skipHooks(skipSec: number): SeekHooks {
    return { onLanded: () => showToast(skipMessage(skipSec)) };
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
        // counting through silence, and an untouched fade is recorded as a
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
    // The reload reads 0 until its seek lands: close the snapshot gate until
    // it plays again (see epPlayedRef).
    epPlayedRef.current = false;
    const at = resumePosition();
    audio.src = ep.url;
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

  /** A request for sound: the toggle's play half, the media session's, and
   *  the get-up prompt's "keep listening". Asking for sound answers the
   *  prompt. Read through askForSoundRef by handlers registered at mount. */
  function askForSound() {
    const audio = audioRef.current;
    if (!audio) return;
    if (gettingUpRef.current) showGettingUp(false);
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

  /** The get-up prompt, with its ref set at once (the hold reads it). */
  function showGettingUp(on: boolean) {
    gettingUpRef.current = on;
    setGettingUp(on);
  }

  function playNext() {
    // Exclude what is playing now. The ledger only records an episode after
    // HEARD_SEC, so on a fresh varied mix every episode is still a candidate
    // and Next had a real chance of restarting the same story from 0:00.
    let available = poolRef.current;
    if (attachedRef.current) {
      // Past the one-way door: an episode from a feed that turned out CORS-bad
      // plays silent through the captured element and reports nothing. Skip
      // the whole feed, and end rather than fake-play silence all night.
      const playable = available.filter((e) => !corsBadFeeds.has(e.feedId));
      if (playable.length === 0) {
        // Not a give-up: attachment only happens after something has played.
        endSession("ended");
        return;
      }
      available = playable;
    }
    const current = currentEpRef.current;
    const choices = current
      ? available.filter((e) => e.id !== current.id)
      : available;
    const ep = pickNextEpisode(choices.length ? choices : available, getPlays());
    // Nothing left (the last episode was just blocked): end rather than keep
    // playing the one the listener said "never again" to.
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

  function persistLive() {
    const audio = audioRef.current;
    const ep = currentEpRef.current;
    if (!audio || !ep || tickHandleRef.current === null) return;
    if (!epPlayedRef.current) return; // see epPlayedRef
    // Timerless modes have no remaining time to restore; 0 records "revive the
    // night, there is no clock to resume".
    const remainingMs =
      endTimeRef.current === null
        ? 0
        : pausedRemainingMsRef.current ?? endTimeRef.current - Date.now();
    if (endTimeRef.current !== null && remainingMs <= 0) return;
    saveLive({
      savedAt: Date.now(),
      nightStartedAt: restRef.current?.startedAt,
      timerMinutes: restRef.current?.timerMinutes,
      modeKind: modeRef.current.kind,
      interactions: restRef.current?.interactionCount,
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
  // sleep case, where setInterval is throttled and the fade-window tick would
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
    // The detector's gate is an unattended fade, so it has to watch whichever
    // clock is actually driving the fade in this mode — the timer in minutes
    // mode, the episode in one-episode mode. Keyed to the timer alone, the
    // detector would never see a fade in one-episode mode and could never
    // conclude.
    //
    // In all-night there is no fade by design, so no night can be scored. That
    // is a consequence of the gated model (docs/gated-model.md), not an
    // oversight: precision comes from the fade, and without one there is no
    // evidence that separates asleep from awake-and-resting.
    const audio = audioRef.current;
    const kind = modeRef.current.kind;
    const timerRemaining =
      kind === "minutes" && endTimeRef.current !== null
        ? (endTimeRef.current - Date.now()) / 1000
        : Infinity;
    const epRemaining = audio ? remainingOf(episodeSpan(audio)) : null;
    const driver = fadeDriverSeconds(kind, timerRemaining, epRemaining);
    r.tick({
      now: Date.now(),
      hidden: typeof document !== "undefined" && document.hidden,
      fadingOrDone: driver <= FADE_SECONDS,
    });
  }

  // Every caller goes through here, never straight to tick().
  //
  // setInterval alone was not enough: browsers throttle background intervals
  // to about once a minute, and the phone is locked for nearly all of a sleep
  // timer, so the 60-second fade was sampled once or twice and the stop landed
  // late — the fade decaying into the hard cut it exists to avoid, precisely
  // when it mattered. "timeupdate" keeps firing while backgrounded, which is
  // why the sleep detector and the play ledger were already driven from it;
  // the fade and the stop were simply left behind.
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
    // countdown is Infinity and the fade is driven by the episode instead —
    // see fadeDriverSeconds.
    const kind = modeRef.current.kind;
    const remaining =
      kind === "minutes"
        ? (pausedRemainingMsRef.current ?? endTimeRef.current! - Date.now()) / 1000
        : Infinity;

    restTick();

    // Opt-in stimulus control: a restless stretch means the bed is losing the
    // argument, and playing on only reinforces it. Hold playback and suggest
    // getting up. Fires at most once a night.
    if (quarterHourRule && !ruleSpentRef.current && restRef.current) {
      const now = Date.now();
      const w = restRef.current.wakefulness(now);
      if (shouldSuggestGettingUp({ elapsedMs: now - nightStartedAtRef.current, ...w })) {
        ruleSpentRef.current = true;
        audio.pause();
        setPaused(true);
        showGettingUp(true);
        return;
      }
    }

    if (remaining <= 0) {
      endSession();
      return;
    }

    // Where the episode is and how long, as the rest of the player sees it
    // (not a reading Safari hasn't corrected yet, and not lost on a reload),
    // once per pass for the fade and the bar.
    const span = episodeSpan(audio);
    const epRemaining = remainingOf(span);
    const driver = fadeDriverSeconds(kind, remaining, epRemaining);

    // The courtesy fade owns audio.volume while it runs. Without this guard
    // tick() would reassign full volume from the mode driver (Infinity in
    // all-night) on every pass, fighting the fade back up and producing
    // audible stabs on the way out.
    if (stopFadeRef.current === null) {
      // effectiveVolume with no fade underway (driver Infinity) is the feed's
      // trim alone. A hard 1 here played turned-down feeds at full volume in
      // all-night mode (and one-episode, before the duration was known).
      audio.volume = effectiveVolume(driver, FADE_SECONDS, feedTrimRef.current[currentFeedRef.current ?? ""] ?? 1.0);
      // The underlay rides the same driver, so voices and noise fade together
      // rather than leaving a bed of noise behind after the words stop.
      // Paused means silent: the voice stops, so the noise does too. Left at
      // full level it played on indefinitely under a pause or the quarter-hour
      // hold, with the clock frozen so no fade would ever reach it.
      brownRef.current?.setGain(noiseGain(noise.on && !audio.paused ? noise.level : 0, driver, FADE_SECONDS));
    }
    setCountdown(kind === "minutes" ? remaining : 0);
    // Only when it changed: paused or held, a new object every second
    // re-rendered the whole player for nothing.
    setEpPos((prev) =>
      span === null ? null : prev && prev.cur === span.pos && prev.dur === span.dur ? prev : { cur: span.pos, dur: span.dur },
    );

    const w = watchRef.current;
    if (w && Date.now() - w.at > 25_000) {
      watchRef.current = null;
      if (isOffline()) holdForNetwork();
      else if (!countFailure()) playNext();
      // Everything below concerns the episode just replaced (or the night just
      // ended), as in YouTubeNight's watchdog.
      return;
    }

    // Spent only when a snapshot can actually be written (the episode has
    // played), so a new episode's first one lands as soon as it plays, not
    // ten ticks after a count used up while it was still loading.
    if (++persistCounterRef.current >= 10 && epPlayedRef.current) {
      persistCounterRef.current = 0;
      persistLive();
      rememberCurrentPosition();
    }
  }

  function clearStopFade() {
    if (stopFadeRef.current !== null) {
      clearInterval(stopFadeRef.current);
      stopFadeRef.current = null;
    }
  }

  /** `gaveUp`: the app, not the listener, is ending a night that never
   *  played, so its snapshot is kept (see NightEnd.gaveUp). */
  function endSession(reason: RestNight["endedVia"] = "faded", { gaveUp = false }: { gaveUp?: boolean } = {}) {
    // "faded" is the natural end — the timer ran out untouched. Stamp it so
    // the setup screen can offer a smaller re-arm to someone who wakes back
    // up inside the window. A manual stop is not an invitation to resume.
    //
    // A night that never played anything (every enclosure failed, say, and the
    // listener ended it) records nothing: no re-arm stamp, no empty last night,
    // no RestNight for calibration to learn from. Its snapshot is cleared
    // unless the app is the one giving up (gaveUp; see recordNightEnd).
    clearStopFade();
    netHoldRef.current.cancel();
    pendingSeekRef.current?.cancel(); // nothing may act on the stopped element
    recordNightEnd({
      reason,
      played: hasEverPlayedRef.current,
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
      lastHeard: lastHeardEpRef.current,
      rest: restRef.current,
      now: Date.now(),
    });
    restRef.current = null;
    watchRef.current = null;
    if (tickHandleRef.current !== null) {
      clearInterval(tickHandleRef.current);
      tickHandleRef.current = null;
    }
    brownRef.current?.stop();
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

    clearAllLockScreen(); // the stop's own "pause" event finds no src, and leaves it

    onEndRef.current();
  }

  // Start session on mount
  useEffect(() => {
    pausedRemainingMsRef.current = null;
    endTimeRef.current =
      mode.kind === "minutes"
        ? Date.now() + (resume ? resume.remainingMs : timerMinutes * 60 * 1000)
        : null; // timerless modes: the fade is driven by the episode, not a clock
    // A revived night continues the one that began before the reload: its
    // time-to-sleep, timeline and snapshots count from the real start, not
    // from the tap on "keep going".
    const nightStart = revivedNightStart(resume?.nightStartedAt, Date.now());
    restRef.current = new RestSession(nightStart, timerMinutes);
    restRef.current.seedInteractions(resume?.interactions ?? 0);
    nightStartedAtRef.current = nightStart; // the quarter-hour rule's clock too
    if (resume) {
      totalSecondsRef.current = resume.totalSeconds;
      setTotalSeconds(resume.totalSeconds);
      setCountdown(Math.max(0, resume.remainingMs / 1000));
      setPlayedIds(new Set(resume.playedIds)); // restore which of the spread you'd heard
    }

    const audio = audioRef.current!;

    // pause handler: freeze timer unless it's an episode-end transition
    const onPause = () => {
      setPaused(true);
      watchRef.current = null; // a paused track isn't a stuck track
      if (!audio.ended) freezeClock();
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
      if (stopFadeRef.current !== null) {
        // A courtesy fade is in flight: the listener asked to stop and the
        // episode happened to end underneath it. Starting another would
        // resurrect the night they just ended.
        endSession("ended");
        return;
      }
      if (tickHandleRef.current === null) return;
      // One-episode mode means one episode: its fade was driven by this
      // episode's end, so the night is over. Playing on started the next
      // episode at full volume after the fade and the night never ended.
      // Night.tsx and YouTubeNight.tsx already end here.
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
      lastHeardEpRef.current = currentEpRef.current;
      const feedId = currentFeedRef.current;
      if (feedId && audio.crossOrigin === "anonymous") corsGoodFeeds.add(feedId);
      // Conservative gate: attach only once every feed in the pool has already
      // played successfully under CORS, because the capture cannot be undone.
      if (
        levelingRef.current &&
        !suspendsWebAudioOnLock() &&
        audio.crossOrigin === "anonymous" &&
        poolRef.current.every((e) => corsGoodFeeds.has(e.feedId))
      ) {
        levelerRef.current ??= new Leveler(audio);
        if (levelerRef.current.attach()) attachedRef.current = true;
      }
    };

    const onError = () => {
      // Offline, first: a network drop says nothing about this enclosure or
      // its feed's CORS headers, and must not condemn either.
      if (isOffline() && tickHandleRef.current !== null && audio.getAttribute("src")) {
        holdForNetwork();
        return;
      }
      // A crossOrigin element failing may only mean "this enclosure serves no
      // CORS headers" — retry the same source plain before skipping the track.
      const feedId = currentFeedRef.current;
      if (levelingRef.current && audio.crossOrigin === "anonymous" && audio.getAttribute("src")) {
        // A feed already proven good this session serves CORS headers, so this
        // is a dead enclosure or a signal drop, not a CORS failure. Don't
        // condemn the whole feed over one bad episode.
        if (feedId && !corsGoodFeeds.has(feedId)) corsBadFeeds.add(feedId);
        // Once attached, the element is captured and a plain retry would play
        // into a silenced node — fall through to the ordinary skip instead.
        const ep = currentEpRef.current;
        if (!attachedRef.current && ep) {
          audio.removeAttribute("crossorigin");
          reloadCurrent(ep);
          return;
        }
      }
      if (tickHandleRef.current !== null && audio.getAttribute("src")) {
        // Counted like the watchdog's stuck tracks. Uncounted, a pool whose
        // sources all fail at once (network gone at 2am, every enclosure a
        // 404) switched tracks forever, since onPlaying never resets anything.
        if (!countFailure()) playNext();
      }
    };

    audio.addEventListener("pause", onPause);
    audio.addEventListener("play", onPlay);
    // heardTick first: it notes the position, which tick (the fade, the bar)
    // and restTick then read fresh.
    audio.addEventListener("timeupdate", heardTick); // accumulates real playback for the play ledger
    audio.addEventListener("timeupdate", tickGuarded); // fade + stop must survive a locked screen
    audio.addEventListener("timeupdate", restTick); // keeps the sleep detector fed while backgrounded
    // The skip-intro decides as soon as the duration is known.
    const onDuration = () => {
      const dur = durationLatchRef.current.read(audio.duration);
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
    if (noise.on) {
      const bn = new BrownNoise();
      brownRef.current = bn;
      void bn.start(); // resolves false on failure; setGain then no-ops
    }
    tick(); // paint the first frame immediately; the gate would hold it back

    return () => {
      if (tickHandleRef.current !== null) clearInterval(tickHandleRef.current);
      clearStopFade();
      netHoldRef.current.cancel();
      pendingSeekRef.current?.cancel();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      // A hold still counting at unmount would call endSession on a player
      // that is gone, and through onEnd end whatever night came next.
      if (holdTimerRef.current) clearInterval(holdTimerRef.current);
      brownRef.current?.stop();
      levelerRef.current?.dispose();
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
    const audio = audioRef.current;
    if (!audio) return;
    if (listenerSeek(freshPosition(audio) + seconds)) restRef.current?.noteInteraction();
  }

  /** Time left in the episode, for the fade: from where it is and how long
   *  it is as far as anyone knows, so a reload or a pending start seek
   *  doesn't lose the fade (a new src knows no duration; Safari can read
   *  ~0 before its seek is corrected). */
  function remainingOf(span: { pos: number; dur: number } | null): number | null {
    return span ? span.dur - span.pos : null;
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
    if (last && last.state === state && last.dur === (span?.dur ?? null) && last.rate === rate) {
      // Rejected: the same publish again only after a while.
      if (!last.taken) {
        if (Date.now() - last.atMs < LOCK_RETRY_MS) return;
      } else {
        // No length (a stream, not yet known): no position to be off from
        // until a length arrives and syncs.
        if (span === null) return;
        // Where the lock screen, extrapolating from the last publish (which,
        // with the same length, published a position), thinks it is. A
        // listener's seek, or paused with the element truly paused: any
        // change is real. Otherwise (playing, or buffering yet moving) it
        // drifts by the extrapolation's slack, or it would republish every tick.
        const expected = (last.pos ?? span.pos) + (moving ? ((Date.now() - last.atMs) / 1000) * rate : 0);
        const exact = moved || (!moving && audio.paused);
        if (Math.abs(span.pos - expected) <= (exact ? 0.25 : 2)) return;
      }
    }
    const taken = publishLockScreen(state, span, rate);
    publishedRef.current = { state, dur: span?.dur ?? null, rate, pos: span?.pos ?? null, atMs: Date.now(), taken };
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
   *  the fade all read. Null while the length is unknown. */
  function episodeSpan(audio: HTMLAudioElement): { pos: number; dur: number } | null {
    const dur = episodeDuration(audio);
    if (dur === null) return null;
    return { pos: Math.min(Math.max(0, resumePosition()), dur), dur };
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
      syncLockScreen(true); // at once: a paused element may not seek until played
      return true;
    }
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
    syncLockScreen(true); // at once: the drag's steps come faster than "seeked"
    return true;
  }

  function extendTimer(minutes: number) {
    if (!canExtend(extensions)) return;
    restRef.current?.noteInteraction();
    const ms = minutes * 60 * 1000;
    if (pausedRemainingMsRef.current !== null) pausedRemainingMsRef.current += ms;
    else if (endTimeRef.current !== null) endTimeRef.current += ms;
    totalSecondsRef.current += minutes * 60;
    setTotalSeconds((t) => t + minutes * 60);
    const used = extensions + 1;
    setExtensions(used);
    showToast(
      canExtend(used)
        ? "a little longer — sleep when you're ready"
        : "that's the last stretch. resting counts too.",
    );
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
        if (modeRef.current.kind === "minutes") {
          // A timer night already ends on a fade of its own; cutting it here
          // is what the listener asked for.
          endSession("ended");
        } else if (stopFadeRef.current !== null) {
          // Already mid-courtesy-fade: a second hold means "out now" — don't
          // make them sit through the rest of it.
          endSession("ended");
        } else {
          // Timerless modes have had no fade at all, so stopping would be a
          // hard cut in a dark room. Five seconds of ramp costs nothing and is
          // the whole difference between "ended" and "yanked".
          const audio = audioRef.current;
          if (audio && !audio.paused) {
            const t0 = Date.now();
            stopFadeRef.current = setInterval(() => {
              const left = 5000 - (Date.now() - t0);
              if (left <= 0 || !audioRef.current) {
                clearStopFade();
                endSession("ended");
                return;
              }
              audio.volume = effectiveVolume(
                left / 1000,
                5,
                feedTrimRef.current[currentFeedRef.current ?? ""] ?? 1.0
              );
              brownRef.current?.setGain(noiseGain(noise.on ? noise.level : 0, left / 1000, 5));
            }, 100);
          } else {
            endSession("ended");
          }
        }
      }
    }, 80);
  }

  function holdEndCancel() {
    if (holdTimerRef.current) clearInterval(holdTimerRef.current);
    holdTimerRef.current = null;
    setHoldPct(0);
  }

  function seekToRatio(e: React.MouseEvent<HTMLDivElement>) {
    const audio = audioRef.current;
    // Scaled by the bar as drawn, so the click lands where the listener
    // aimed; nothing while this episode's length is unknown (the bar can be
    // a tick stale right after a track change). listenerSeek clamps.
    if (!epPos || !audio || episodeDuration(audio) === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!listenerSeek(((e.clientX - rect.left) / rect.width) * epPos.dur)) return;
    restRef.current?.noteInteraction();
    // Aiming at a position is the one moment the numbers earn their place —
    // show where you landed, then let them go back under with the moon.
    setPeekUntil(Date.now() + 4000);
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
  // The room dims as the night wanes — controls stay findable, just quieter.
  const dim = Math.max(0.55, 1 - 0.45 * (1 - countdown / Math.max(1, totalSeconds)));

  function dismissGettingUp() {
    restRef.current?.noteInteraction();
    askForSound();
  }

  return (
    <>
      <audio ref={audioRef} preload="none" />

      {/* Opt-in stimulus control. Playback is held, not ended — the listener
          asked for the nudge, not for the app to overrule them. */}
      {gettingUp && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-[#0d0b12] px-8 text-center">
          <p className="text-lg text-[#b0a898]">this one isn't working tonight.</p>
          <p className="max-w-xs text-sm text-[#8a7a5c]">
            get up for a bit. somewhere dim, something dull. come back when
            you're heavy — the bed keeps its meaning that way.
          </p>
          <button
            onClick={() => { showGettingUp(false); endSession("ended"); }}
            className="mt-2 rounded-full border border-[#6e5d44] px-5 py-2 text-sm text-[#f0dcb8] transition-colors hover:border-[#8a7a5c]"
          >
            alright, I'll get up
          </button>
          <button
            onClick={dismissGettingUp}
            className="text-xs text-[#4a4540] underline decoration-[#2a2620] underline-offset-4 transition-colors hover:text-[#8a7a5c]"
          >
            keep playing anyway
          </button>
        </div>
      )}

      <div className="relative min-h-dvh flex flex-col items-center justify-center px-6 py-12">
      <div className="player-ambient" aria-hidden="true">
        <div className="glow g1"></div>
        <div className="glow g2"></div>
        <div className="night-stars" style={{ opacity: 0.22 }}></div>
      </div>
      <div className="relative z-10 w-full max-w-sm space-y-10 text-center dream-sink" style={{ opacity: dim }}>
        {/* Countdown — veiled until tapped */}
        <div>
          <div className="relative inline-block">
            <div className="player-moon-halo" aria-hidden="true"></div>
            <button
              onClick={() => setPeekUntil(Date.now() + 4000)}
              aria-label={
                mode.kind === "minutes"
                  ? `time left ${countdownStr} — tap to peek`
                  : mode.kind === "one-episode"
                    ? "playing one episode"
                    : "playing all night"
              }
              className="relative font-mono font-light tabular-nums text-[#c8c0b0] transition-opacity duration-500"
            >
              {/* Only minutes mode has a countdown to reveal. In the timerless
                  modes the moon stays the moon, because a peek showing 0:00
                  would read as "about to stop" — the opposite of the truth. */}
              {mode.kind === "minutes" && peeking
                ? <span className="text-6xl">{countdownStr}</span>
                : <span className="player-moon text-5xl">☾</span>}
            </button>
          </div>
          <div className="mt-2 flex items-center justify-center gap-3 text-xs text-[#6b6558] uppercase tracking-widest">
            <span>
              {mode.kind === "one-episode"
                ? "one episode"
                : mode.kind === "all-night"
                  ? "all night"
                  : peeking
                    ? "remaining"
                    : "sleeping"}
            </span>
            {/* Only a timed night has a timer to stretch. In one-episode and
                all-night modes extendTimer changes nothing, yet the button
                still spent an extension and confirmed "a little longer". */}
            {mode.kind !== "minutes" ? null : canExtend(extensions) ? (
              <button
                onClick={() => extendTimer(15)}
                className="rounded-full border border-[#2e2d3a] px-3 py-1 normal-case tracking-normal text-[#7a7264] active:scale-95"
              >
                a little longer
              </button>
            ) : (
              // Past the cap the offer is withdrawn rather than disabled — a
              // greyed-out button is still an invitation to keep trying.
              <span className="px-3 py-1 normal-case tracking-normal text-[#4a4540]">
                it isn't the timer
              </span>
            )}
            {/* The only per-episode negative control. Disabling a whole feed
                used to be the only way to escape one jarring episode. */}
            <button
              onClick={handleBlock}
              className="rounded-full border border-[#2e2d3a] px-3 py-1 normal-case tracking-normal text-[#6b6255] active:scale-95"
            >
              never again
            </button>
          </div>
          <div className="mt-2 h-4 text-xs text-[#7a7264]">
            {toast && <span className="player-toast inline-block">{toast}</span>}
          </div>
        </div>

        {/* Now playing */}
        <div className="space-y-1 min-h-[3rem]">
          {nowPlaying ? (
            <>
              <div className="text-base text-[#b0a898] leading-snug line-clamp-2">
                {nowPlaying.title}
              </div>
              <div className="text-xs text-[#4a4540]">
                {feedTitles[nowPlaying.feedId] ?? nowPlaying.feedId}
              </div>
              {epPos && (
                <div className="pt-2">
                  <div className="ep-progress cursor-pointer" onClick={seekToRatio}>
                    <span style={{ width: `${Math.min(100, (epPos.cur / epPos.dur) * 100)}%` }} />
                  </div>
                  {/* Veiled with the moon, and for the same reason. Elapsed
                      episode time is the forbidden number wearing a different
                      hat: "23:40" tells you you've been lying here awake for 23
                      minutes — exactly the arithmetic the moon above exists to
                      prevent. One peek reveals both. The bar stays: it's
                      spatial, and you can scrub by feel without being told a
                      number. Opacity, not conditional render, so the controls
                      never jump when it fades in. */}
                  <div
                    aria-hidden={!peeking}
                    className={`mt-1 flex justify-between text-[10px] tabular-nums text-[#4a4540] transition-opacity duration-500 ${
                      peeking ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    <span>{formatTime(epPos.cur)}</span>
                    <span>{formatTime(epPos.dur)}</span>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-[#4a4540]">loading…</div>
          )}
        </div>

        {/* Transport */}
        <div className="space-y-4">
          <div className="flex items-center justify-center gap-6">
            <button
              onClick={() => skipBy(-30)}
              className="h-12 w-12 rounded-full bg-[#12131d] border border-[#232230] text-xs text-[#7a7264] active:scale-95"
              aria-label="Back 30 seconds"
            >
              -30s
            </button>
            <button
              onClick={handleTogglePause}
              className="w-24 h-24 rounded-full bg-[#1a1b26] border border-[#2e2d3a] text-[#c8c0b0] text-sm font-medium active:scale-95 transition-transform"
              aria-label={paused ? "Resume" : "Pause"}
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              onClick={() => skipBy(30)}
              className="h-12 w-12 rounded-full bg-[#12131d] border border-[#232230] text-xs text-[#7a7264] active:scale-95"
              aria-label="Forward 30 seconds"
            >
              +30s
            </button>
          </div>

          <div className="flex items-center justify-center gap-6">
            <button
              onClick={handleNext}
              className="w-16 h-16 rounded-full bg-[#1a1b26] border border-[#2e2d3a] text-[#c8c0b0] text-xs font-medium active:scale-95 transition-transform"
              aria-label="Next episode"
            >
              Next
            </button>
            <button
              onPointerDown={holdEndStart}
              onPointerUp={holdEndCancel}
              onPointerLeave={holdEndCancel}
              onContextMenu={(e) => e.preventDefault()}
              className="hold-ring w-16 h-16 rounded-full bg-[#1a1b26] border border-[#2e2d3a] text-[#6b6558] text-xs font-medium select-none touch-none"
              style={{ "--hold": holdPct } as React.CSSProperties}
              aria-label="Hold to end session"
            >
              {holdPct > 0 ? "hold…" : "End"}
            </button>
          </div>
        </div>

        {/* drift: a 3D merge toy for hands that aren't sleepy yet.
            Touch-only: on a desktop the mouse-and-monitor posture is wrong
            for it, and the player stays quieter without it. */}
        {IS_TOUCH && <div className="space-y-2">
          <button
            onClick={() => setDrifting((d) => !d)}
            className="text-xs text-[#4a4540] underline decoration-[#2e2d3a] underline-offset-4"
          >
            {drifting ? "put the stars away" : "🌒 drift — a little game while you listen"}
          </button>
          {drifting && (
            <Suspense fallback={<div className="py-10 text-xs text-[#4a4540]">gathering stardust…</div>}>
              <DriftGame />
            </Suspense>
          )}
        </div>}

        {/* Tonight's spread: the curated lineup, current episode marked,
            already-played ones settling back like turned pages. */}
        {pool.filter((e) => !blockedTonight.has(e.id)).length <= LINEUP_MAX && (
          <div className="space-y-1.5 text-left">
            <div className="pb-1 text-center text-xs uppercase tracking-widest text-[#4a4540]">
              tonight&apos;s spread
            </div>
            {pool.filter((e) => !blockedTonight.has(e.id)).map((ep) => {
              const isNow = nowPlaying?.id === ep.id;
              const wasPlayed = playedIds.has(ep.id) && !isNow;
              return (
                <div
                  key={ep.id}
                  onClick={() => { if (!isNow) { restRef.current?.noteInteraction(); playEpisode(ep); } }}
                  className={`flex cursor-pointer items-baseline gap-2 text-sm leading-snug transition-opacity duration-700 ${
                    isNow ? "text-[#c8c0b0]" : wasPlayed ? "text-[#4a4540] opacity-70" : "text-[#7a7264]"
                  }`}
                >
                  <span className="w-3 shrink-0 text-xs">{isNow ? "♪" : wasPlayed ? "·" : ""}</span>
                  <span className="line-clamp-1 flex-1">{ep.title}</span>
                  <span className="shrink-0 text-[10px] text-[#4a4540]">
                    {feedTitles[ep.feedId] ?? ep.feedId}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </>
  );
}
