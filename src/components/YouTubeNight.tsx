// A night played from YouTube.
//
// This is a sibling of Player.tsx, not a replacement and not a refactor of it.
// The two share the shape of a night — countdown, fade, spread, hold-to-end —
// and share every decision module underneath, but they drive different things
// and fail in different ways, and roughly half of Player.tsx is machinery a
// YouTube night has no use for:
//
//   - crossOrigin, the CORS-bad/CORS-good feed sets, and the plain-retry dance
//     on error. An iframe has none of that.
//   - The loudness compressor. createMediaElementSource takes an
//     HTMLMediaElement; there is no element here to capture.
//   - Seek enforcement across loadedmetadata/canplay/playing/timeupdate. The
//     embed takes a start position as a parameter and honours it.
//
// And one thing it needs that a podcast night does not: the screen has to stay
// on. Audio plays through a locked screen; an embedded video does not, on any
// mobile browser, and no API changes that. So this holds a wake lock and says
// plainly when it could not get one.
//
// The other honest limit is ads. Playback goes through Google's player, which
// may show them. Nothing here mutes, skips or hides one — that would be
// circumvention rather than a feature — so the night says up front that they
// can happen.
//
// What this deliberately does NOT carry over: the drift game (a 3D toy makes
// no sense next to a video), the opt-in quarter-hour rule, and per-episode
// artwork (the video is its own artwork).

import { useEffect, useRef, useState } from "react";
import { useLazyRef } from "../lib/use-lazy-ref";
import { useNightShuffle } from "../lib/use-night-shuffle";
import { useStateRef } from "../lib/use-state-ref";
import { useNightExtensions } from "../lib/use-night-extensions";
import type { Episode, PlayMode } from "../lib/engine";
import { formatTime, effectiveVolume, fadeDriverSeconds } from "../lib/engine";
import { barPosition, remainingOf } from "../lib/duration";
import {
  getPlays,
  recordHeardPlay,
  saveLive,
  rememberPosition,
  forgetPosition,
  blockEpisode,
  loadBlocked,
  type NoiseSettings,
  type ResumeDescriptor,
  SNAPSHOT_EVERY_TICKS,
  counterAfterStartSnapshot,
  noteSounded,
} from "../lib/store";
import { HEARD_SEC } from "../lib/plays";
import { BrownNoise, noiseGain } from "../lib/noise";
import { shouldTick } from "../lib/tick-gate";
import { RestSession, revivedNightStart } from "../lib/rest/session";
import { recordNightEnd } from "../lib/night-end";
import { NetworkHold, isOffline } from "../lib/network-hold";
import { heardDelta } from "../lib/heard";
import { clearLockScreen, publishLockScreenMetadata } from "../lib/lock-screen";
import { startWithSkip } from "../lib/skip-intro";
import { PlaybackWitness, rearmsWatchdogOnTap, tapPauses } from "../lib/witness";
import { MAX_FAILS, applyEndedDecision, decideAfterEnded, shouldPlayWhole } from "../lib/episode-end";
import type { RestNight } from "../lib/rest/types";
import { YouTubeMedia } from "../lib/youtube-media";
import type { ErrorInfo } from "../lib/media/backend";
import { buildYouTubePlayer } from "../lib/youtube-embed";
import { loadYouTubeApi } from "../lib/youtube-api";
import {
  nextPlayable,
  decideAfterError,
  transportFor,
  shouldGiveUp,
  type Transport,
} from "../lib/youtube-night";
import { classifyYouTubeError } from "../lib/youtube-errors";
import { browserScreenLock, type ScreenLock } from "../lib/wake-lock";
import { beacon } from "../lib/beacon";

const FADE_SECONDS = 60;
const TICK_MIN_MS = 900;
const LINEUP_MAX = 12;
// A video that has not reached "playing" by now is stuck: a blocked embed that
// reported no error, a stalled load, a region lock. Move on rather than sit in
// silence while the countdown runs down.
const WATCHDOG_MS = 25_000;
// How long a video may sit unstarted before the tap prompt appears. Long
// enough that a player still coming up doesn't flash it, short enough that
// nobody stares at a still frame wondering.
const START_PROMPT_MS = 2_500;

export interface YouTubeNightProps {
  pool: Episode[];
  timerMinutes: number;
  mode: PlayMode;
  feedTrim: Record<string, number>;
  noise: NoiseSettings;
  skipIntroByFeedId: Record<string, number>;
  feedTitles: Record<string, string>;
  artworkByFeedId: Record<string, string>;
  onEnd: () => void;
  resume?: ResumeDescriptor | null;
  leadEpisode?: Episode | null;
  leadPosition?: number;
  wasVaried?: boolean;
  /** Opt-in: the shuffle leans by feed (rest/sleepscore shuffleWeights). */
  favorWhatWorks?: boolean;
}

