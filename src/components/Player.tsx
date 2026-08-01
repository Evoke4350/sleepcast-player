import { lazy, Suspense, useEffect, useRef, useState } from "react";

// The drift game (three.js) loads only when opened — the player's own
// bundle stays featherweight.
const DriftGame = lazy(() => import("./DriftGame"));
import type { Episode, PlayMode } from "../lib/engine";
import { fadeVolume, formatTime, effectiveVolume, fadeDriverSeconds } from "../lib/engine";
import { getPlays, recordHeardPlay, saveLive, clearLive, saveLastEpisode, saveLastNight, rememberPosition, forgetPosition, blockEpisode } from "../lib/store";
import { pickNextEpisode, HEARD_SEC } from "../lib/plays";
import { canExtend } from "../lib/timer-feel";
import { recordSessionEnd } from "../lib/store";
import type { NoiseSettings } from "../lib/store";
import { BrownNoise, noiseGain } from "../lib/noise";
import { shouldTick } from "../lib/tick-gate";
import { shouldSuggestGettingUp } from "../lib/rest/quarterhour";
import { RestSession } from "../lib/rest/session";
import { appendNight } from "../lib/rest/ledger";
import type { RestNight } from "../lib/rest/types";

const FADE_SECONDS = 60;
// Just under a second, so a jittery 1s interval isn't swallowed by the gate it
// shares with the ~4Hz timeupdate stream.
const TICK_MIN_MS = 900;
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

