// A night that can change what is making the sound.
//
// Grown from YouTubeNight.tsx, which plays a night out of Google's embedded
// player alone. Everything about the shape of a night is the same — countdown,
// fade, sleep ledger, live snapshot, wake lock, hold-to-end, the spread. The
// one difference is that the source of sound is now a MediaBackend chosen per
// episode, so a lineup holding both podcasts and videos plays end to end
// instead of being refused.
//
// Both backends exist for the whole night and neither is torn down between
// episodes:
//
//   - The <audio> element is cheap and idle when nothing points at it.
//   - The iframe is NOT cheap to recreate, and recreating it is not the real
//     cost: starting a night is a user gesture, and that gesture is what buys
//     the session its permission to play video. Destroying the player throws
//     that permission away, and the next video asks for a tap at 3am. So the
//     player is built once and merely hidden while a podcast plays.
//
// The rules the single-source nights taught us, carried over intact:
//
//   - A night must never stall. An episode that will not start is dead for
//     tonight and the night moves on; silence with the countdown running is
//     the worst failure this app has.
//   - Nothing here mutes, skips or hides a YouTube ad. That would be
//     circumvention rather than a feature, so the night says up front that ads
//     can happen, and Google's player is visible whenever it is playing.
//   - The wake lock is held for the whole night, not only while video plays.
//     An episode boundary can land on a video at any hour, and a lock asked
//     for at that moment would be asked for without a gesture behind it.
//
// What this deliberately does NOT carry over from Player.tsx: the drift game,
// the opt-in quarter-hour rule, the loudness compressor (it cannot capture an
// iframe, and attaching it is a one-way door), and the CORS-bad/CORS-good feed
// sets.

