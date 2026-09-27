// A YouTube video, driven like an audio element.
//
// Player.tsx owns the night — the countdown, the fade, the sleep detector's
// event feed — and does all of it through an HTMLAudioElement. A YouTube
// episode has no streamable URL (see youtube.ts), so the only lawful way to
// play one is Google's embedded player: a different object, a different API,
// and above all a different lifecycle. It is not usable the moment it exists.
//
// Three differences this absorbs:
//
//   - **Readiness.** An <audio> accepts .play() and .volume immediately. A YT
//     player rejects everything until onReady fires. Commands issued before
//     then are queued and replayed in order, so a fade that begins the instant
//     a night starts is not silently lost.
//   - **Volume scale.** HTMLMediaElement.volume is 0–1; YT.setVolume takes
//     0–100. fadeVolume() returns 0–1, so the conversion belongs here rather
//     than at every call site.
//   - **Death.** The countdown interval and the fade can both fire after a
//     session ends. This codebase has been bitten by exactly that before — it
//     is why tick-gate.ts exists — so after destroy() every command is inert
//     rather than a throw into a torn-down iframe.
//
// The player is injected rather than constructed, so all of the above is
// testable without a browser or a network fetch of Google's IFrame API.
//
// The constructor handlers above predate the mixed-lineup orchestrator, which
// swaps backends per episode and needs to subscribe/unsubscribe rather than
// own the only handler for the night. onProgress/onEnded/onError/transport()
// below add that without touching the constructor path — YouTubeNight.tsx
// still owns one of these all night and reads state() directly.

import type { ErrorInfo, MediaBackend, Transport } from "./media/backend";
import { transportFor, YT_STATE, type Transport as YTTransport } from "./youtube-night";

/** The slice of YT.Player this uses. */
export interface YTPlayerLike {
  /** YT's own state: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering,
   *  5 cued. Asked for rather than mirrored — see state(). */
  getPlayerState(): number;
  playVideo(): void;
  pauseVideo(): void;
  setVolume(percent: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  loadVideoById(videoId: string, startSeconds?: number): void;
  /** Which video the player has loaded. The real IFrame API has it; optional
   *  so a player without it falls back to reading events (see inSwitch). */
  getVideoData?(): { video_id?: string };
  destroy(): void;
}

export interface CreatePlayerArgs {
  videoId: string;
  /** Where to begin. Non-zero when a snapshotted night is being revived. */
  startSeconds?: number;
  /** Returns whether the player should still be driven: false once this
   *  wrapper is dead, so the creator must not start playback then. */
  onReady: () => boolean;
  onError: (code: number) => void;
  /** Every YT state change. The creator must forward these. They end a switch
   *  only for a player that can't report its video (see inSwitch); otherwise
   *  the video id and the player's own state decide. */
  onStateChange: (state: number) => void;
}

/** Longest a switch is held unconfirmed, whatever the player reports: a load
 *  dropped without an error would otherwise read as loading for good. */
export const SWITCH_GUARD_MAX_MS = 10_000;

export class YouTubeMedia implements MediaBackend {
  private player: YTPlayerLike | null = null;
  private ready = false;
  private dead = false;
  /** Issued before onReady; replayed in order when it fires. */
  private pending: Array<(p: YTPlayerLike) => void> = [];
  /** The latest volume asked for before ready. Only the latest matters: the
   *  night sets it every second, and queueing each one put a closure a second
   *  in `pending` all night for a player that was slow (or never) ready. */
  private pendingVolume: number | null = null;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private progressSubs = new Set<() => void>();
  private endedSubs = new Set<() => void>();
  private errorSubs = new Set<(code: number | string, info: ErrorInfo) => void>();
  /** Set when a switch (loadVideoById) actually runs, until inSwitch confirms
   *  it (the requested video, freshly loaded) or gives up on it. In between, the iframe still reports the PREVIOUS
   *  video's state, time and duration, and may still deliver its events; this
   *  reports the new load as buffering (loading) at its start instead, so no caller can
   *  mistake the old video's readings or events for the new one's. */
  private switching: {
    id: string;
    start: number;
    since: number;
    /** Whether a position at `start` proves a fresh load: not when the player
     *  was already there when the switch began (a retry at the current
     *  position), which the old load's own reading would satisfy at once. */
    positionCounts: boolean;
  } | null = null;

  constructor(
    private readonly createPlayer: (args: CreatePlayerArgs) => YTPlayerLike,
    private readonly handlers: {
      onEnded?: () => void;
      onError?: (code: number, info: ErrorInfo) => void;
      /** Every state event, for the caller to route (routeStateEvent). ENDED
       *  is fired to onEnded by this wrapper either way; don't route it too. */
      onStateEvent?: (raw: number) => void;
    } = {},
  ) {}

