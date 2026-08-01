export const TRIM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5] as const;

export function nextTrim(current: number, direction: 1 | -1): number {
  // Snap to nearest canonical step, then move one.
  let idx = 0;
  let best = Infinity;
  TRIM_STEPS.forEach((s, i) => {
    const d = Math.abs(s - current);
    if (d < best) {
      best = d;
      idx = i;
    }
  });
  const next = Math.min(TRIM_STEPS.length - 1, Math.max(0, idx + direction));
  return TRIM_STEPS[next];
}

// Broadcast-ish gentle squeeze: tames episode-to-episode loudness spread
// without pumping speech.
const COMPRESSOR = { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 };

export class Leveler {
  private audio: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private attached = false;
  // Once attach() has failed, don't retry: `attached` alone can't record
  // that, so onPlaying's every-episode retry would construct a fresh
  // AudioContext on every failure — and browsers cap how many a document
  // can have open.
  private failed = false;

  constructor(audio: HTMLAudioElement) {
    this.audio = audio;
  }

  attach(): boolean {
    if (this.attached) return true;
    if (this.failed) return false;
    try {
      const AC = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      const src = this.ctx.createMediaElementSource(this.audio);
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = COMPRESSOR.threshold;
      comp.knee.value = COMPRESSOR.knee;
      comp.ratio.value = COMPRESSOR.ratio;
      comp.attack.value = COMPRESSOR.attack;
      comp.release.value = COMPRESSOR.release;
      src.connect(comp).connect(this.ctx.destination);
      this.attached = true;
      // Autoplay policy: context may start suspended; resume is fire-and-forget.
      void this.ctx.resume().catch(() => {});
      return true;
    } catch {
      // createMediaElementSource throws if the element is already wired to
      // another context, or the context can't start. Plain playback is fine.
      this.ctx?.close().catch(() => {});
      this.ctx = null;
      this.failed = true;
      return false;
    }
  }

  dispose(): void {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.attached = false;
  }
}
