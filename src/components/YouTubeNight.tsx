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
import type { Episode, PlayMode } from "../lib/engine";
import { formatTime, effectiveVolume, fadeDriverSeconds } from "../lib/engine";
import {
  getPlays,
  recordHeardPlay,
  saveLive,
  clearLive,
  saveLastEpisode,
  saveLastNight,
  rememberPosition,
  forgetPosition,
  blockEpisode,
  loadBlocked,
  recordSessionEnd,
  type NoiseSettings,
} from "../lib/store";
import { HEARD_SEC } from "../lib/plays";
import { canExtend } from "../lib/timer-feel";
import { BrownNoise, noiseGain } from "../lib/noise";
import { shouldTick } from "../lib/tick-gate";
import { RestSession } from "../lib/rest/session";
import { appendNight } from "../lib/rest/ledger";
import type { RestNight } from "../lib/rest/types";
import {
  YouTubeMedia,
  YT_EMBED_HOST,
  type YTPlayerLike,
  type CreatePlayerArgs,
} from "../lib/youtube-media";
import { loadYouTubeApi, type YTNamespace } from "../lib/youtube-api";
import {
  nextPlayable,
  decideAfterError,
  transportFor,
  shouldGiveUp,
  YT_STATE,
  type Transport,
} from "../lib/youtube-night";
import { classifyYouTubeError } from "../lib/youtube-errors";
import { browserScreenLock, type ScreenLock } from "../lib/wake-lock";

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
  resume?: {
    episode: Episode;
    position: number;
    remainingMs: number;
    totalSeconds: number;
    playedIds: string[];
  } | null;
  leadEpisode?: Episode | null;
  leadPosition?: number;
  wasVaried?: boolean;
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
}: YouTubeNightProps) {
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
  const playedIdsRef = useRef<ReadonlySet<string>>(new Set());
  const totalSecondsRef = useRef(timerMinutes * 60);

  const restRef = useRef<RestSession | null>(null);
  const lastRestTickRef = useRef(0);
  const brownRef = useRef<BrownNoise | null>(null);

  const [status, setStatus] = useState<"loading" | "playing" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const [nowPlaying, setNowPlaying] = useState<{ id: string; title: string; feedId: string } | null>(null);
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
  const [transport, setTransport] = useState<Transport>("buffering");
  // Whether anything has played at all this night. Autoplay refusals look
  // exactly like a dead video until you know the answer to this.
  const hasEverPlayedRef = useRef(false);
  // The prompt waits a beat before appearing. A player that is simply still
  // coming up also reads as "unstarted", and flashing "tap to begin" at
  // someone half a second before it starts on its own is worse than silence.
  const [showStartPrompt, setShowStartPrompt] = useState(false);
  const [epPos, setEpPos] = useState<{ cur: number; dur: number } | null>(null);
  const [toast, setToast] = useState("");
  const [holdPct, setHoldPct] = useState(0);
  const [extensions, setExtensions] = useState(0);
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

  // YT.Player REPLACES the element it is handed with an iframe. So it is given
  // a plain div created here rather than one React rendered — React never
  // knows about the node, and cannot trip over a child that vanished from
  // under it.
  function buildPlayer(YT: YTNamespace, args: CreatePlayerArgs): YTPlayerLike {
    const mount = document.createElement("div");
    hostRef.current!.appendChild(mount);
    const player = new YT.Player(mount, {
      host: YT_EMBED_HOST,
      videoId: args.videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: 1,
        playsinline: 1,
        // No chrome to catch a sleepy thumb, no related-video grid at the end,
        // no keyboard, no annotations. The transport below is the transport.
        controls: 0,
        disablekb: 1,
        fs: 0,
        rel: 0,
        iv_load_policy: 3,
        modestbranding: 1,
        start: Math.floor(args.startSeconds ?? 0),
        origin: typeof location === "undefined" ? undefined : location.origin,
      },
      events: {
        onReady: (e: { target: YTPlayerLike }) => {
          args.onReady();
          // Starting a night IS a user gesture, but Google's script has to
          // load first and that gap routinely outlives the gesture's grace on
          // a phone. Ask anyway — and when the answer is no, the video sits at
          // "unstarted" and the tap prompt takes over. It is not an error and
          // must not be treated as one.
          e.target.playVideo();
        },
        onStateChange: (e: { data: number }) => {
          setTransport(transportFor(e.data));
          if (e.data === YT_STATE.PLAYING) {
            watchRef.current = null;
            failsRef.current = 0;
            retriesRef.current = 0;
            hasEverPlayedRef.current = true;
            // The clock starts here, not at mount. It is held frozen until
            // something actually plays, so a night that never got its tap does
            // not run its timer down over silence.
            unfreezeClock();
          } else if (e.data === YT_STATE.PAUSED) {
            freezeClock();
          } else if (e.data === YT_STATE.ENDED) {
            args.onEnded();
          }
        },
        onError: (e: { data: number }) => args.onError(e.data),
      },
    });
    return player as unknown as YTPlayerLike;
  }

  function startEpisode(ep: Episode, seekTo = 0) {
    const media = mediaRef.current;
    if (!media || !ep.youtubeId) return;
    setNowPlaying({ id: ep.id, title: ep.title, feedId: ep.feedId });
    setPlayedIds((prev) => new Set(prev).add(ep.id));
    currentEpRef.current = ep;
    currentFeedRef.current = ep.feedId;
    retriesRef.current = 0;
    // Nothing is known about the new video yet. Carrying the last one's state
    // across would label a loading video "playing".
    setTransport("buffering");
    setShowStartPrompt(false);

    // A saved position is already past any intro, so it wins over skip-intro.
    const skipSec = (skipIntroRef.current[ep.feedId] ?? 0) * 60;
    const start = seekTo > 0 ? seekTo : skipSec;
    media.load(ep.youtubeId, start);

    watchRef.current = { id: ep.id, at: Date.now() };
    heardSecRef.current = 0;
    lastPosRef.current = start; // so the jump to `start` is not counted as listening
    heardSavedAtRef.current = -1e9;
    epStartedAtRef.current = Date.now();
    persistCounterRef.current = 10; // snapshot promptly, not up to 10s from now

    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      const art = artworkRef.current[ep.feedId];
      navigator.mediaSession.metadata = new MediaMetadata({
        title: ep.title,
        artist: feedTitlesRef.current[ep.feedId] ?? "sleepcast",
        album: "sleepcast",
        ...(art ? { artwork: [{ src: art, sizes: "512x512" }] } : {}),
      });
    }
  }

  function playNext() {
    const ep = nextPlayable(
      poolRef.current,
      deadRef.current,
      currentEpRef.current?.id ?? null,
      getPlays(),
    );
    // Nothing left that can play. Ending is the honest outcome: continuing
    // would be an hour of black screen with the timer running down.
    if (!ep) {
      endSession("ended");
      return;
    }
    startEpisode(ep);
  }

  function handleEnded() {
    const done = currentEpRef.current;
    if (done) forgetPosition(done.id);
    if (stopFadeRef.current !== null) {
      // The listener already asked to stop and the video happened to run out
      // underneath the courtesy fade. Starting another would resurrect a night
      // they just ended.
      endSession("ended");
      return;
    }
    if (tickHandleRef.current === null) return;
    // One-episode mode means one episode. Player.tsx plays on here, which
    // looks like an oversight rather than a decision — but that is its bug to
    // fix on its own path, not something to replicate for symmetry.
    if (modeRef.current.kind === "one-episode") {
      endSession("faded");
      return;
    }
    playNext();
  }

  function handleError(code: number) {
    const ep = currentEpRef.current;
    if (!ep?.youtubeId || tickHandleRef.current === null) return;
    const decision = decideAfterError(code, retriesRef.current);
    if (decision.action === "retry") {
      retriesRef.current++;
      mediaRef.current?.load(ep.youtubeId, 0);
      watchRef.current = { id: ep.id, at: Date.now() };
      return;
    }
    deadRef.current.add(ep.id);
    // Permanent means it will never play here on any night — remember it the
    // same way "never again" does, so tomorrow does not rediscover it.
    if (decision.permanent) blockEpisode(ep.id);
    setBlockedTonight((prev) => new Set(prev).add(ep.id));
    flash(classifyYouTubeError(code).reason);
    playNext();
  }

  function heardTick(cur: number) {
    const ep = currentEpRef.current;
    if (!ep) return;
    const delta = cur - lastPosRef.current;
    lastPosRef.current = cur;
    // Outside (0, 5) seconds is a seek or a new video, not time anyone spent
    // listening.
    if (delta > 0 && delta < 5) heardSecRef.current += delta;
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

  function restTick(driver: number) {
    const r = restRef.current;
    if (!r || pausedRemainingMsRef.current !== null || tickHandleRef.current === null) return;
    if (Date.now() - lastRestTickRef.current < 15_000) return;
    lastRestTickRef.current = Date.now();
    r.tick({
      now: Date.now(),
      hidden: typeof document !== "undefined" && document.hidden,
      fadingOrDone: driver <= FADE_SECONDS,
    });
  }

  function persistLive() {
    const media = mediaRef.current;
    const ep = currentEpRef.current;
    if (!media || !ep || tickHandleRef.current === null) return;
    const remainingMs =
      endTimeRef.current === null
        ? 0
        : pausedRemainingMsRef.current ?? endTimeRef.current - Date.now();
    if (endTimeRef.current !== null && remainingMs <= 0) return;
    saveLive({
      savedAt: Date.now(),
      remainingMs,
      totalSeconds: totalSecondsRef.current,
      position: media.currentTime(),
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
    setTransport(t);
    // watchRef.at is when this episode was asked to play, and it is cleared
    // the moment it does — so this is exactly "how long it has refused for".
    const waitedMs = watchRef.current ? Date.now() - watchRef.current.at : 0;
    setShowStartPrompt(t === "awaiting-start" && waitedMs > START_PROMPT_MS);

    const cur = media.currentTime();
    const dur = media.duration();
    const epRemaining = dur > 0 ? dur - cur : null;
    const driver = fadeDriverSeconds(kind, remaining, epRemaining);

    restTick(driver);
    heardTick(cur);

    // The courtesy fade owns the volume while it runs; reassigning here would
    // fight it back up and produce audible stabs on the way out.
    if (stopFadeRef.current === null) {
      media.setVolume(
        Number.isFinite(driver)
          ? effectiveVolume(driver, FADE_SECONDS, feedTrimRef.current[currentFeedRef.current ?? ""] ?? 1.0)
          : 1,
      );
      brownRef.current?.setGain(noiseGain(noise.on ? noise.level : 0, driver, FADE_SECONDS));
    }

    setCountdown(kind === "minutes" ? remaining : 0);
    setEpPos(dur > 0 ? { cur, dur } : null);

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
      watchRef.current = null;
      failsRef.current++;
      // Stuck without an error code: a blocked embed that reported nothing, a
      // region lock, a load that never finished. Dead for tonight only — we do
      // not know enough to condemn it forever.
      deadRef.current.add(w.id);
      if (failsRef.current <= 6) playNext();
      else endSession("ended"); // the whole lineup looks broken
    }

    if (++persistCounterRef.current >= 10) {
      persistCounterRef.current = 0;
      persistLive();
      if (currentEpRef.current && dur > 0) {
        rememberPosition(currentEpRef.current.id, cur, dur);
      }
    }
  }

  function clearStopFade() {
    if (stopFadeRef.current !== null) {
      clearInterval(stopFadeRef.current);
      stopFadeRef.current = null;
    }
  }

  function endSession(reason: RestNight["endedVia"] = "faded") {
    if (tickHandleRef.current === null && reason !== "ended") return;
    if (reason === "faded") recordSessionEnd(timerMinutes, modeRef.current.kind);
    clearStopFade();
    clearLive();
    saveLastNight({
      pool: poolRef.current,
      playedIds: [...playedIdsRef.current],
      feedTitles: feedTitlesRef.current,
      artworkByFeedId: artworkRef.current,
      skipIntroByFeedId: skipIntroRef.current,
      endedVia: reason,
      endedAt: Date.now(),
      wasVaried: wasVariedRef.current,
    });
    if (currentEpRef.current) saveLastEpisode(currentEpRef.current);
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
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      navigator.mediaSession.metadata = null;
    }
    if (restRef.current) {
      appendNight(restRef.current.finish(reason, Date.now()));
      restRef.current = null;
    }
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
    restRef.current = new RestSession(Date.now(), timerMinutes);
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

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;
        mediaRef.current = new YouTubeMedia((args) => buildPlayer(YT, args), {
          onEnded: handleEnded,
          onError: handleError,
        });
        const first =
          resume?.episode ??
          leadEpisode ??
          nextPlayable(pool, deadRef.current, null, getPlays());
        if (!first) {
          setStatus("error");
          setErrorText("nothing in this lineup can be played here");
          return;
        }
        setStatus("playing");
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
      if (holdTimerRef.current) clearInterval(holdTimerRef.current);
      brownRef.current?.stop();
      mediaRef.current?.destroy();
      mediaRef.current = null;
      void lockRef.current?.release();
      if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
        navigator.mediaSession.metadata = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One handler for "start it" and "resume it": both are a tap asking for
  // sound, and the browser treats this tap as the gesture that permits it.
  // Only a video that is genuinely playing gets paused.
  function handleTogglePause() {
    restRef.current?.noteInteraction();
    const media = mediaRef.current;
    if (!media) return;
    if (transport === "playing") {
      media.pause();
      return;
    }
    unfreezeClock();
    media.play();
  }

  function handleNext() {
    restRef.current?.noteInteraction();
    playNext();
  }

  function handleBlock() {
    const ep = currentEpRef.current;
    if (!ep) return;
    blockEpisode(ep.id);
    forgetPosition(ep.id);
    deadRef.current.add(ep.id);
    setBlockedTonight((prev) => new Set(prev).add(ep.id));
    flash("never again");
    restRef.current?.noteInteraction();
    playNext();
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
    flash(
      canExtend(used)
        ? "a little longer — sleep when you're ready"
        : "that's the last stretch. resting counts too.",
    );
  }

  function holdEndStart() {
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
              onClick={() => endSession("ended")}
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
                {canExtend(extensions) ? (
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
                    transport === "playing"
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