  /** Start, or switch to, a video. Safe before the player exists.
   *  startSeconds revives a snapshotted night at the second it stopped rather
   *  than at 0:00 of a four-hour video. */
  load(videoId: string, startSeconds = 0): void {
    if (this.dead) return;
    if (this.player) {
      // Armed when the load runs, not when it is queued: queued before ready,
      // it could otherwise expire, or be cleared by the first video's own
      // startup, before the switch even began.
      this.run((p) => {
        let here = NaN;
        try { here = p.getCurrentTime(); } catch { /* keep NaN */ }
        this.switching = {
          id: videoId,
          start: startSeconds,
          since: Date.now(),
          positionCounts: !(Math.abs(here - startSeconds) < 3),
        };
        p.loadVideoById(videoId, startSeconds);
      });
      return;
    }
    this.player = this.createPlayer({
      videoId,
      startSeconds,
      onReady: () => {
        // The iframe can finish loading after the user already ended the
        // night. Flushing then would start audio with nothing left to stop it.
        if (this.dead) return false;
        this.ready = true;
        const queued = this.pending;
        this.pending = [];
        if (this.pendingVolume !== null) this.player!.setVolume(this.pendingVolume);
        this.pendingVolume = null;
        for (const run of queued) run(this.player!);
        return true;
      },
      onError: (code) => {
        if (this.dead) return; // late, after the night was torn down
        // An error doesn't say which video it is about. During a switch it may
        // be the previous video's, delivered late, or the new one's. Holding
        // or dropping it guesses, and a wrong guess either blocks a working
        // video or stalls a night on a dead one. So it is always delivered at
        // once, and marked uncertain during a switch: the caller may skip the
        // episode tonight but must not condemn it for good.
        this.emitError(code, { uncertain: this.inSwitch() });
      },
      onStateChange: (state) => {
        // Late, after the night was torn down: nothing may act on it (an ENDED
        // would reach onEnded and could forget the episode's position).
        if (this.dead) return;
        // Fallback only, for a player that can't say which video it has: the
        // new load announces itself as unstarted (-1) or cued (5), and
        // anything else may be about the previous video. With the video id
        // available (inSwitch), events don't decide anything.
        if (this.shownVideoId() === null && (state === -1 || state === 5)) this.switching = null;
        const ended = this.eventState(state) === YT_STATE.ENDED;
        this.handlers.onStateEvent?.(state);
        // Fired here for every event, not left to the caller's routing: a
        // handler that returned early would otherwise lose the night's end.
        if (ended) this.fireEnded();
      },
    });
  }

  play(): void {
    this.run((p) => p.playVideo());
  }

  pause(): void {
    this.run((p) => p.pauseVideo());
  }

  /** Takes 0–1, like HTMLMediaElement.volume. */
  setVolume(level: number): void {
    const clamped = Math.max(0, Math.min(1, level));
    const percent = Math.round(clamped * 100);
    if (this.dead) return;
    if (this.ready && this.player) this.player.setVolume(percent);
    else this.pendingVolume = percent;
  }

  /** 0 before ready — the countdown reads this every tick and must not be
   *  handed NaN or an exception while the iframe is still coming up. */
  currentTime(): number {
    if (this.inSwitch()) return this.switching!.start;
    if (!this.ready || !this.player) return 0;
    return this.player.getCurrentTime() || 0;
  }

  duration(): number {
    if (this.inSwitch()) return 0;
    if (!this.ready || !this.player) return 0;
    return this.player.getDuration() || 0;
  }

  /**
   * What the player is doing, asked rather than remembered.
   *
   * The first version of the caller mirrored this into a boolean, updated on
   * the three state codes it handled. The other three — unstarted, cued,
   * buffering — left the boolean saying "playing" while nothing played, which
   * is exactly the class of lie this app cannot afford. There is an API for
   * the truth; use it.
   *
   * Unstarted before ready and after destroy, so a caller never has to guard.
   */
  state(): number {
    // Loading, not unstarted: "unstarted" asks for a tap, and a switch still
    // resolving (up to SWITCH_GUARD_MAX_MS) must not show a tap prompt over a
    // video that may already have ended or be about to play.
    if (this.inSwitch()) return YT_STATE.BUFFERING;
    if (!this.ready || !this.player) return -1;
    return this.player.getPlayerState();
  }

  /** An iframe emits no timeupdate, so this polls once a second — the clock.
   *  One interval however many subscribers, started on the first and stopped
   *  with the last. The orchestrator's shouldTick gate dedupes anything that
   *  arrives faster than it wants. */
  onProgress(cb: () => void): () => void {
    if (this.dead) return () => {};
    this.progressSubs.add(cb);
    this.progressTimer ??= setInterval(() => {
      this.dispatch(this.progressSubs);
    }, 1000);
    return () => {
      this.progressSubs.delete(cb);
      if (this.progressSubs.size === 0 && this.progressTimer !== null) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
    };
  }

  onEnded(cb: () => void): () => void {
    if (this.dead) return () => {};
    this.endedSubs.add(cb);
    return () => void this.endedSubs.delete(cb);
  }

  onError(cb: (code: number | string, info: ErrorInfo) => void): () => void {
    if (this.dead) return () => {};
    this.errorSubs.add(cb);
    return () => void this.errorSubs.delete(cb);
  }

