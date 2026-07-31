import type { SleepSignal, SleepOnset, DetectorParams } from "./types";

export const DEFAULT_PARAMS: DetectorParams = {
  lambdaAwake: 0.12,   // ~1 interaction per ~2 min while awake
  // pHiddenAwake/pHiddenAsleep: reserved for Phase 2 (HR-fused signal). Unused
  // by tickLogLR today — simulation proved `hidden` alone can't separate an
  // awake-but-resting listener from a sleeper (see gated-model.md). Precision
  // now comes from the fade gate in `observe`, not from this signal or `alpha`.
  pHiddenAwake: 0.25,
  pHiddenAsleep: 0.9,
  alpha: 0.02, // target false-positive rate; the fade gate does the real precision work now
  beta: 0.15,
};

const EPS_INTERACT = 1e-3; // P(interaction | asleep): tiny but non-zero

/** Log-likelihood ratio log P(x|asleep)/P(x|awake) for one tick. */
export function tickLogLR(s: SleepSignal, p: DetectorParams): number {
  return s.interacted
    ? Math.log(EPS_INTERACT) - Math.log(p.lambdaAwake)             // strong against sleep
    : Math.log(1 - EPS_INTERACT) - Math.log(1 - p.lambdaAwake);    // mild for sleep
}

export function boundA(p: DetectorParams): number {
  return Math.log((1 - p.beta) / p.alpha);
}

export class SleepDetector {
  private S = 0;
  // Tick t at which the accumulated evidence first reached the decision
  // bound. NOT the tick S left the zero floor: a single quiet tick lifts S off
  // the floor, so on a night nobody touches, that was tick one — and the app
  // reported "you drifted off in 1 minute" for every such night. What it was
  // really measuring was when you stopped touching the phone.
  private crossedAt: number | null = null;
  private decided = false;
  private readonly A: number;

  constructor(private p: DetectorParams = DEFAULT_PARAMS) {
    this.A = boundA(p);
  }

  observe(s: SleepSignal): SleepOnset | null {
    if (this.decided) return null;
    const prev = this.S;
    this.S = Math.max(0, this.S + tickLogLR(s, this.p));
    if (this.S === 0) {
      this.crossedAt = null; // back to the floor: no live sleep hypothesis
      return null;
    }
    // The earliest moment the evidence was conclusive. Deliberately the
    // conservative end of the interval — true onset lies somewhere between
    // leaving the floor and reaching the bound, and over-claiming a fast
    // night is the more misleading error for someone tracking their sleep.
    if (this.S >= this.A && this.crossedAt === null) this.crossedAt = s.t;
    // Fade gate: evidence alone never emits. Only a night that reaches the
    // sleep-timer fade *unattended* counts as slept (see gated-model.md) —
    // that's the one behavioral signal that separates awake (stops/extends
    // the audio) from asleep (lets it fade).
    if (this.S >= this.A && s.fadingOrDone) {
      this.decided = true;
      return {
        atMs: this.crossedAt ?? s.t,
        confidence: 1 - Math.exp(-this.S), // monotone in accumulated evidence
        via: "inference",
      };
    }
    return null;
  }

  reset(): void {
    this.S = 0;
    this.crossedAt = null;
    this.decided = false;
  }
}