import { useEffect, useRef, useState } from "react";
import { useLazyRef } from "../lib/use-lazy-ref";
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
} from "../lib/store";
import { HEARD_SEC } from "../lib/plays";
import { BrownNoise, noiseGain } from "../lib/noise";
import { shouldTick } from "../lib/tick-gate";
import { RestSession, revivedNightStart } from "../lib/rest/session";
import { recordNightEnd } from "../lib/night-end";
import { NetworkHold, isOffline } from "../lib/network-hold";
import { heardDelta } from "../lib/heard";
import { clearLockScreen, publishLockScreenMetadata, setActionHandlers } from "../lib/lock-screen";
import { startWithSkip } from "../lib/skip-intro";
import { PlaybackWitness, rearmsWatchdogOnTap, tapPauses } from "../lib/witness";
import { applyEndedDecision, decideAfterEnded, shouldPlayWhole } from "../lib/episode-end";
import type { RestNight } from "../lib/rest/types";
import { YouTubeMedia } from "../lib/youtube-media";
import { buildYouTubePlayer } from "../lib/youtube-embed";
import { loadYouTubeApi } from "../lib/youtube-api";
import type { ErrorInfo, MediaBackend, Transport } from "../lib/media/backend";
import { AudioBackend } from "../lib/media/audio-backend";
import { preferVideoLead } from "../lib/mixed-night";
import {
  nextPlayable,
  decideAfterError,
  shouldGiveUp,
  YT_STATE,
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

/**
 * A transport expressed as the YT state code shouldGiveUp reads.
 *
 * The watchdog's rule is worth keeping for both backends — an episode that
 * will not start must not hold the night — but it was written against YT's
 * numbers and is tested against them, so the transport is translated rather
 * than the rule rewritten. "dead" maps to ENDED because that is what it is:
 * no tap will revive a destroyed backend, so give up on it.
 */
function ytStateOf(t: Transport): number {
  switch (t) {
    case "playing":
      return YT_STATE.PLAYING;
    case "paused":
      return YT_STATE.PAUSED;
    case "awaiting-start":
      return YT_STATE.UNSTARTED;
    case "dead":
      return YT_STATE.ENDED;
    default:
      return YT_STATE.BUFFERING;
  }
}

export interface NightProps {
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
}

export function Night({
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
}: NightProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Both backends live for the whole night; `liveRef` is whichever one the
  // current episode picked, and every command goes through it. `offRef` holds
  // that backend's unsubscribes so they can be torn off before the next one
  // subscribes — a handler that outlives its backend fires against a dead one.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioBackendRef = useRef<AudioBackend | null>(null);
  const ytRef = useRef<YouTubeMedia | null>(null);
  const liveRef = useRef<MediaBackend | null>(null);
  const offRef = useRef<Array<() => void>>([]);
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
  /** The last episode that actually played tonight (see NightEnd.lastHeard). */
  const lastHeardEpRef = useRef<Episode | null>(null);
  const currentFeedRef = useRef<string | null>(null);
  // Everything known not to play: blocked across nights (the uploader disabled
  // embedding, the video is gone) plus whatever failed tonight.
  const deadRef = useRef<Set<string>>(new Set());
  const retriesRef = useRef(0);
  const watchRef = useRef<{ id: string; at: number } | null>(null);

  const heardSecRef = useRef(0);
  const lastPosRef = useRef(0);
  /** Whether the backend was enforcing its start seek at the last tick. */
  const wasSeekingRef = useRef(false);
  // Whether this episode has actually made a sound (lib/witness.ts). The
  // watchdog needs to tell "playing" from "claims to be playing", and movement
  // is the only honest signal: where the episode was ASKED to start is not
  // where it necessarily is, because the start seek may not have landed yet
  // (or ever: it gives up after a few tries).
  const witnessRef = useLazyRef(() => new PlaybackWitness());
  /** Waiting out a dropped network (see holdForNetwork). */
  const netHoldRef = useLazyRef(() => new NetworkHold());
  /** The latest askForSound(), for handlers registered once at mount. */
  const askForSoundRef = useRef<() => void>(() => {});
  // The fade factor last applied to the live backend, before per-feed trim
  // (the night's fade, or the courtesy fade). A backend that becomes live is
  // set to it times its own episode's trim at once, rather than playing at
  // whatever it was last given, possibly hours ago, until a tick.
  const levelRef = useRef<number | null>(null);
  const heardSavedAtRef = useRef(-1e9);
  const epStartedAtRef = useRef(0);
  const persistCounterRef = useRef(0);
  const playedIdsRef = useRef<ReadonlySet<string>>(new Set());
  const totalSecondsRef = useRef(timerMinutes * 60);

  const restRef = useRef<RestSession | null>(null);
  const lastRestTickRef = useRef(0);
  const brownRef = useRef<BrownNoise | null>(null);

  const [status, setStatus] = useState<"loading" | "playing" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  // `isVideo` rides along because the render needs it every frame to decide
  // whether the iframe is on screen, and looking it up in the pool by id each
  // time would be the same answer computed the long way.
  const [nowPlaying, setNowPlaying] = useState<
    { id: string; title: string; feedId: string; isVideo: boolean } | null
  >(null);
  const [playedIds, setPlayedIds] = useState<ReadonlySet<string>>(new Set());
  const [blockedTonight, setBlockedTonight] = useState<ReadonlySet<string>>(new Set());
  const [countdown, setCountdown] = useState(timerMinutes * 60);
  const [totalSeconds, setTotalSeconds] = useState(timerMinutes * 60);
  const [peekUntil, setPeekUntil] = useState(0);
  // What the player is doing, read from it rather than mirrored. The first
  // version kept a `paused` boolean updated on the three state codes it
  // handled; the other three (unstarted, cued, buffering) left it saying
  // "playing" while nothing played, so a video waiting for a tap rendered a
  // Pause button over silence.
  const [transport, setTransportState] = useState<Transport>("buffering");
  /** The transport as last set, readable outside a render (the media
   *  session's handlers run between them). */
  const transportRef = useRef<Transport>("buffering");
  function setTransport(t: Transport) {
    transportRef.current = t;
    setTransportState(t);
  }
  // Whether anything has played at all this night. Autoplay refusals look
  // exactly like a dead video until you know the answer to this.
  const hasEverPlayedRef = useRef(false);
  // The prompt waits a beat before appearing. A player that is simply still
  // coming up also reads as "unstarted", and flashing "tap to begin" at
  // someone half a second before it starts on its own is worse than silence.
  const [showStartPrompt, setShowStartPrompt] = useState(false);
  const tapCountedRef = useRef(false);
  const [epPos, setEpPos] = useState<{ cur: number; dur: number } | null>(null);
  const [toast, setToast] = useState("");
  const [holdPct, setHoldPct] = useState(0);
  const { canExtendMore, extend, extensionsRef } = useNightExtensions(resume?.extensions ?? 0, persistLive, {
    endTimeRef, pausedRemainingMsRef, totalSecondsRef, setTotalSeconds,
  });
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
  useEffect(() => { playedIdsRef.current = playedIds; }, [playedIds]);
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
    // The player is not destroyed between episodes — it is hidden and paused
    // behind a podcast, and it keeps emitting state changes from there. Acting
    // on them while audio is live would report the video's transport over the
    // podcast's and freeze the countdown over sound that is actually playing.
    // Once both refs are null the player is gone, and "equal" must not read as
    // "still live".
    if (ytRef.current === null || liveRef.current !== ytRef.current) return;
    ytRef.current.routeStateEvent(raw, {
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

  /** Which backend this episode belongs to. `youtubeId` is the only signal —
   *  a YouTube episode's `url` is a watch page no <audio> can stream. */
  function backendFor(ep: Episode): MediaBackend | null {
    return ep.youtubeId ? ytRef.current : audioBackendRef.current;
  }

  function startEpisode(ep: Episode, seekTo = 0) {
    netHoldRef.current.cancel(); // a new episode: any wait was for the last one
    const next = backendFor(ep);
    // No backend for this kind of episode — the IFrame API never loaded and
    // this is a video. Retire it and move on rather than returning: the mount
    // path marks every video dead when the API fails, but relying on that made
    // this function's "a night never stalls" depend on somebody else having
    // been thorough, and playNext()/handleEnded arrive here with nothing
    // playing and nothing that will start. Nothing is detached before this
    // point, so whatever is playing keeps playing until its replacement does.
    if (!next) {
      skipDead(ep, "that one can't be played here", false);
      return;
    }

    // Detach first. A handler that outlives its backend fires against a dead
    // one, and on a mixed night that means the podcast's "ended" advancing a
    // night that has already moved on to a video.
    for (const off of offRef.current.splice(0)) off();
    if (liveRef.current && liveRef.current !== next) liveRef.current.standDown();
    if (levelRef.current !== null && liveRef.current !== next) {
      next.setVolume(Math.min(1, levelRef.current * (feedTrimRef.current[ep.feedId] ?? 1.0)));
    }
    liveRef.current = next;

    offRef.current.push(
      next.onProgress(tickGuarded),
      next.onEnded(handleEnded),
      next.onError(handleError),
    );

    setNowPlaying({ id: ep.id, title: ep.title, feedId: ep.feedId, isVideo: !!ep.youtubeId });
    setPlayedIds((prev) => new Set(prev).add(ep.id));
    currentEpRef.current = ep;
    currentFeedRef.current = ep.feedId;
    // The rest session infers WHEN sleep began; only the player knows WHAT was
    // playing. Told here rather than reconstructed later, because the play
    // ledger de-duplicates by episode id and cannot answer this for any night
    // but the most recent.
    restRef.current?.noteEpisode(ep.feedId, ep.id);
    retriesRef.current = 0;
    // Nothing is known about the new episode yet. Carrying the last one's
    // state across would label a loading episode "playing".
    setTransport("buffering");
    setShowStartPrompt(false);

    // A saved position further along wins over skip-intro; one near the
    // start (a revive from a snapshot a second in) still gets it, as in Player.
    const skipSec = (skipIntroRef.current[ep.feedId] ?? 0) * 60;
    const start = startWithSkip(seekTo, skipSec);
    // A videoId for the embed, an enclosure URL for the element. This is the
    // last place the difference is visible.
    next.load(ep.youtubeId ?? ep.url, start);

    watchRef.current = { id: ep.id, at: Date.now() };
    heardSecRef.current = 0;
    lastPosRef.current = start; // so the jump to `start` is not counted as listening
    wasSeekingRef.current = false; // a new load: the last one's seek is over
    // Seeded with the requested start: if the seek does land, arriving at
    // `start` is not movement and must not read as proof of sound.
    // A saved position means it was already being listened to: an early end
    // is then a finish, not a failure (see decideAfterEnded).
    witnessRef.current.newEpisode(start, Date.now(), seekTo > 0);
    heardSavedAtRef.current = -1e9;
    epStartedAtRef.current = Date.now();

    publishLockScreenMetadata(ep.title, feedTitlesRef.current[ep.feedId], artworkRef.current[ep.feedId]);
    // And a snapshot now, at its start: a kill while it loads must not
    // revive the last one (one just blocked, say). Written, it stands for
    // the first periodic one; not (a fresh night's first episode), the
    // periodic one lands as soon as it plays.
    persistCounterRef.current = persistLive() ? 0 : SNAPSHOT_EVERY_TICKS;
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
        skipDead: () => skipDead(done, "that one ended before it played", false),
        next: () => playNext(),
        forgetPosition: () => forgetPosition(done.id),
      },
    );
  }

  /** Retire this episode for tonight and move on. `permanent` is only ever
   *  true for a verdict that says the episode can never play here — the
   *  ordinary case is dead tonight, eligible again tomorrow. */
  function skipDead(ep: Episode, reason: string, permanent: boolean, byListener = false) {
    deadRef.current.add(ep.id);
    // Permanent means it will never play here on any night — remember it the
    // same way "never again" does, so tomorrow does not rediscover it.
    if (permanent) blockEpisode(ep.id);
    setBlockedTonight((prev) => new Set(prev).add(ep.id));
    flash(reason);
    playNext(byListener);
  }

  /**
   * Two backends fail in two vocabularies, and the shapes are the tell.
   *
   * A number is YouTube's own onError code and keeps the path it always had:
   * classify it, spend a retry if the classifier allows one, otherwise skip.
   *
   * A string is AudioBackend's, and only one of its three matters specially.
   * "autoplay-blocked" is not a verdict on the episode — the browser refused
   * to make sound without a gesture, and it would refuse identically for every
   * other episode in the lineup. Skipping would burn the whole spread in
   * seconds and end a night having played nothing, so the episode keeps its
   * place, its retry budget and its watchdog is stood down; the clock freezes
   * and the transport shows paused, so one tap on Resume restores the night.
   * That is the shape Player.tsx already uses for exactly this case.
   *
   * "play-failed" and "media-error" are ordinary dead-enclosure failures — a
   * 404, a host that stopped answering, a stream that will not decode — and
   * they skip, because a night that sits on one is a night of silence.
   */
  function handleError(code: number | string, info: ErrorInfo) {
    const ep = currentEpRef.current;
    if (!ep || tickHandleRef.current === null) return;
    // Offline, every source fails: that says nothing about this episode.
    if (isOffline() && code !== "autoplay-blocked") {
      holdForNetwork(ep);
      return;
    }

    if (typeof code === "string") {
      if (code === "autoplay-blocked") {
        // Stand the watchdog down: this episode is not stuck, it is waiting,
        // and shouldGiveUp cannot see the difference.
        watchRef.current = null;
        freezeClock();
        setTransport("paused");
        return;
      }
      skipDead(ep, "that one wouldn't play — moving on", false);
      return;
    }

    // Beyond here the code is YouTube's, so the episode must be a video.
    if (!ep.youtubeId) return;
    const decision = decideAfterError(code, retriesRef.current);
    if (decision.action === "retry") {
      // Counted even when uncertain: a retry reloads (a new switch), so an
      // error that always lands mid-switch would otherwise retry forever.
      retriesRef.current++;
      // Where it was, if it ever played, else where it was meant to start (a
      // revived position, the skip-intro): reloading at 0 restarted a long
      // video mid-night, and a position read before it played may not be its.
      const w = witnessRef.current;
      reloadAt(ep, w.resumeAt(liveRef.current?.currentTime() ?? 0));
      return;
    }
    // Never permanent if it arrived mid-switch: it may be the previous video's
    // (see YouTubeMedia's onError). Skipped tonight, not condemned for good.
    skipDead(ep, classifyYouTubeError(code).reason, decision.permanent && !info.uncertain);
  }

  function heardTick(cur: number, seeking: boolean) {
    const ep = currentEpRef.current;
    if (!ep) return;
    const prev = lastPosRef.current;
    lastPosRef.current = cur;
    // The first tick after the seek ended starts the count afresh: its step
    // from the last reading during the seek includes the landing.
    const wasSeeking = wasSeekingRef.current;
    wasSeekingRef.current = seeking;
    heardSecRef.current += heardDelta(prev, cur, seeking || wasSeeking);
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
    const media = liveRef.current;
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
      remainingMs,
      totalSeconds: totalSecondsRef.current,
      // Where the episode is, not a raw reading: the backend may still be
      // enforcing its start seek over Safari's reset (see resumeAt).
      position: witnessRef.current.snapshotAt(media.currentTime()),
      current: ep,
      playedIds: [...playedIdsRef.current],
      pool: poolRef.current,
      skipIntroByFeedId: skipIntroRef.current,
      feedTitles: feedTitlesRef.current,
      artworkByFeedId: artworkRef.current,
    });
  }

  // Two clocks feed this: the one-second interval below, and whatever the live
  // backend calls its progress stream — "timeupdate" for an element, a poll
  // for an iframe. shouldTick collapses them, so an episode that supplies both
  // does not run the night's arithmetic twice a second.
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
    const media = liveRef.current;
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

    // Reconcile with what the live backend says it is doing. Both implement
    // transport(), so this one line covers whichever is playing. The embed's
    // onStateChange is still the fast path; this catches a state that changed
    // mid-render, or an event that simply never arrived, and it is the ONLY
    // path for the audio element, which has no equivalent callback.
    const t = media.transport();
    // "playing" is not proof that sound is coming out. An <audio> element
    // reports itself unpaused the instant play() is called — before a single
    // byte has arrived — so a stream that accepts the connection and then
    // hangs looks exactly like one that is playing. Believing it would stand
    // the watchdog down and leave the night silent with the countdown running,
    // which is the failure everything here exists to prevent. Player.tsx has
    // the "playing" DOM event for this; behind the backend interface there is
    // no such event, so the proof is the position having MOVED.
    //
    // Movement, not position: AudioBackend enforces its start seek (see
    // SeekEnforcer), but Safari resets pre-playback seeks, so the element can
    // play audibly from 0:00 for a moment before being put back on its start,
    // and a stubborn stream makes the seek give up entirely. A predicate
    // written against the asked-for position kills such an episode as stalled
    // while the listener can hear it. The jump back onto the start is a seek,
    // not playback (isPlaybackStep excludes it). A hung
    // enclosure never moves either way, so the hole this guard exists to close
    // stays closed.
    // One position read per tick, for the played decision and everything below.
    const cur = media.currentTime();
    const wasPlayed = witnessRef.current.played;
    const played = witnessRef.current.observe(cur, Date.now(), t === "playing");
    if (played && !wasPlayed) netHoldRef.current.cancel(); // sound: the network is fine
    const witnessed: Transport = t === "playing" && !played ? "buffering" : t;
    // From `witnessed`, not `t`: the raw value exists to be distrusted, and a
    // control reading "Pause" over an episode that has not made a sound yet is
    // the exact class of lie this file is built to avoid.
    setTransport(witnessed);
    if (witnessed === "playing") {
      // The countdown starts at the first real sound, not at mount, so a night
      // still waiting for its tap does not spend its minutes on silence. The
      // embed also does this from onStateChange; both are idempotent.
      markPlayed();
      unfreezeClock();
    } else if (witnessed === "paused") {
      freezeClock();
    }
    // watchRef.at is when this episode was asked to play, and it is cleared
    // the moment it does — so this is exactly "how long it has refused for".
    const waitedMs = watchRef.current ? Date.now() - watchRef.current.at : 0;
    // Only a video can ever ask for a tap here. An audio element reads
    // "paused" before its first play() resolves, never "awaiting-start", and a
    // podcast that was actually refused surfaces through handleError as a
    // frozen clock and a Resume button rather than an overlay on a black
    // rectangle it has nothing to do with.
    const isVideo = !!currentEpRef.current?.youtubeId;
    const needsTap = isVideo && t === "awaiting-start" && waitedMs > START_PROMPT_MS;
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
    heardTick(cur, media.seeking());

    // The courtesy fade owns the volume while it runs; reassigning here would
    // fight it back up and produce audible stabs on the way out.
    if (stopFadeRef.current === null) {
      // With no fade underway (driver Infinity) this is the feed's trim alone.
      // A hard 1 played turned-down feeds at full volume in all-night mode.
      levelRef.current = effectiveVolume(driver, FADE_SECONDS, 1);
      media.setVolume(effectiveVolume(driver, FADE_SECONDS, feedTrimRef.current[currentFeedRef.current ?? ""] ?? 1.0));
      // Silent while nothing plays: left at full level, the noise ran on under
      // a pause with the clock frozen, so no fade would ever reach it.
      const silent = t === "paused" || t === "awaiting-start";
      brownRef.current?.setGain(noiseGain(noise.on && !silent ? noise.level : 0, driver, FADE_SECONDS));
    }

    setCountdown(kind === "minutes" ? remaining : 0);
    setEpPos((prev) => barPosition(prev, span));

    const w = watchRef.current;
    // Known limitation, deliberately not fixed here: shouldGiveUp exempts an
    // unstarted episode while nothing has played yet, because that is what an
    // autoplay refusal looks like and every episode would refuse identically.
    // On a mixed night the lead is a video by design, so an embed that neither
    // plays nor reports an error code is exempt forever — the night holds at
    // "tap to begin" with the clock frozen and never reaches a podcast that
    // would have played. No timer minutes are lost and an awake listener
    // recovers it in two taps (tap to begin, then Next), which is why it is
    // written down rather than traded for the far worse failure the exemption
    // prevents: burning the whole spread in a couple of minutes over a refusal
    // that one tap would have cleared.
    if (
      w &&
      shouldGiveUp({
        state: ytStateOf(witnessed),
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
      // No failure count decides anything here. On an all-video night a run of
      // failures is evidence about the whole lineup; on a mixed one it is
      // evidence about one kind of episode, and the run is close to guaranteed:
      // a condemned video never records a play, so it stays unheard and
      // pickNextEpisode keeps preferring it over podcasts already in the
      // ledger. Counting those and ending the night would throw away the half
      // of the lineup that still works. Termination does not need a counter —
      // every kill adds to deadRef, nextPlayable filters on it, so the alive
      // pool shrinks with each failure and playNext ends the night the moment
      // nothing playable is left.
      playNext();
      // cur/dur below belong to the episode just killed, while currentEpRef is
      // now the next one: saving them would give it the killed one's position.
      return;
    }

    // Periodic snapshots once this episode has made a sound (before, a
    // snapshot can only say where it was meant to start).
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

  /** Both backends, unsubscribed and destroyed. Called from endSession and
   *  from unmount, because either can be the one that actually happens: a
   *  night that ends normally unmounts a moment later, and a night the browser
   *  navigates away from never reaches endSession at all. Both destroys are
   *  idempotent, so running both paths costs nothing. */
  function releaseBackends() {
    for (const off of offRef.current.splice(0)) off();
    audioBackendRef.current?.destroy();
    ytRef.current?.destroy();
    audioBackendRef.current = null;
    ytRef.current = null;
    liveRef.current = null;
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
    releaseBackends();
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
    // Held from the start and released by the first sound. Either backend can
    // be refused its autoplay, and a timer that runs during that wait spends
    // the listener's minutes on a still frame.
    pausedRemainingMsRef.current =
      endTimeRef.current === null ? null : endTimeRef.current - Date.now();
    // A revived night continues the one that began before the reload: its
    // time-to-sleep, timeline and snapshots count from the real start, not
    // from the tap on "keep going".
    const nightStart = revivedNightStart(resume?.nightStartedAt, Date.now());
    restRef.current = new RestSession(nightStart, timerMinutes);
    restRef.current.seedInteractions(resume?.interactions ?? 0);
    deadRef.current = new Set(loadBlocked());
    if (resume) {
      totalSecondsRef.current = resume.totalSeconds;
      setTotalSeconds(resume.totalSeconds);
      setCountdown(Math.max(0, resume.remainingMs / 1000));
      setPlayedIds(new Set(resume.playedIds));
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
    // Lock-screen and headphone play must go through the hold too: the
    // browser's default handler would play() the failed source and the tick
    // would thaw the clock over silence. (A video's embed keeps its own
    // media session inside the iframe, which the default handler can't reach.)
    const clearHandlers = setActionHandlers({
      play: () => {
        restRef.current?.noteInteraction();
        askForSoundRef.current();
      },
      pause: () => {
        restRef.current?.noteInteraction();
        liveRef.current?.pause();
      },
    });

    // The element exists from the first render, so its backend can too. The
    // embed cannot: it needs Google's script.
    audioBackendRef.current = new AudioBackend(audioRef.current!);

    function beginNight(first: Episode | null, position: number) {
      if (!first) {
        setStatus("error");
        setErrorText("nothing in this lineup can be played here");
        return;
      }
      setStatus("playing");
      // Once per night, here rather than in startEpisode, which also runs on
      // every Next and would count a lineup instead of a night. The counter
      // means "a night started on a YouTube lineup", so a lineup with no video
      // in it does not fire it — an existing metric read wrong is worse than
      // one read narrowly.
      if (pool.some((e) => e.youtubeId)) beacon("youtube_night");
      startEpisode(first, position);
      tickHandleRef.current = setInterval(tickGuarded, 1000);
      if (noise.on) {
        const bn = new BrownNoise();
        brownRef.current = bn;
        void bn.start();
      }
      tick();
    }

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;
        // No onEnded/onError constructor handlers: startEpisode subscribes and
        // unsubscribes those per episode, and one wired into the constructor
        // would outlive every switch away from video and fire against a
        // backend that is no longer the one making sound. onStateEvent is the
        // exception, and safe: handleStateEvent returns at once unless video
        // is the live backend.
        ytRef.current = new YouTubeMedia(
          (args) =>
            buildYouTubePlayer(YT, hostRef.current!, args, {
              // Off: onReady starts the video only if it is still the live
              // backend. Autoplay could start it hidden under a podcast.
              autoplay: false,
              // Unless the night already moved on: a Next tapped during the
              // load leaves a podcast playing. The null check is not redundant:
              // releaseBackends() nulls both refs, and "equal" would then be
              // true of nothing at all.
              shouldStartOnReady: () => ytRef.current !== null && liveRef.current === ytRef.current,
            }),
          { onStateEvent: handleStateEvent },
        );
        // A resumed night carries its own episode and keeps it: reviving a
        // night is a deliberate tap, and that tap is itself the gesture the
        // video lead exists to buy.
        //
        // Everything else goes through preferVideoLead, including a supplied
        // one. A lead can arrive from the 3am re-anchor, which picks the first
        // unplayed episode in array order and knows nothing about kinds — take
        // it as given and the night opens on a podcast, the waking gesture is
        // spent on something that never needed it, and the first video switch
        // lands mid-sleep at "awaiting-start" with the autoplay exemption no
        // longer covering it.
        const first =
          resume?.episode ??
          preferVideoLead(leadEpisode, pool, deadRef.current, getPlays());
        // leadPosition is a saved position in the supplied lead and in nothing
        // else, so it only travels with it. When preferVideoLead swapped a
        // video in, the night starts that video from its own beginning rather
        // than dropping into it at a timestamp that belongs to another episode.
        beginNight(
          first,
          resume ? resume.position : first && first.id === leadEpisode?.id ? leadPosition : 0,
        );
      })
      .catch(() => {
        // No IFrame API — offline, blocked, or Google is down. Run the night
        // podcast-only rather than losing it entirely: every video is
        // unplayable, so mark them dead and let nextPlayable route around
        // them. If the lineup was all video there is nothing left, and
        // beginNight says so.
        if (cancelled) return;
        for (const e of pool) if (e.youtubeId) deadRef.current.add(e.id);
        // Out of the lineup too: listed, they looked playable, and a tap
        // replaced the podcast that was playing.
        setBlockedTonight((prev) => {
          const next = new Set(prev);
          for (const e of pool) if (e.youtubeId) next.add(e.id);
          return next;
        });
        const resumable = resume?.episode && !resume.episode.youtubeId ? resume.episode : null;
        const lead = leadEpisode && !leadEpisode.youtubeId ? leadEpisode : null;
        const first =
          resumable ?? lead ?? nextPlayable(pool, deadRef.current, null, getPlays());
        beginNight(first, resumable ? resume!.position : lead ? leadPosition : 0);
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
      releaseBackends();
      void lockRef.current?.release();
      clearLockScreen();
      clearHandlers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** This episode has played: stand the watchdog down and reset the retry
   *  count. One place for the embed's PLAYING event and the tick's witness. */
  function markPlayed() {
    lastHeardEpRef.current = currentEpRef.current;
    watchRef.current = null;
    retriesRef.current = 0;
    hasEverPlayedRef.current = true;
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
    const media = liveRef.current;
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
    const media = liveRef.current;
    if (!media) return false;
    witnessRef.current.reset(at, Date.now());
    lastPosRef.current = at;
    wasSeekingRef.current = false;
    media.load(ep.youtubeId ?? ep.url, at, true); // the same episode again
    watchRef.current = { id: ep.id, at: Date.now() };
    return true;
  }

  // One handler for "start it" and "resume it": both are a tap asking for
  // sound, and the browser treats this tap as the gesture that permits it.
  // Only something playing, or stalled once it has sounded, gets paused (tapPauses).
  // This is also the one tap that clears a blocked podcast autoplay —
  // handleError left the clock frozen and the transport at "paused" for
  // exactly this.
  function handleTogglePause() {
    restRef.current?.noteInteraction();
    const media = liveRef.current;
    if (!media) return;
    if (tapPauses(transportRef.current, witnessRef.current.sounded)) {
      media.pause();
      return;
    }
    askForSound();
  }

  /** A request for sound: the toggle's play half, and the media session's.
   *  Read through askForSoundRef from handlers registered once at mount. */
  function askForSound() {
    const media = liveRef.current;
    if (!media) return;
    // Held for the network: this retries the reload (see NetworkHold).
    if (netHoldRef.current.resumeNow(true)) return;
    // The clock starts when sound is witnessed (the tick, or the embed's
    // PLAYING), not on the tap: a tap during buffering, or on a stream that
    // then hangs, ran the night down over silence.
    const ep = currentEpRef.current;
    if (ep && rearmsWatchdogOnTap(witnessRef.current.played, transportRef.current)) {
      watchRef.current = { id: ep.id, at: Date.now() };
    }
    media.play();
  }
  askForSoundRef.current = askForSound;

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
    // The listener's own choice: permanent, and ending a never-played night
    // here clears its snapshot (see playNext's byListener).
    skipDead(ep, "never again", true, true);
  }

  function extendTimer(minutes: number) {
    restRef.current?.noteInteraction(); // a touch, stretch left or not
    const said = extend(minutes);
    if (said !== null) flash(said);
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
      const media = liveRef.current;
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
        if (left <= 0 || !liveRef.current) {
          clearStopFade();
          endSession("ended");
          return;
        }
        const trim = feedTrimRef.current[currentFeedRef.current ?? ""] ?? 1.0;
        levelRef.current = effectiveVolume(left / 1000, 5, 1);
        liveRef.current.setVolume(effectiveVolume(left / 1000, 5, trim));
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
  const nowPlayingIsVideo = !!nowPlaying?.isVideo;

  return (
    <div className="relative min-h-dvh flex flex-col items-center px-6 py-10">
      <div className="player-ambient" aria-hidden="true">
        <div className="glow g1"></div>
        <div className="glow g2"></div>
        <div className="night-stars" style={{ opacity: 0.22 }}></div>
      </div>

      {/* The podcast side of the night. Rendered unconditionally and never
          moved: AudioBackend holds this exact element for the whole session,
          and a conditional here would hand it a node React had swapped. */}
      <audio ref={audioRef} preload="none" />

      <div className="relative z-10 w-full max-w-sm space-y-8 text-center dream-sink" style={{ opacity: dim }}>
        {/* The video. Whenever it is playing it is on screen and it is
            visible: hiding Google's player is against the terms this feature
            depends on. Dimming is not hiding — it is the brightness knob, and
            a bright rectangle at 1am defeats the point.
            display:none rather than unmounting, and only while a podcast is
            the thing making sound: the player object survives the gap, and
            with it the session's permission to play video, so the next video
            does not ask for a tap at 3am. Nothing here touches ads. */}
        <div className="relative" style={{ display: nowPlayingIsVideo ? "block" : "none" }}>
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
            <p className="text-sm text-[#d9c9a8]">this night didn&apos;t start.</p>
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
                        ? "playing one episode"
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
                    ? "one episode"
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
                  aria-label="Next episode"
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

            {/* The two things a night with video in it cannot do anything
                about, said once, plainly, where they matter. The ad notice
                stands the moment the lineup holds a video, not only while one
                is on screen — it is what the listener is agreeing to for the
                whole night. */}
            <div className="space-y-1 text-[11px] leading-relaxed text-[#4a4540]">
              {pool.some((e) => e.youtubeId) && (
                <p>
                  the videos here play through Google&apos;s player, so they may
                  show ads. we can&apos;t mute or skip them.
                </p>
              )}
              {/* Gated on the lineup holding a video for the same reason the
                  ad notice is: a podcast keeps playing through a sleeping
                  screen, so on an all-audio lineup this warning would be
                  alarming and untrue. */}
              {screenHeld === false && pool.some((e) => e.youtubeId) && (
                <p className="text-[#8a7a5c]">
                  this browser won&apos;t let us hold the screen awake — set your
                  screen timeout to never, or video stops when it sleeps.
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