  /** The shared vocabulary, layered on top of state()'s raw YT code, which
   *  YouTubeNight.tsx reads directly and must keep working. transportFor's
   *  four outcomes predate "dead" — checked here first, because state()
   *  falls back to -1 (unstarted) after destroy, and transportFor(-1) reads
   *  as "awaiting-start". A caller that cannot tell "hasn't started" from
   *  "destroyed" renders a tap prompt over a play() that is a permanent
   *  no-op. */
  transport(): Transport {
    if (this.dead) return "dead";
    return transportFor(this.state());
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.pending = [];
    this.pendingVolume = null;
    this.switching = null;
    const p = this.player;
    this.player = null;
    this.ready = false;
    p?.destroy();
    // An interval outliving the night is the bug tick-gate.ts exists to
    // prevent.
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    this.progressSubs.clear();
    this.endedSubs.clear();
    this.errorSubs.clear();
  }

  /** The event's state as the caller should act on it: the event's own value
   *  (the player's cached state may not have caught up with the event it is
   *  dispatching), except during a switch, when it may be about the previous
   *  video and reads as buffering. A stale PLAYING then can't mark the new
   *  episode played, and a stale ENDED can't skip it. */
  eventState(raw: number): number {
    return this.inSwitch() ? YT_STATE.BUFFERING : raw;
  }

  /** Route one state event to the caller's handlers, as eventState reads it.
   *  Night and YouTubeNight carried copies of this dispatch, edited in
   *  lockstep and already drifting. */
  routeStateEvent(
    raw: number,
    h: { transport(t: YTTransport): void; playing(): void; paused(): void },
  ): void {
    const state = this.eventState(raw);
    h.transport(transportFor(state));
    if (state === YT_STATE.PLAYING) h.playing();
    else if (state === YT_STATE.PAUSED) h.paused();
    // ENDED is fired by the wrapper itself for every event (onStateChange).
  }

  private fireEnded(): void {
    this.handlers.onEnded?.();
    this.dispatch(this.endedSubs);
  }

  private emitError(code: number, info: ErrorInfo): void {
    this.handlers.onError?.(code, info);
    this.dispatch(this.errorSubs, code, info);
  }

  /** Call each subscriber once. Over a copy: a handler may unsubscribe and
   *  re-subscribe itself (Night's skip starts the next episode), and a Set
   *  loop visits entries added mid-loop, running it again against the next
   *  episode. But skipping any removed mid-loop, and stopping once a handler
   *  has destroyed this (the night ended). */
  private dispatch<A extends unknown[]>(set: Set<(...args: A) => void>, ...args: A): void {
    for (const s of [...set]) {
      if (this.dead) return;
      if (set.has(s)) s(...args);
    }
  }

  /** The video id the player reports, or null if it can't report one. */
  private shownVideoId(): string | null {
    if (!this.ready || !this.player?.getVideoData) return null;
    try {
      return this.player.getVideoData()?.video_id ?? null;
    } catch {
      return null;
    }
  }

  /** Whether a switch is still unconfirmed.
   *
   *  Settled by the player showing the requested video AND a fresh load of it
   *  (see showsFreshLoad: unstarted, buffering or cued; or a position at the
   *  requested start, unless the player was already there when the switch
   *  began). The id alone isn't enough: requesting the video already showing
   *  (a quick A → B → A, a retry) matched before anything had restarted.
   *
   *  A player that can't report its video falls back to its events (see
   *  onStateChange). Either way the guard gives up after SWITCH_GUARD_MAX_MS,
   *  wall-clock (which keeps counting while a phone sleeps), or if the clock
   *  jumps backwards. Past that point stale readings can reach callers; the
   *  players' witness still requires movement, but a stale PLAYING event
   *  would be believed. */
  private inSwitch(): boolean {
    const sw = this.switching;
    if (!sw) return false;
    const elapsed = Date.now() - sw.since;
    if (elapsed < 0 || elapsed > SWITCH_GUARD_MAX_MS) {
      this.switching = null;
      return false;
    }
    const shown = this.shownVideoId();
    if (shown === null) return true; // fallback: the events decide
    if (shown !== sw.id || !this.showsFreshLoad(sw)) return true;
    this.switching = null;
    return false;
  }

  /** The player is at the start of a load rather than mid-way through (or at
   *  the end of) an earlier one. ENDED doesn't count: requesting the video
   *  that just ended (a lone survivor repeating) would confirm on the old
   *  load's own ENDED. (A video shorter than its requested start, a Short
   *  past a long skip-intro, ends without ever playing; the players treat
   *  such an ENDED as a failure and skip it for the night, whichever way the
   *  switch resolved.) */
  private showsFreshLoad(sw: { start: number; positionCounts: boolean }): boolean {
    try {
      const raw = this.player!.getPlayerState();
      if (raw === YT_STATE.UNSTARTED || raw === YT_STATE.BUFFERING || raw === YT_STATE.CUED) return true;
      return sw.positionCounts && Math.abs((this.player!.getCurrentTime() || 0) - sw.start) < 3;
    } catch {
      return false;
    }
  }

  private run(command: (p: YTPlayerLike) => void): void {
    if (this.dead) return;
    if (this.ready && this.player) command(this.player);
    else this.pending.push(command);
  }
}