export function Player({ pool, timerMinutes, mode, feedTrim, noise, skipIntroByFeedId, feedTitles, artworkByFeedId, onEnd, resume = null, leadEpisode = null, leadPosition = 0, quarterHourRule = false, wasVaried = false }: PlayerProps) {
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
  const seekCleanupRef = useRef<(() => void) | null>(null);
  // Watchdog: a track that hasn't reached "playing" within the window is
  // stuck (silent play() rejection, stalled load, dead enclosure URL) —
  // skip it instead of sitting in silence. Bounded so a fully-broken pool
  // can't spin forever.
  const watchRef = useRef<{ src: string; at: number } | null>(null);
  const failsRef = useRef(0);
  const restRef = useRef<RestSession | null>(null);
  const lastRestTickRef = useRef(0);
  // The full episode now playing (nowPlaying state omits the url we need to
  // revive it), the live timer total, and a throttle so we snapshot the night
  // to storage every ~10s rather than every tick.
  const currentEpRef = useRef<Episode | null>(null);
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

  function playEpisode(ep: Episode, seekTo = 0) {
    const audio = audioRef.current;
    if (!audio) return;

    // Remove any stale seek enforcement from the previous episode
    seekCleanupRef.current?.();
    seekCleanupRef.current = null;

    setNowPlaying({ id: ep.id, title: ep.title, feedId: ep.feedId });
    setPlayedIds((prev) => new Set(prev).add(ep.id));
    audio.src = ep.url;
    currentEpRef.current = ep;
    // Snapshot the new episode to storage promptly, not up to 10s later.
    persistCounterRef.current = 10;

    if (seekTo > 0) {
      // Reviving a night: land where the sleeper left off, once metadata is
      // in. Stands in for the skip-intro seek — a saved position is already
      // past any intro.
      // Registered in seekCleanupRef, not just self-removing. If this episode
      // is interrupted before metadata arrives — a dead URL, the watchdog, a
      // Next tap — the handler would otherwise stay armed and seek the NEXT
      // episode to this one's resume position, dropping the listener into the
      // middle of a story they never started.
      const onMeta = () => {
        try { audio.currentTime = seekTo; } catch { /* not seekable yet */ }
        cleanupMeta();
      };
      const cleanupMeta = () => {
        audio.removeEventListener("loadedmetadata", onMeta);
        if (seekCleanupRef.current === cleanupMeta) seekCleanupRef.current = null;
      };
      seekCleanupRef.current = cleanupMeta;
      audio.addEventListener("loadedmetadata", onMeta);
    }

    const skipMin = skipIntroRef.current[ep.feedId] ?? 0;
    const skipSec = skipMin * 60;
    if (seekTo === 0 && skipSec > 0) {
      // A single seek at loadedmetadata isn't enough: Safari quietly resets
      // seeks made before playback starts, and duration can still be NaN at
      // that point (which used to swallow the skip entirely). Enforce the
      // position across the loading lifecycle until playback is actually
      // past the mark, then stand down.
      const EVENTS = ["loadedmetadata", "canplay", "playing", "timeupdate"] as const;
      let attempts = 0;
      const cleanup = () => {
        for (const ev of EVENTS) audio.removeEventListener(ev, enforce);
        if (seekCleanupRef.current === cleanup) seekCleanupRef.current = null;
      };
      const enforce = () => {
        const dur = audio.duration;
        if (Number.isFinite(dur) && dur > 0 && skipSec >= dur - 30) {
          cleanup(); // episode barely longer than the skip: play it whole
          return;
        }
        if (audio.currentTime >= skipSec - 2) {
          if (!audio.paused) {
            cleanup(); // skip landed and playback is rolling
            setToast(`skipped the ${skipMin} min intro`);
            setTimeout(() => setToast(""), 4200);
          }
          return;
        }
        if (attempts++ > 12) { cleanup(); return; } // stop fighting a stubborn stream
        try { audio.currentTime = skipSec; } catch { /* not seekable yet: a later event retries */ }
      };
      seekCleanupRef.current = cleanup;
      for (const ev of EVENTS) audio.addEventListener(ev, enforce);
    }

    watchRef.current = { src: ep.url, at: Date.now() };
    audio.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        // Autoplay gate (track changed while backgrounded/locked): retrying
        // won't help — show paused so one tap on Resume restores the night.
        watchRef.current = null;
        // Freeze the clock too. The pause EVENT does not fire here, so without
        // this the timer keeps counting through silence — the listener loses
        // those minutes, and an untouched fade is recorded as a night they
        // slept through when nothing ever played.
        if (pausedRemainingMsRef.current === null && endTimeRef.current !== null) {
          pausedRemainingMsRef.current = endTimeRef.current - Date.now();
        }
        setPaused(true);
      }
      // Anything else (bad source, abort): the error event or the
      // watchdog advances us.
    });
    // An episode is no longer "heard" the instant it starts — heardTick records
    // it once HEARD_SEC of real playback has accumulated, so a track skipped
    // after three seconds stays in the pool.
    heardSecRef.current = 0;
    lastPosRef.current = 0;
    heardSavedAtRef.current = -1e9;
    epStartedAtRef.current = Date.now();

    if ("mediaSession" in navigator) {
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
    // Exclude what is playing now. The ledger only records an episode after
    // HEARD_SEC, so on a fresh varied mix every episode is still a candidate
    // and Next had a real chance of restarting the same story from 0:00.
    const current = currentEpRef.current;
    const choices = current
      ? poolRef.current.filter((e) => e.id !== current.id)
      : poolRef.current;
    const ep = pickNextEpisode(choices.length ? choices : poolRef.current, getPlays());
    if (ep) playEpisode(ep);
  }

  // Accumulate real playback for the current episode and write it to the play
  // ledger. Driven by "timeupdate" (~4Hz) rather than the 1s interval, because
  // that keeps firing while the phone is locked — the dominant sleep case.
  //
  // Deltas outside (0, 5) seconds are discarded: a negative or huge jump is a
  // seek, a scrub, or the reset to 0 on a new source, none of which is time
  // anyone spent listening.
  function heardTick() {
    const audio = audioRef.current;
    const ep = currentEpRef.current;
    if (!audio || !ep) return;

    const t = audio.currentTime;
    const delta = t - lastPosRef.current;
    lastPosRef.current = t;
    if (delta > 0 && delta < 5) heardSecRef.current += delta;

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
    if (!audio || !ep) return;
    rememberPosition(ep.id, audio.currentTime, audio.duration);
  }

  // "never again": drop this episode from tonight's pool, remember the choice,
  // and move on. The pool ref is mutated so the spread list and every later
  // pick in this session stop offering it without waiting for a remount.
  function handleBlock() {
    const ep = currentEpRef.current;
    if (!ep) return;
    blockEpisode(ep.id);
    forgetPosition(ep.id);
    poolRef.current = poolRef.current.filter((e) => e.id !== ep.id);
    // The spread renders the pool PROP, so it also has to be told — otherwise
    // the blocked title stays in tonight's list and tapping it plays it.
    setBlockedTonight((prev) => new Set(prev).add(ep.id));
    setToast("never again");
    setTimeout(() => setToast(""), 4200);
    restRef.current?.noteInteraction();
    playNext();
  }

  function persistLive() {
    const audio = audioRef.current;
    const ep = currentEpRef.current;
    if (!audio || !ep || tickHandleRef.current === null) return;
    // Timerless modes have no remaining time to restore; 0 records "revive the
    // night, there is no clock to resume".
    const remainingMs =
      endTimeRef.current === null
        ? 0
        : pausedRemainingMsRef.current ?? endTimeRef.current - Date.now();
    if (endTimeRef.current !== null && remainingMs <= 0) return;
    saveLive({
      savedAt: Date.now(),
      remainingMs,
      totalSeconds: totalSecondsRef.current,
      position: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
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
    const epRemaining =
      audio && Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration - audio.currentTime
        : null;
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
        setGettingUp(true);
        return;
      }
    }

    if (remaining <= 0) {
      endSession();
      return;
    }

    const epRemaining =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration - audio.currentTime
        : null;
    const driver = fadeDriverSeconds(kind, remaining, epRemaining);

    // The courtesy fade owns audio.volume while it runs. Without this guard
    // tick() would reassign full volume from the mode driver (Infinity in
    // all-night) on every pass, fighting the fade back up and producing
    // audible stabs on the way out.
    if (stopFadeRef.current === null) {
      audio.volume = Number.isFinite(driver)
        ? effectiveVolume(driver, FADE_SECONDS, feedTrimRef.current[currentFeedRef.current ?? ""] ?? 1.0)
        : 1;
      // The underlay rides the same driver, so voices and noise fade together
      // rather than leaving a bed of noise behind after the words stop.
      brownRef.current?.setGain(noiseGain(noise.on ? noise.level : 0, driver, FADE_SECONDS));
    }
    setCountdown(kind === "minutes" ? remaining : 0);
    setEpPos(
      Number.isFinite(audio.duration) && audio.duration > 0
        ? { cur: audio.currentTime, dur: audio.duration }
        : null
    );

    const w = watchRef.current;
    if (w && Date.now() - w.at > 25_000) {
      watchRef.current = null;
      failsRef.current++;
      if (failsRef.current <= 6 && tickHandleRef.current !== null) {
        playNext(); // stuck track: move on
      } else {
        audio.pause(); // whole pool looks broken — stop skipping in silence
      }
    }

    if (++persistCounterRef.current >= 10) {
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

  function endSession(reason: RestNight["endedVia"] = "faded") {
    // "faded" is the natural end — the timer ran out untouched. Stamp it so
    // the setup screen can offer a smaller re-arm to someone who wakes back
    // up inside the window. A manual stop is not an invitation to resume.
    if (reason === "faded") recordSessionEnd(timerMinutes, modeRef.current.kind);
    clearStopFade();
    clearLive(); // the night is over — nothing to revive
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
    if (currentEpRef.current) saveLastEpisode(currentEpRef.current); // for "the exact one again"
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
      audio.volume = 1;
    }

    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = null;
    }

    if (restRef.current) {
      appendNight(restRef.current.finish(reason, Date.now()));
      restRef.current = null;
    }

    onEndRef.current();
  }

  // Start session on mount
  useEffect(() => {
    pausedRemainingMsRef.current = null;
    endTimeRef.current =
      mode.kind === "minutes"
        ? Date.now() + (resume ? resume.remainingMs : timerMinutes * 60 * 1000)
        : null; // timerless modes: the fade is driven by the episode, not a clock
    restRef.current = new RestSession(Date.now(), timerMinutes);
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
      if (endTimeRef.current !== null && !audio.ended) {
        pausedRemainingMsRef.current = endTimeRef.current - Date.now();
      }
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
      if (tickHandleRef.current !== null) playNext();
    };

    // Playback genuinely started: stand the watchdog down.
    const onPlaying = () => {
      watchRef.current = null;
      failsRef.current = 0;
    };

    const onError = () => {
      if (tickHandleRef.current !== null && audio.getAttribute("src")) playNext();
    };

    audio.addEventListener("pause", onPause);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("timeupdate", tickGuarded); // fade + stop must survive a locked screen
    audio.addEventListener("timeupdate", restTick); // keeps the sleep detector fed while backgrounded
    audio.addEventListener("timeupdate", heardTick); // accumulates real playback for the play ledger
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", () => { restRef.current?.noteInteraction(); audio.play(); });
      navigator.mediaSession.setActionHandler("pause", () => { restRef.current?.noteInteraction(); audio.pause(); });
      navigator.mediaSession.setActionHandler("nexttrack", () => { restRef.current?.noteInteraction(); playNext(); });
      // Lock-screen / headphone scrubbing.
      try {
        navigator.mediaSession.setActionHandler("seekbackward", () => skipBy(-30));
        navigator.mediaSession.setActionHandler("seekforward", () => skipBy(30));
      } catch { /* older browsers: fine without */ }
    }

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
      brownRef.current?.stop();
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("timeupdate", tickGuarded);
      audio.removeEventListener("timeupdate", restTick);
      audio.removeEventListener("timeupdate", heardTick);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      if ("mediaSession" in navigator) {
        navigator.mediaSession.setActionHandler("play", null);
        navigator.mediaSession.setActionHandler("pause", null);
        navigator.mediaSession.setActionHandler("nexttrack", null);
        try {
          navigator.mediaSession.setActionHandler("seekbackward", null);
          navigator.mediaSession.setActionHandler("seekforward", null);
        } catch { /* symmetric with setup */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function skipBy(seconds: number) {
    restRef.current?.noteInteraction();
    const audio = audioRef.current;
    if (!audio || !audio.getAttribute("src")) return;
    const dur = Number.isFinite(audio.duration) ? audio.duration : Infinity;
    audio.currentTime = Math.min(Math.max(0, audio.currentTime + seconds), dur - 1);
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
    setToast(
      canExtend(used)
        ? "a little longer — sleep when you're ready"
        : "that's the last stretch. resting counts too.",
    );
    setTimeout(() => setToast(""), 4200);
  }

  // End must survive 2am thumbs: press and hold for a full second, a ring
  // fills to show intent registering, release early and nothing happens.
  function holdEndStart() {
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
    restRef.current?.noteInteraction();
    const audio = audioRef.current;
    if (!audio || !epPos) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audio.currentTime = Math.max(0, Math.min(1, ratio)) * epPos.dur;
    // Aiming at a position is the one moment the numbers earn their place —
    // show where you landed, then let them go back under with the moon.
    setPeekUntil(Date.now() + 4000);
  }

  function handleTogglePause() {
    restRef.current?.noteInteraction();
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }

  function handleNext() {
    restRef.current?.noteInteraction();
    playNext();
  }

  const countdownStr = formatTime(countdown);
  // The room dims as the night wanes — controls stay findable, just quieter.
  const dim = Math.max(0.55, 1 - 0.45 * (1 - countdown / Math.max(1, totalSeconds)));

  function dismissGettingUp() {
    setGettingUp(false);
    restRef.current?.noteInteraction();
    audioRef.current?.play().catch(() => { /* a tap will resume it */ });
    setPaused(false);
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
            onClick={() => { setGettingUp(false); endSession("ended"); }}
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
              aria-label={`time left ${countdownStr} — tap to peek`}
              className="relative font-mono font-light tabular-nums text-[#c8c0b0] transition-opacity duration-500"
            >
              {peeking
                ? <span className="text-6xl">{countdownStr}</span>
                : <span className="player-moon text-5xl">☾</span>}
            </button>
          </div>
          <div className="mt-2 flex items-center justify-center gap-3 text-xs text-[#6b6558] uppercase tracking-widest">
            <span>{peeking ? "remaining" : "sleeping"}</span>
            {canExtend(extensions) ? (
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
