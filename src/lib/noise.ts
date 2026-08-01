import { fadeVolume } from "./engine";

const LEVEL_MAX = 0.3;

export function noiseGain(
  level: number,
  driverSeconds: number,
  fadeSeconds: number
): number {
  const l = Math.min(LEVEL_MAX, Math.max(0, level));
  if (!Number.isFinite(driverSeconds)) return l;
  return l * fadeVolume(driverSeconds, fadeSeconds);
}

// Brown noise: white noise through a leaky integrator, generated in an
// AudioWorklet so it costs nothing on the main thread and needs no asset.
const WORKLET_SOURCE = `
class BrownNoiseProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.last = 0; }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      const white = Math.random() * 2 - 1;
      this.last = (this.last + 0.02 * white) / 1.02;
      out[i] = this.last * 3.5;
    }
    return true;
  }
}
registerProcessor("brown-noise", BrownNoiseProcessor);
`;

export class BrownNoise {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;

  static supported(): boolean {
    return (
      typeof AudioContext !== "undefined" &&
      typeof AudioWorkletNode !== "undefined"
    );
  }

  async start(): Promise<boolean> {
    if (this.ctx) return true;
    if (!BrownNoise.supported()) return false;
    try {
      const ctx = new AudioContext();
      // Publish immediately, before any await: if addModule/resume below
      // throws, the catch's stop() must be able to reach and close this
      // real context. Assigning only after both succeed left it orphaned
      // (unreachable, still open) on any failure — same root cause let an
      // unmount mid-await no-op on a null ctx and then get silently
      // overwritten once start() finished.
      this.ctx = ctx;
      const url = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: "application/javascript" })
      );
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, "brown-noise", {
        numberOfInputs: 0,
        outputChannelCount: [1],
      });
      const gain = ctx.createGain();
      gain.gain.value = 0;
      node.connect(gain).connect(ctx.destination);
      await ctx.resume();
      if (this.ctx !== ctx) {
        // stop() ran while we were awaiting: this context is orphaned.
        // close() rejects asynchronously, not synchronously — a try/catch
        // around the call site catches nothing; catch on the promise.
        ctx.close().catch(() => {});
        return false;
      }
      this.gain = gain;
      return true;
    } catch {
      this.stop();
      return false;
    }
  }

  setGain(g: number): void {
    if (!this.gain || !this.ctx) return;
    // 60 ms ramp: follows the 1 Hz tick smoothly without zipper noise.
    this.gain.gain.setTargetAtTime(
      Math.min(LEVEL_MAX, Math.max(0, g)),
      this.ctx.currentTime,
      0.06
    );
  }

  stop(): void {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.gain = null;
  }
}
