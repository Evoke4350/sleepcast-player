import { describe, it, expect } from "vitest";
import { SleepDetector } from "./detector";
import type { SleepSignal } from "./types";

const TICK = 15_000;
const TICKS_PER_NIGHT = 4 * 60; // a 60-min timer at 15s ticks

// Mulberry32: tiny deterministic PRNG so the sim is reproducible.
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// An AWAKE night: taps at ~lambda per tick, phone hidden ~30% of ticks, and —
// crucially — NEVER reaches the fade unattended. An awake person stops,
// pauses, or extends the audio before the timer runs out; they don't sit
// through a silent fade without touching the phone.
function awakeNight(seed: number): SleepSignal[] {
  const r = rng(seed);
  return Array.from({ length: TICKS_PER_NIGHT }, (_, i) => ({
    t: i * TICK, interacted: r() < 0.12, hidden: r() < 0.3, fadingOrDone: false,
  }));
}

// A QUIET-BUT-AWAKE night: listener is awake and resting, phone down/locked
// (hidden most of the time) but NOT interacting for long stretches — and
// still, no fade: they end the session manually before the timer fades.
// This is exactly the scenario that broke the old (ungated) model: hidden
// alone can't distinguish "resting awake" from "asleep." Under the gated
// model it doesn't need to — the absence of an unattended fade is what
// keeps this a true negative, regardless of how much quiet-evidence builds.
function quietAwakeNight(seed: number): SleepSignal[] {
  const r = rng(seed);
  return Array.from({ length: TICKS_PER_NIGHT }, (_, i) => ({
    t: i * TICK, interacted: r() < 0.02, hidden: r() < 0.85, fadingOrDone: false,
  }));
}

// An ASLEEP night: quiet after a short settle, hidden, and fades at the end
// (the timer runs out untouched — the one behavioral signal for "asleep").
function asleepNight(seed: number, settleTicks: number): SleepSignal[] {
  const r = rng(seed);
  return Array.from({ length: TICKS_PER_NIGHT }, (_, i) => ({
    t: i * TICK,
    interacted: i < settleTicks ? r() < 0.15 : false,
    hidden: i < settleTicks ? r() < 0.5 : true,
    fadingOrDone: i > TICKS_PER_NIGHT - 4,
  }));
}

function runNight(sigs: SleepSignal[]): number | null {
  const d = new SleepDetector();
  for (const s of sigs) { const o = d.observe(s); if (o) return o.atMs; }
  return null;
}

describe("detector — simulated error rates (gated model, alpha = 0.02)", () => {
  it("false-positive rate on awake nights stays low (< 5%)", () => {
    const N = 1000;
    let fp = 0;
    for (let s = 0; s < N; s++) if (runNight(awakeNight(s)) !== null) fp++;
    expect(fp / N).toBeLessThan(0.05);
  });

  // Note: a quiet, resting-but-awake listener who *does* let the full timer
  // fade untouched is counted as "slept" by design (the human's decision —
  // see docs/gated-model.md) — that is not a false positive under this
  // definition. This scenario never fades, so it must stay a true negative.
  it("false-positive rate on quiet-but-awake nights (phone down, resting, no fade) stays low (< 5%)", () => {
    const N = 1000;
    let fp = 0;
    for (let s = 0; s < N; s++) if (runNight(quietAwakeNight(s)) !== null) fp++;
    expect(fp / N).toBeLessThan(0.05);
  });

  it("detects sleep on asleep nights (> 90% recall) at reasonable latency", () => {
    const N = 1000;
    let detected = 0;
    let latencySum = 0;
    for (let s = 0; s < N; s++) {
      const settle = 8; // ~2 min of settling
      const onset = runNight(asleepNight(s, settle));
      if (onset !== null) { detected++; latencySum += onset; }
    }
    expect(detected / N).toBeGreaterThan(0.9);
    // Reported onset is now the point the evidence reached the decision bound,
    // not the point the quiet stretch began — roughly 7.25 min of quiet on top
    // of however long settling took.
    //
    // In THIS simulation that is a loss: asleepNight settles with visible
    // interactions for ~2 min and then sleeps, so "start of the quiet stretch"
    // was very close to the truth. Real nights are often not shaped that way.
    // A listener who starts playback and never touches the phone again gives
    // no observable settling at all, and the old estimator collapsed to zero —
    // reporting "you drifted off in 1 minute" for every such night.
    //
    // Given the signal cannot separate lying-still-awake from asleep, we take
    // the late error over the early one: under-claiming a slow night is far
    // less misleading than telling someone they fall asleep instantly.
    expect(latencySum / detected).toBeLessThan(10 * 60_000);
  });
});
