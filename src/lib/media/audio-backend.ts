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
  /** A rejected play() is not a DOM event, so it cannot ride the "error"
   *  listener subscribe() sets up. These are called directly instead. */
  private errorCallbacks = new Set<(code: number | string) => void>();

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

    void this.el.play().catch((err: unknown) => this.reportPlayFailure(err));
  }

  play(): void {
    if (this.dead) return;
    void this.el.play().catch((err: unknown) => this.reportPlayFailure(err));
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
    if (this.dead) return "dead";
    return this.el.paused ? "paused" : "playing";
  }

  onProgress(cb: () => void): () => void {
    return this.subscribe("timeupdate", cb);
  }

  onEnded(cb: () => void): () => void {
    return this.subscribe("ended", cb);
  }

  onError(cb: (code: number | string) => void): () => void {
    this.errorCallbacks.add(cb);
    const offDom = this.subscribe("error", () => cb("media-error"));
    return () => {
      this.errorCallbacks.delete(cb);
      offDom();
    };
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.seekCleanup?.();
    this.seekCleanup = null;
    for (const off of this.detach.splice(0)) off();
    this.errorCallbacks.clear();
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

  /** A rejected play() reverts `paused` to true — the same state a deliberate
   *  pause leaves behind, and no "error" event follows it. Left unswallowed,
   *  a blocked autoplay is indistinguishable from a listener who paused on
   *  purpose, and the night stalls silently and forever. Reported instead,
   *  with a code the caller can tell apart from a dead enclosure: a blocked
   *  autoplay wants a tap and a frozen clock, a dead enclosure wants the next
   *  episode. */
  private reportPlayFailure(err: unknown): void {
    if (this.dead) return;
    const code = err instanceof DOMException && err.name === "NotAllowedError" ? "autoplay-blocked" : "play-failed";
    for (const cb of this.errorCallbacks) cb(code);
  }
}