export function YouTubeNight({
  pool,
  timerMinutes,
  mode,
  feedTrim,
  noise,
  skipIntroByFeedId,
  feedTitles,
  artworkByFeedId,
  onEnd,
  resume = null,
  leadEpisode = null,
  leadPosition = 0,
  wasVaried = false,
  favorWhatWorks = false,
}: YouTubeNightProps) {
  const shuffle = useNightShuffle(favorWhatWorks, pool, resume, () => restRef.current?.noteShuffleLeaned());
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<YouTubeMedia | null>(null);
  const lockRef = useRef<ScreenLock | null>(null);

  const endTimeRef = useRef<number | null>(null);
  const pausedRemainingMsRef = useRef<number | null>(null);
  const tickHandleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopFadeRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTickRef = useRef(0);
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poolRef = useRef(pool);
  const skipIntroRef = useRef(skipIntroByFeedId);
  const feedTitlesRef = useRef(feedTitles);
  const artworkRef = useRef(artworkByFeedId);
  const feedTrimRef = useRef(feedTrim);
  const modeRef = useRef(mode);
  const onEndRef = useRef(onEnd);
  const wasVariedRef = useRef(wasVaried);

  const currentEpRef = useRef<Episode | null>(null);
  /** The episode last tried as "the exact one again" (see noteSounded),
   *  so the save is tried once per episode, not on every sound. */
  const triedEpRef = useRef<Episode | null>(null);
  const currentFeedRef = useRef<string | null>(null);
  // Everything known not to play: blocked across nights (the uploader disabled
  // embedding, the video is gone) plus whatever failed tonight.
  const deadRef = useRef<Set<string>>(new Set());
  const retriesRef = useRef(0);
  const watchRef = useRef<{ id: string; at: number } | null>(null);
  const failsRef = useRef(0);

  const heardSecRef = useRef(0);
  const lastPosRef = useRef(0);
  const heardSavedAtRef = useRef(-1e9);
  const epStartedAtRef = useRef(0);
  const persistCounterRef = useRef(0);

  const restRef = useRef<RestSession | null>(null);
  const lastRestTickRef = useRef(0);
  const brownRef = useRef<BrownNoise | null>(null);

  const [status, setStatus] = useState<"loading" | "playing" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const [nowPlaying, setNowPlaying] = useState<{ id: string; title: string; feedId: string } | null>(null);
  // The played set: state for the lineup, ref for same-tick snapshots, one
  // setter for both (the restore and each start).
  const [playedIds, playedIdsRef, setPlayed] = useStateRef<ReadonlySet<string>>(new Set());
  const [blockedTonight, setBlockedTonight] = useState<ReadonlySet<string>>(new Set());
  const [countdown, setCountdown] = useState(timerMinutes * 60);
  // The night's total length: state for the ring, ref for snapshots, one setter.
  const [totalSeconds, totalSecondsRef, setTotalSeconds] = useStateRef(timerMinutes * 60);
  const [peekUntil, setPeekUntil] = useState(0);
  // What the player is doing, read from it rather than mirrored. The first
  // version kept a `paused` boolean updated on the three state codes it
  // handled; the other three (unstarted, cued, buffering) left it saying
  // "playing" while nothing played, so a video waiting for a tap rendered a
  // Pause button over silence.
  const [transport, setTransportState] = useState<Transport>("buffering");
  /** The transport as last set, readable outside a render. */
  const transportRef = useRef<Transport>("buffering");
  function setTransport(t: Transport) {
    transportRef.current = t;
    setTransportState(t);
  }
  // Whether anything has played at all this night. Autoplay refusals look
  // exactly like a dead video until you know the answer to this.
  const hasEverPlayedRef = useRef(false);
  // Whether the CURRENT episode has actually played, and where it was asked
  // to start (lib/witness.ts). Until it plays, its position can't be trusted
  // (the player isn't ready or the seek hasn't landed), so resume points and
  // periodic snapshots wait for it, a snapshot meanwhile records the intended
  // start, and a retry reloads there.
  const witnessRef = useLazyRef(() => new PlaybackWitness());
  /** Waiting out a dropped network (see holdForNetwork). */
  const netHoldRef = useLazyRef(() => new NetworkHold());
  // The prompt waits a beat before appearing. A player that is simply still
  // coming up also reads as "unstarted", and flashing "tap to begin" at
  // someone half a second before it starts on its own is worse than silence.
  const [showStartPrompt, setShowStartPrompt] = useState(false);
  const tapCountedRef = useRef(false);
  const [epPos, setEpPos] = useState<{ cur: number; dur: number } | null>(null);
  const [toast, setToast] = useState("");
  const [holdPct, setHoldPct] = useState(0);
  const { canExtendMore, extendTimer, extensionsRef } = useNightExtensions(resume?.extensions ?? 0, persistLive, {
    endTimeRef, pausedRemainingMsRef, totalSecondsRef, setTotalSeconds, restRef,
  }, (m) => flash(m));
  // null until the request settles. false means the browser refused, and the
  // listener needs to know: without it the screen sleeps and a YouTube night
  // simply stops, silently, which is the failure this whole file guards.
  const [screenHeld, setScreenHeld] = useState<boolean | null>(null);

  const peeking = Date.now() < peekUntil;

  useEffect(() => { poolRef.current = pool; }, [pool]);
  useEffect(() => { skipIntroRef.current = skipIntroByFeedId; }, [skipIntroByFeedId]);
  useEffect(() => { feedTitlesRef.current = feedTitles; }, [feedTitles]);
  useEffect(() => { artworkRef.current = artworkByFeedId; }, [artworkByFeedId]);
  useEffect(() => { feedTrimRef.current = feedTrim; }, [feedTrim]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { onEndRef.current = onEnd; }, [onEnd]);
  useEffect(() => { wasVariedRef.current = wasVaried; }, [wasVaried]);

  function flash(message: string) {
    setToast(message);
    setTimeout(() => setToast(""), 4200);
  }

  // The countdown is held by parking the remaining time, exactly as a pause
  // does — so "waiting for a tap" and "paused" cost the listener the same
  // nothing, and neither burns the night's minutes over silence.
  function freezeClock() {
    if (endTimeRef.current !== null && pausedRemainingMsRef.current === null) {
      pausedRemainingMsRef.current = endTimeRef.current - Date.now();
    }
  }

  function unfreezeClock() {
    if (pausedRemainingMsRef.current !== null) {
      endTimeRef.current = Date.now() + pausedRemainingMsRef.current;
      pausedRemainingMsRef.current = null;
    }
  }

  // Every state event, as YouTubeMedia hands it over (it has already let its
  // switch guard see the event). Routed as the guard reads it: the event's own
  // state, except during a switch, when it may be the previous video's (a
  // PLAYING that would mark the new one played, an ENDED that would skip it).
  function handleStateEvent(raw: number) {
    // Narrows the ref (endSession nulls it); YouTubeMedia also ignores events
    // once destroyed.
    if (!mediaRef.current) return;
    mediaRef.current.routeStateEvent(raw, {
      transport: setTransport,
      playing: () => {
        netHoldRef.current.cancel(); // sound: the network is evidently fine
        witnessRef.current.markPlayed();
        markPlayed();
        // The clock starts here, not at mount. It is held frozen until
        // something actually plays, so a night that never got its tap does
        // not run its timer down over silence.
        unfreezeClock();
      },
      paused: freezeClock,
    });
  }

  function startEpisode(ep: Episode, seekTo = 0) {
    netHoldRef.current.cancel(); // a new episode: any wait was for the last one
    const media = mediaRef.current;
    if (!media || !ep.youtubeId) return;
    setNowPlaying({ id: ep.id, title: ep.title, feedId: ep.feedId });
    setPlayed(new Set(playedIdsRef.current).add(ep.id));
    currentEpRef.current = ep;
    currentFeedRef.current = ep.feedId;
    // The rest session infers WHEN sleep began; only the player knows WHAT was
    // playing. Told here rather than reconstructed later, because the play
    // ledger de-duplicates by episode id and cannot answer this for any night
    // but the most recent.
    restRef.current?.noteEpisode(ep.feedId, ep.id);
    retriesRef.current = 0;
    // Nothing is known about the new video yet. Carrying the last one's state
    // across would label a loading video "playing".
    setTransport("buffering");
    setShowStartPrompt(false);

    // A saved position further along wins over skip-intro; one near the
    // start (a revive from a snapshot a second in) still gets it, as in Player.
    const skipSec = (skipIntroRef.current[ep.feedId] ?? 0) * 60;
    const start = startWithSkip(seekTo, skipSec);
    // A saved position means it was already being listened to: an early end
    // is then a finish, not a failure (see decideAfterEnded).
    witnessRef.current.newEpisode(start, Date.now(), seekTo > 0);
    media.load(ep.youtubeId, start);

    watchRef.current = { id: ep.id, at: Date.now() };
    heardSecRef.current = 0;
    lastPosRef.current = start; // so the jump to `start` is not counted as listening
    heardSavedAtRef.current = -1e9;
    epStartedAtRef.current = Date.now();

    publishLockScreenMetadata(ep.title, feedTitlesRef.current[ep.feedId], artworkRef.current[ep.feedId]);
    // And a snapshot now, at its start (see counterAfterStartSnapshot).
    persistCounterRef.current = counterAfterStartSnapshot(persistLive());
  }

  /** `byListener`: Next or "never again" led here, so ending a never-played
   *  night is the listener's choice, not the app giving up (see recordNightEnd).
   *  Only an end their action causes at once counts: one that fails later
   *  (an error after load) is the app giving up, and keeps the snapshot. */
  function playNext(byListener = false) {
    const ep = nextPlayable(
      poolRef.current,
      deadRef.current,
      currentEpRef.current?.id ?? null,
      getPlays(),
      Math.random,
      shuffle.weightOf,
    );
    // Nothing left that can play. Ending is the honest outcome: continuing
    // would be an hour of black screen with the timer running down.
    if (!ep) {
      endSession("ended", { gaveUp: !byListener });
      return;
    }
    startEpisode(ep);
  }

  function handleEnded() {
    // Always set: handleEnded is only reachable once startEpisode has set the
    // current episode (its handlers are subscribed there). Narrows the type.
    const done = currentEpRef.current;
    if (!done) return;
    const w = witnessRef.current;
    applyEndedDecision(
      decideAfterEnded({
        stopping: stopFadeRef.current !== null,
        active: tickHandleRef.current !== null,
        playedThisEpisode: w.heard,
        replayedFromStart: w.replayed,
        mode: modeRef.current.kind,
      }),
      {
        replay: () => void replayFromStart(),
        endNight: (reason) => endSession(reason),
        skipDead: () => {
          // Counted like the watchdog's kills, so a lineup that all ends
          // unheard stops after a few rather than flickering through them all.
          if (!countFailure()) skipDead(done, "that one ended before it played", false);
        },
        next: () => playNext(),
        forgetPosition: () => forgetPosition(done.id),
      },
    );
  }

  function handleError(code: number, info: ErrorInfo) {
    const ep = currentEpRef.current;
    if (!ep?.youtubeId || tickHandleRef.current === null) return;
    // Offline, every video fails: that says nothing about this one.
    if (isOffline()) {
      holdForNetwork(ep);
      return;
    }
    const decision = decideAfterError(code, retriesRef.current);
    if (decision.action === "retry") {
      // Counted even when uncertain: a retry reloads (a new switch), so an
      // error that always lands mid-switch would otherwise retry forever.
      retriesRef.current++;
      // Where it was, if it ever played, else where it was meant to start (a
      // revived position, the skip-intro): reloading at 0 restarted a
      // four-hour video mid-night, and a position read before it played may
      // not be its. Until the reload plays, no periodic snapshot.
      const w = witnessRef.current;
      reloadAt(ep, w.resumeAt(mediaRef.current?.currentTime() ?? 0));
      return;
    }
    // Never permanent if it arrived mid-switch: it may be the previous video's
    // (see YouTubeMedia's onError). Skipped tonight, not condemned for good.
    skipDead(ep, classifyYouTubeError(code).reason, decision.permanent && !info.uncertain);
  }

  /** Retire this episode for tonight and move on, as Night's skipDead does.
   *  `permanent` means it will never play here on any night: remember it the
   *  way "never again" does, so tomorrow does not rediscover it. */
  function skipDead(ep: Episode, reason: string, permanent: boolean, byListener = false) {
    deadRef.current.add(ep.id);
    if (permanent) blockEpisode(ep.id);
    setBlockedTonight((prev) => new Set(prev).add(ep.id));
    flash(reason);
    playNext(byListener);
  }

  function heardTick(cur: number) {
    const ep = currentEpRef.current;
    if (!ep) return;
    const prev = lastPosRef.current;
    lastPosRef.current = cur;
    // The embed seeks to its start itself, in one step (no enforcement).
    heardSecRef.current += heardDelta(prev, cur, false);
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

  function restTick(driver: number, t: Transport | undefined) {
    const r = restRef.current;
    if (!r || pausedRemainingMsRef.current !== null || tickHandleRef.current === null) return;
    // pausedRemainingMsRef is only set in minutes mode. In one-episode and
    // all-night a paused (or never-started) episode kept feeding quiet ticks,
    // and near an episode's end the detector could infer sleep during a pause.
    if (t === "paused" || t === "awaiting-start") return;
    if (Date.now() - lastRestTickRef.current < 15_000) return;
    lastRestTickRef.current = Date.now();
    r.tick({
      now: Date.now(),
      hidden: typeof document !== "undefined" && document.hidden,
      fadingOrDone: driver <= FADE_SECONDS,
    });
  }

  /** Snapshot the night; whether it wrote one. */
  function persistLive(): boolean {
    const media = mediaRef.current;
    const ep = currentEpRef.current;
    if (!media || !ep || tickHandleRef.current === null) return false;
    const remainingMs =
      endTimeRef.current === null
        ? 0
        : pausedRemainingMsRef.current ?? endTimeRef.current - Date.now();
    if (endTimeRef.current !== null && remainingMs <= 0) return false;
    // Only once something has played in this page: before that there is
    // nothing of its own to record, and a revived night's stored snapshot
    // (the one it was revived from) stays as it is, to be revived again.
    // The position is witness.snapshotAt: where it is once heard, else 0 (not
    // a skip-intro start, which a revive would take for listening).
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
      shuffleLeaned: restRef.current?.shuffleLeaned || undefined,
      remainingMs,
      totalSeconds: totalSecondsRef.current,
      position: witnessRef.current.snapshotAt(media.currentTime()),
      current: ep,
      playedIds: [...playedIdsRef.current],
      pool: poolRef.current,
      skipIntroByFeedId: skipIntroRef.current,
      feedTitles: feedTitlesRef.current,
      artworkByFeedId: artworkRef.current,
    });
  }

  // The single interval is the ONLY clock here. A podcast night also rides the
  // audio element's "timeupdate", which keeps firing through a locked screen;
  // an iframe emits no such stream, and a locked screen stops YouTube playback
  // outright anyway. That is why the wake lock is not a nicety on this path.
  function tickGuarded() {
    const now = Date.now();
    if (!shouldTick({
      lastRunAt: lastTickRef.current,
      now,
      minIntervalMs: TICK_MIN_MS,
      sessionActive: tickHandleRef.current !== null,
    })) return;
    lastTickRef.current = now;
    tick();
  }

  function tick() {
    const media = mediaRef.current;
    if (!media) return;

    const kind = modeRef.current.kind;
    const remaining =
      kind === "minutes"
        ? (pausedRemainingMsRef.current ?? endTimeRef.current! - Date.now()) / 1000
        : Infinity;
    if (remaining <= 0) {
      endSession();
      return;
    }

    // Reconcile with what the player says it is doing. onStateChange is the
    // fast path, but a state that changed while this component was mid-render
    // — or an event that simply never arrived — would otherwise leave the
    // transport asserting something stale for the rest of the night.
    const ytState = media.state();
    const t = transportFor(ytState);
    // A missed PLAYING event must not leave the clock frozen over a video that
    // is audibly playing (the tap no longer unfreezes it). Movement decides
    // (lib/witness.ts); once seen, the same as onStateChange's PLAYING. One
    // position read per tick, for this and everything below.
    const cur = media.currentTime();
    const wasPlayed = witnessRef.current.played;
    const played = witnessRef.current.observe(cur, Date.now(), t === "playing");
    if (played && !wasPlayed) {
      netHoldRef.current.cancel(); // sound: the network is fine
      markPlayed();
    }
    if (t === "playing" && played) unfreezeClock();
    // And the other way, as Night's tick does: a PAUSED event that arrived
    // during a switch reads unstarted and is dropped, so the clock would
    // otherwise run on over a paused video.
    else if (t === "paused") freezeClock();
    // Shown as witnessed, not as reported, as in Night: a "playing" over a
    // video that hasn't made a sound offered Pause, and a tap then paused the
    // new video instead of starting it.
    setTransport(t === "playing" && !played ? "buffering" : t);
    // watchRef.at is when this episode was asked to play, and it is cleared
    // the moment it does — so this is exactly "how long it has refused for".
    const waitedMs = watchRef.current ? Date.now() - watchRef.current.at : 0;
    const needsTap = t === "awaiting-start" && waitedMs > START_PROMPT_MS;
    // Counted once per night. Whether the embed ever autoplays is the open
    // question this feature shipped with, and it cannot be answered from
    // outside the device.
    if (needsTap && !tapCountedRef.current) {
      tapCountedRef.current = true;
      beacon("youtube_tap_start");
    }
    setShowStartPrompt(needsTap);

    const dur = media.duration();
    // Started within 30 s of its end (a skip-intro nearly as long as the
    // episode): play it whole, as Player.tsx does, rather than let the
    // listener catch only its last seconds. See shouldPlayWhole.
    // Only returns if it did reload: a failed replay must not stall every tick.
    if (shouldPlayWhole(witnessRef.current, dur) && replayFromStart()) return;
    const span = witnessRef.current.shownSpan(cur, media.seeking(), dur);
    const epRemaining = remainingOf(span);
    const driver = fadeDriverSeconds(kind, remaining, epRemaining);

    restTick(driver, t);
    heardTick(cur);

    // The courtesy fade owns the volume while it runs; reassigning here would
    // fight it back up and produce audible stabs on the way out.
    if (stopFadeRef.current === null) {
      // With no fade underway (driver Infinity) this is the feed's trim alone.
      // A hard 1 played turned-down feeds at full volume in all-night mode.
      media.setVolume(effectiveVolume(driver, FADE_SECONDS, feedTrimRef.current[currentFeedRef.current ?? ""] ?? 1.0));
      // Silent while nothing plays: left at full level, the noise ran on under
      // a pause with the clock frozen, so no fade would ever reach it.
      const silent = t === "paused" || t === "awaiting-start";
      brownRef.current?.setGain(noiseGain(noise.on && !silent ? noise.level : 0, driver, FADE_SECONDS));
    }

    setCountdown(kind === "minutes" ? remaining : 0);
    setEpPos((prev) => barPosition(prev, span));

    const w = watchRef.current;
    if (
      w &&
      shouldGiveUp({
        state: ytState,
        hasEverPlayed: hasEverPlayedRef.current,
        elapsedMs: Date.now() - w.at,
        limitMs: WATCHDOG_MS,
      })
    ) {
      if (isOffline() && currentEpRef.current) {
        // Not stuck: the network is gone. Nothing is condemned or skipped.
        holdForNetwork(currentEpRef.current);
        return;
      }
      watchRef.current = null;
      // Stuck without an error code: a blocked embed that reported nothing, a
      // region lock, a load that never finished. Dead for tonight only — we do
      // not know enough to condemn it forever.
      deadRef.current.add(w.id);
      // Out of the lineup too, or a tap on it replaces what is playing.
      setBlockedTonight((prev) => new Set(prev).add(w.id));
      if (!countFailure()) playNext();
      // cur/dur below belong to the episode just killed, while currentEpRef is
      // now the next one (or the night ended): nothing below concerns it.
      return;
    }

    // Spent only once the episode has played, so a new episode's first
    // periodic snapshot lands as soon as it plays, not ten ticks after a
    // count used up while it was still loading.
    if (++persistCounterRef.current >= SNAPSHOT_EVERY_TICKS && witnessRef.current.played) {
      persistCounterRef.current = 0;
      persistLive();
      if (currentEpRef.current && span) rememberPosition(currentEpRef.current.id, witnessRef.current.resumeAt(cur), span.dur);
    }
  }

  function clearStopFade() {
    if (stopFadeRef.current !== null) {
      clearInterval(stopFadeRef.current);
      stopFadeRef.current = null;
    }
  }

  /** `gaveUp`: the app, not the listener, is ending a night that never
   *  played here (nothing playable, or the error screen). Its snapshot is
   *  kept, so a revived night that failed offline can still be revived. What
   *  a night that never played here records otherwise: see recordNightEnd. */
  function endSession(reason: RestNight["endedVia"] = "faded", { gaveUp = false }: { gaveUp?: boolean } = {}) {
    if (tickHandleRef.current === null && reason !== "ended") return;
    // A night that never played here records what recordNightEnd decides
    // (a fresh one nothing; a revived one the night it continues).
    clearStopFade();
    netHoldRef.current.cancel();
    recordNightEnd({
      reason,
      played: hasEverPlayedRef.current,
      revivedFrom: resume?.savedAt,
      gaveUp: gaveUp,
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
    brownRef.current?.stop();
    endTimeRef.current = null;
    pausedRemainingMsRef.current = null;
    mediaRef.current?.destroy();
    mediaRef.current = null;
    void lockRef.current?.release();
    clearLockScreen();
    onEndRef.current();
  }

  useEffect(() => {
    let cancelled = false;
    endTimeRef.current =
      mode.kind === "minutes"
        ? Date.now() + (resume ? resume.remainingMs : timerMinutes * 60 * 1000)
        : null;
    // Held from the start and released by the first PLAYING. A YouTube night
    // frequently cannot begin without a tap, and a timer that runs during that
    // wait spends the listener's minutes on a still frame.
    pausedRemainingMsRef.current =
      endTimeRef.current === null ? null : endTimeRef.current - Date.now();
    // A revived night continues the one that began before the reload: its
    // time-to-sleep, timeline and snapshots count from the real start, not
    // from the tap on "keep going".
    const nightStart = revivedNightStart(resume?.nightStartedAt, Date.now());
    restRef.current = new RestSession(nightStart, timerMinutes, resume);
    restRef.current.seedInteractions(resume?.interactions ?? 0);
    deadRef.current = new Set(loadBlocked());
    if (resume) {
      setTotalSeconds(resume.totalSeconds);
      setCountdown(Math.max(0, resume.remainingMs / 1000));
      setPlayed(new Set(resume.playedIds));
    }

    const lock = browserScreenLock();
    lockRef.current = lock;
    if (!lock) setScreenHeld(false);
    else void lock.acquire().then((ok) => { if (!cancelled) setScreenHeld(ok); });

    // Every browser revokes a screen wake lock when the tab is hidden and none
    // give it back. Forget it on the way out, ask again on the way in.
    const onVis = () => {
      if (document.hidden) lockRef.current?.forgetHeld();
      else void lockRef.current?.reacquire().then(() => {
        if (!cancelled) setScreenHeld(lockRef.current?.held() ?? false);
      });
    };
    document.addEventListener("visibilitychange", onVis);

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;
        mediaRef.current = new YouTubeMedia(
          (args) => buildYouTubePlayer(YT, hostRef.current!, args, { autoplay: true, shouldStartOnReady: () => true }),
          { onEnded: handleEnded, onError: handleError, onStateEvent: handleStateEvent },
        );
        const first =
          resume?.episode ??
          leadEpisode ??
          nextPlayable(pool, deadRef.current, null, getPlays(), Math.random, shuffle.weightOf);
        if (!first) {
          setStatus("error");
          setErrorText("nothing in this lineup can be played here");
          return;
        }
        setStatus("playing");
        // Once per night, here rather than in startEpisode, which also runs on
        // every Next and would count a lineup instead of a night.
        beacon("youtube_night");
        startEpisode(first, resume ? resume.position : leadEpisode ? leadPosition : 0);
        tickHandleRef.current = setInterval(tickGuarded, 1000);
        if (noise.on) {
          const bn = new BrownNoise();
          brownRef.current = bn;
          void bn.start();
        }
        tick();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setErrorText(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      if (tickHandleRef.current !== null) clearInterval(tickHandleRef.current);
      tickHandleRef.current = null;
      clearStopFade();
      netHoldRef.current.cancel();
      if (holdTimerRef.current) clearInterval(holdTimerRef.current);
      brownRef.current?.stop();
      mediaRef.current?.destroy();
      mediaRef.current = null;
      void lockRef.current?.release();
      clearLockScreen();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** This episode has played: stand the watchdog down and reset the failure
   *  counts. One place for the PLAYING event and the tick's witness. */
  function markPlayed() {
    triedEpRef.current = noteSounded(triedEpRef.current, currentEpRef.current);
    watchRef.current = null;
    failsRef.current = 0;
    retriesRef.current = 0;
    hasEverPlayedRef.current = true;
  }

  /** Count one more consecutive failure. Past MAX_FAILS the whole lineup looks
   *  broken and the night ends; returns whether it did. */
  function countFailure(): boolean {
    failsRef.current++;
    if (failsRef.current <= MAX_FAILS) return false;
    endSession("ended", { gaveUp: true });
    return true;
  }

  /** Play the current episode from 0: it ended without ever being heard, or
   *  its start is within 30 s of its end — most likely started past or near
   *  its end by a skip-intro (see decideAfterEnded). Once per episode. */
  function replayFromStart(): boolean {
    const ep = currentEpRef.current;
    // Counted as the episode's one replay only if it actually reloaded.
    if (!ep || !reloadAt(ep, 0)) return false;
    witnessRef.current.markReplayed();
    retriesRef.current = 0; // a fresh attempt, not the failed load's leftovers
    return true;
  }

  /** Offline: hold the night instead of spending the lineup on a dropped
   *  network (see network-hold). Clock frozen and shown paused, every time,
   *  even when already holding (a tap in the meantime thawed it). When the
   *  network is back, the same episode reloads where it was, or where its
   *  load was meant to start if it never played. */
  function holdForNetwork(ep: Episode) {
    const media = mediaRef.current;
    const at = witnessRef.current.resumeAt(media?.currentTime() ?? 0);
    // Read before pausing: paused already means by the listener (see
    // NetworkHold), and the network coming back then starts nothing.
    const paused = media?.transport() === "paused";
    watchRef.current = null;
    freezeClock();
    media?.pause();
    setTransport("paused");
    netHoldRef.current.hold(
      () => {
        // Not into a night that is ending (a fade-out) or has moved on.
        if (tickHandleRef.current === null || stopFadeRef.current !== null) return false;
        if (currentEpRef.current !== ep) return false;
        return reloadAt(ep, at);
      },
      paused,
    );
  }

  /** Reload the current episode at `at`: a retry, or a replay. The per-load
   *  witness, heard-time baseline and watchdog start over; per-episode state
   *  (heard, replayed) is kept. */
  function reloadAt(ep: Episode, at: number): boolean {
    const media = mediaRef.current;
    const videoId = ep.youtubeId;
    if (!media || !videoId) return false;
    witnessRef.current.reset(at, Date.now());
    lastPosRef.current = at;
    media.load(videoId, at, true); // the same episode again
    watchRef.current = { id: ep.id, at: Date.now() };
    return true;
  }

  // One handler for "start it" and "resume it": both are a tap asking for
  // sound, and the browser treats this tap as the gesture that permits it.
  // Only something playing, or stalled once it has sounded, gets paused
  // (tapPauses).
  function handleTogglePause() {
    restRef.current?.noteInteraction();
    const media = mediaRef.current;
    if (!media) return;
    if (tapPauses(transportRef.current, witnessRef.current.sounded)) {
      media.pause();
      return;
    }
    askForSound();
  }

  /** A request for sound: the toggle's play half. (The embed keeps its own
   *  media session inside the iframe.) */
  function askForSound() {
    const media = mediaRef.current;
    if (!media) return;
    // Held for the network: this retries the reload (see NetworkHold).
    if (netHoldRef.current.resumeNow(true)) return;
    // The clock is not started here. PLAYING starts it (onStateChange, or the
    // tick if that event is missed); a tap during buffering, or one whose
    // play() is refused, would otherwise run the night down over silence.
    const ep = currentEpRef.current;
    if (ep && rearmsWatchdogOnTap(witnessRef.current.played, transportRef.current)) {
      watchRef.current = { id: ep.id, at: Date.now() };
    }
    media.play();
  }

  function handleNext() {
    restRef.current?.noteInteraction();
    const leaving = currentEpRef.current;
    if (leaving) restRef.current?.noteSkip(leaving.feedId);
    playNext(true);
  }

  function handleBlock() {
    const ep = currentEpRef.current;
    if (!ep) return;
    restRef.current?.noteSkip(ep.feedId);
    restRef.current?.noteInteraction();
    forgetPosition(ep.id);
    // The listener's own choice: permanent, and a never-played night it ends
    // is ended by the listener, not the app giving up (see playNext's
    // byListener and recordNightEnd).
    skipDead(ep, "never again", true, true);
  }

  function holdEndStart() {
    // A second press (another finger, a pointerdown with no pointerup) must
    // not orphan the first timer: nothing could cancel it, and it went on to
    // end the night the listener had let go of.
    holdEndCancel();
    let pct = 0;
    holdTimerRef.current = setInterval(() => {
      pct += 8;
      setHoldPct(pct);
      if (pct < 100) return;
      holdEndCancel();
      const media = mediaRef.current;
      if (modeRef.current.kind === "minutes" || stopFadeRef.current !== null || !media) {
        endSession("ended");
        return;
      }
      // Timerless modes have had no fade at all, so a bare stop is a hard cut
      // in a dark room. Five seconds of ramp is the difference between "ended"
      // and "yanked".
      const t0 = Date.now();
      stopFadeRef.current = setInterval(() => {
        const left = 5000 - (Date.now() - t0);
        if (left <= 0 || !mediaRef.current) {
          clearStopFade();
          endSession("ended");
          return;
        }
        const trim = feedTrimRef.current[currentFeedRef.current ?? ""] ?? 1.0;
        mediaRef.current.setVolume(effectiveVolume(left / 1000, 5, trim));
        brownRef.current?.setGain(noiseGain(noise.on ? noise.level : 0, left / 1000, 5));
      }, 100);
    }, 80);
  }

  function holdEndCancel() {
    if (holdTimerRef.current) clearInterval(holdTimerRef.current);
    holdTimerRef.current = null;
    setHoldPct(0);
  }

  const countdownStr = formatTime(countdown);
  const dim = Math.max(0.55, 1 - 0.45 * (1 - countdown / Math.max(1, totalSeconds)));
  const visible = pool.filter((e) => !blockedTonight.has(e.id));

  return (
    <div className="relative min-h-dvh flex flex-col items-center px-6 py-10">
      <div className="player-ambient" aria-hidden="true">
        <div className="glow g1"></div>
        <div className="glow g2"></div>
        <div className="night-stars" style={{ opacity: 0.22 }}></div>
      </div>

      <div className="relative z-10 w-full max-w-sm space-y-8 text-center dream-sink" style={{ opacity: dim }}>
        {/* The video. It stays on screen and it stays visible: hiding Google's
            player is against the terms this feature depends on. Dimming it is
            not hiding it — it is the same thing as turning the brightness
            down, and a bright rectangle at 1am defeats the point. */}
        <div className="relative">
          <div
            ref={hostRef}
            className="aspect-video w-full overflow-hidden rounded-xl border border-[#241f30] bg-black [&_iframe]:h-full [&_iframe]:w-full"
            style={{ filter: `brightness(${(0.35 + 0.4 * dim).toFixed(2)})` }}
          />
          {/* Browsers will not start a video without a gesture, and starting a
              night is not close enough to one by the time Google's script has
              loaded. So the video sits loaded and waiting, and this is the
              gesture. Over the frame rather than below it, because the frame
              is what the eye is already on. */}
          {status === "playing" && showStartPrompt && (
            <button
              onClick={handleTogglePause}
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-black/70 text-[#f0dcb8]"
            >
              <span className="text-4xl leading-none">▶</span>
              <span className="text-sm">tap to begin</span>
              <span className="max-w-[16rem] text-[11px] leading-snug text-[#8a7a5c]">
                your browser won&apos;t start a video on its own. the timer
                hasn&apos;t started either — it waits for this.
              </span>
            </button>
          )}
        </div>

        {status === "loading" && (
          <p className="text-sm text-[#6e5d44]">bringing up the player…</p>
        )}
        {status === "error" && (
          <div className="space-y-2">
            <p className="text-sm text-[#d9c9a8]">the video player didn&apos;t start.</p>
            <p className="text-xs text-[#8a7a5c]">{errorText}</p>
            <button
              onClick={() => endSession("ended", { gaveUp: true })}
              className="rounded-full border border-[#6e5d44] px-4 py-1.5 text-xs text-[#f0dcb8]"
            >
              back to setup
            </button>
          </div>
        )}

        {status === "playing" && (
          <>
            {/* Countdown — veiled until tapped, same as a podcast night. */}
            <div>
              <div className="relative inline-block">
                <div className="player-moon-halo" aria-hidden="true"></div>
                <button
                  onClick={() => setPeekUntil(Date.now() + 4000)}
                  aria-label={
                    mode.kind === "minutes"
                      ? `time left ${countdownStr} — tap to peek`
                      : mode.kind === "one-episode"
                        ? "playing one video"
                        : "playing all night"
                  }
                  className="relative font-mono font-light tabular-nums text-[#c8c0b0]"
                >
                  {mode.kind === "minutes" && peeking
                    ? <span className="text-5xl">{countdownStr}</span>
                    : <span className="player-moon text-4xl">☾</span>}
                </button>
              </div>
              <div className="mt-2 flex items-center justify-center gap-3 text-xs uppercase tracking-widest text-[#6b6558]">
                <span>
                  {mode.kind === "one-episode"
                    ? "one video"
                    : mode.kind === "all-night"
                      ? "all night"
                      : peeking
                        ? "remaining"
                        : "sleeping"}
                </span>
                {/* Only a timed night has a timer to stretch; elsewhere the
                    button spent an extension and changed nothing. */}
                {mode.kind !== "minutes" ? null : canExtendMore ? (
                  <button
                    onClick={() => extendTimer(15)}
                    className="rounded-full border border-[#2e2d3a] px-3 py-1 normal-case tracking-normal text-[#7a7264] active:scale-95"
                  >
                    a little longer
                  </button>
                ) : (
                  <span className="px-3 py-1 normal-case tracking-normal text-[#4a4540]">
                    it isn&apos;t the timer
                  </span>
                )}
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

            <div className="space-y-1 min-h-[3rem]">
              {nowPlaying ? (
                <>
                  <div className="line-clamp-2 text-base leading-snug text-[#b0a898]">
                    {nowPlaying.title}
                  </div>
                  <div className="text-xs text-[#4a4540]">
                    {feedTitles[nowPlaying.feedId] ?? nowPlaying.feedId}
                  </div>
                  {epPos && (
                    <div className="pt-2">
                      <div className="ep-progress">
                        <span style={{ width: `${Math.min(100, (epPos.cur / epPos.dur) * 100)}%` }} />
                      </div>
                      {/* Veiled with the moon and for the same reason: elapsed
                          time tells you how long you have been lying here
                          awake, which is the arithmetic the moon prevents. */}
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

            {/* Transport. No scrub bar and no ±30s: the embed's seek is a
                round trip to Google's player and a sleepy thumb landing badly
                costs a reload of the whole video, not a jump. */}
            <div className="space-y-4">
              <div className="flex items-center justify-center gap-6">
                <button
                  onClick={handleTogglePause}
                  className="h-24 w-24 rounded-full border border-[#2e2d3a] bg-[#1a1b26] text-sm font-medium text-[#c8c0b0] transition-transform active:scale-95"
                  aria-label={
                    tapPauses(transport, witnessRef.current.sounded)
                      ? "Pause"
                      : transport === "awaiting-start"
                        ? "Start"
                        : "Resume"
                  }
                >
                  {transport === "playing"
                    ? "Pause"
                    : transport === "paused"
                      ? "Resume"
                      : transport === "awaiting-start"
                        ? "Play"
                        : "…"}
                </button>
              </div>
              <div className="flex items-center justify-center gap-6">
                <button
                  onClick={handleNext}
                  className="h-16 w-16 rounded-full border border-[#2e2d3a] bg-[#1a1b26] text-xs font-medium text-[#c8c0b0] transition-transform active:scale-95"
                  aria-label="Next video"
                >
                  Next
                </button>
                <button
                  onPointerDown={holdEndStart}
                  onPointerUp={holdEndCancel}
                  onPointerLeave={holdEndCancel}
                  onContextMenu={(e) => e.preventDefault()}
                  className="hold-ring h-16 w-16 touch-none select-none rounded-full border border-[#2e2d3a] bg-[#1a1b26] text-xs font-medium text-[#6b6558]"
                  style={{ "--hold": holdPct } as React.CSSProperties}
                  aria-label="Hold to end session"
                >
                  {holdPct > 0 ? "hold…" : "End"}
                </button>
              </div>
            </div>

            {/* The two things a YouTube night cannot do anything about, said
                once, plainly, where they matter. */}
            <div className="space-y-1 text-[11px] leading-relaxed text-[#4a4540]">
              <p>
                this plays through Google&apos;s player, so it may show ads. we
                can&apos;t mute or skip them.
              </p>
              {screenHeld === false && (
                <p className="text-[#8a7a5c]">
                  this browser won&apos;t let us hold the screen awake — set your
                  screen timeout to never, or the video stops when it sleeps.
                </p>
              )}
            </div>

            {visible.length > 0 && visible.length <= LINEUP_MAX && (
              <div className="space-y-1.5 text-left">
                <div className="pb-1 text-center text-xs uppercase tracking-widest text-[#4a4540]">
                  tonight&apos;s spread
                </div>
                {visible.map((ep) => {
                  const isNow = nowPlaying?.id === ep.id;
                  const wasPlayed = playedIds.has(ep.id) && !isNow;
                  return (
                    <div
                      key={ep.id}
                      onClick={() => {
                        if (!isNow) {
                          restRef.current?.noteInteraction();
                          startEpisode(ep);
                        }
                      }}
                      className={`flex cursor-pointer items-baseline gap-2 text-sm leading-snug transition-opacity duration-700 ${
                        isNow ? "text-[#c8c0b0]" : wasPlayed ? "text-[#4a4540] opacity-70" : "text-[#7a7264]"
                      }`}
                    >
                      <span className="w-3 shrink-0 text-xs">{isNow ? "♪" : wasPlayed ? "·" : ""}</span>
                      <span className="line-clamp-1 flex-1">{ep.title}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
