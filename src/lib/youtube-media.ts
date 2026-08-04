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

/** The slice of YT.Player this uses. */
export interface YTPlayerLike {
  playVideo(): void;
  pauseVideo(): void;
  setVolume(percent: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  loadVideoById(videoId: string, startSeconds?: number): void;
  destroy(): void;
}

export interface CreatePlayerArgs {
  videoId: string;
  /** Where to begin. Non-zero when a snapshotted night is being revived. */
  startSeconds?: number;
  onReady: () => void;
  onEnded: () => void;
  onError: (code: number) => void;
}

export class YouTubeMedia {
  private player: YTPlayerLike | null = null;
  private ready = false;
  private dead = false;
  /** Issued before onReady; replayed in order when it fires. */
  private pending: Array<(p: YTPlayerLike) => void> = [];

  constructor(
    private readonly createPlayer: (args: CreatePlayerArgs) => YTPlayerLike,
    private readonly handlers: {
      onEnded?: () => void;
      onError?: (code: number) => void;
    } = {},
  ) {}

  /** Start, or switch to, a video. Safe before the player exists.
   *  startSeconds revives a snapshotted night at the second it stopped rather
   *  than at 0:00 of a four-hour video. */
  load(videoId: string, startSeconds = 0): void {
    if (this.dead) return;
    if (this.player) {
      this.run((p) => p.loadVideoById(videoId, startSeconds));
      return;
    }
    this.player = this.createPlayer({
      videoId,
      startSeconds,
      onReady: () => {
        // The iframe can finish loading after the user already ended the
        // night. Flushing then would start audio with nothing left to stop it.
        if (this.dead) return;
        this.ready = true;
        const queued = this.pending;
        this.pending = [];
        for (const run of queued) run(this.player!);
      },
      onEnded: () => this.handlers.onEnded?.(),
      onError: (code) => this.handlers.onError?.(code),
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
    this.run((p) => p.setVolume(Math.round(clamped * 100)));
  }

  /** 0 before ready — the countdown reads this every tick and must not be
   *  handed NaN or an exception while the iframe is still coming up. */
  currentTime(): number {
    if (!this.ready || !this.player) return 0;
    return this.player.getCurrentTime() || 0;
  }

  duration(): number {
    if (!this.ready || !this.player) return 0;
    return this.player.getDuration() || 0;
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.pending = [];
    const p = this.player;
    this.player = null;
    this.ready = false;
    p?.destroy();
  }

  private run(command: (p: YTPlayerLike) => void): void {
    if (this.dead) return;
    if (this.ready && this.player) command(this.player);
    else this.pending.push(command);
  }
}

/** The embed origin. youtube-nocookie.com is Google's own reduced-tracking
 *  host: it still loads Google's player and Google still sees the request, but
 *  it does not set the advertising cookies the default domain does. The
 *  privacy policy states this rather than implying it away. */
export const YT_EMBED_HOST = "https://www.youtube-nocookie.com";
