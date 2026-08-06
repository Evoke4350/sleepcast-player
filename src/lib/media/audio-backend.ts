import type { MediaBackend, Transport } from "./backend";

/**
 * An <audio> element behind the backend interface.
 *
 * Deliberately thinner than Player.tsx's handling of the same element. No
 * crossOrigin, no CORS-bad/CORS-good feed sets, no compressor: a mixed night
 * cannot use the compressor at all (it cannot capture an iframe, and attaching
 * it is a one-way door), so the machinery that exists to serve it is not
 * carried across.
 */
export class AudioBackend implements MediaBackend {
  private dead = false;
  /** Torn down before the next load. A metadata handler that outlives its
   *  episode seeks the NEXT one to this one's position. */
  private seekCleanup: (() => void) | null = null;
  private detach: Array<() => void> = [];

  constructor(private readonly el: HTMLAudioElement) {}

  load(ref: string, startSeconds = 0): void {
    if (this.dead) return;
    this.seekCleanup?.();
    this.seekCleanup = null;

    this.el.src = ref;

    if (startSeconds > 0) {
      const onMeta = () => {
        try {
          this.el.currentTime = startSeconds;
        } catch {
          /* not seekable yet; the episode simply starts at the top */
        }
        cleanup();
      };
      const cleanup = () => {
        this.el.removeEventListener("loadedmetadata", onMeta);
        if (this.seekCleanup === cleanup) this.seekCleanup = null;
      };
      this.seekCleanup = cleanup;
      this.el.addEventListener("loadedmetadata", onMeta);
    }

    void this.el.play().catch(() => {
      /* the orchestrator's watchdog moves the night on */
    });
  }

  play(): void {
    if (this.dead) return;
    void this.el.play().catch(() => {});
  }

  pause(): void {
    if (this.dead) return;
    this.el.pause();
  }

  setVolume(level: number): void {
    if (this.dead) return;
    this.el.volume = Math.max(0, Math.min(1, level));
  }

  currentTime(): number {
    return Number.isFinite(this.el.currentTime) ? this.el.currentTime : 0;
  }

  duration(): number {
    return Number.isFinite(this.el.duration) && this.el.duration > 0 ? this.el.duration : 0;
  }

  transport(): Transport {
    if (this.dead) return "awaiting-start";
    return this.el.paused ? "paused" : "playing";
  }

  onProgress(cb: () => void): () => void {
    return this.subscribe("timeupdate", cb);
  }

  onEnded(cb: () => void): () => void {
    return this.subscribe("ended", cb);
  }

  onError(cb: (code: number | string) => void): () => void {
    return this.subscribe("error", () => cb("media-error"));
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.seekCleanup?.();
    this.seekCleanup = null;
    for (const off of this.detach.splice(0)) off();
    this.el.pause();
    this.el.removeAttribute("src");
  }

  private subscribe(type: string, cb: () => void): () => void {
    if (this.dead) return () => {};
    const handler = () => cb();
    this.el.addEventListener(type, handler);
    const off = () => this.el.removeEventListener(type, handler);
    this.detach.push(off);
    return off;
  }
}
