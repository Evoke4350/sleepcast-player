import { describe, it, expect } from "vitest";
import { SleepDetector, tickLogLR, boundA, DEFAULT_PARAMS } from "./detector";
import type { SleepSignal } from "./types";

const TICK = 15_000;
const sig = (i: number, over: Partial<SleepSignal> = {}): SleepSignal => ({
  t: i * TICK, interacted: false, hidden: true, fadingOrDone: false, ...over,
});

describe("tickLogLR", () => {
  it("an interaction is strong evidence AGAINST sleep (negative)", () => {
    expect(tickLogLR(sig(0, { interacted: true }), DEFAULT_PARAMS)).toBeLessThan(-2);
  });
  it("a quiet tick is (mild) evidence FOR sleep (positive)", () => {
    expect(tickLogLR(sig(0, { interacted: false }), DEFAULT_PARAMS)).toBeGreaterThan(0);
  });
});

describe("SleepDetector — fade gate", () => {
  it("quiet stream WITHOUT a fade never emits, however long it runs", () => {
    const d = new SleepDetector();
    let onset = null;
    for (let i = 0; i < 400; i++) onset = d.observe(sig(i, { fadingOrDone: false })) ?? onset;
    expect(onset).toBeNull();
  });

  it("quiet stream that builds evidence then enters the fade emits, onset near the start of the quiet stretch", () => {
    const d = new SleepDetector();
    let onset = null;
    let i = 0;
    // Build evidence quietly (no fade yet) until evidence has clearly crossed A...
    for (; i < 40; i++) {
      onset = d.observe(sig(i, { fadingOrDone: false }));
      expect(onset).toBeNull(); // gate withholds even once S >= A
    }
    // ...then the fade begins and the next quiet tick should emit.
    onset = d.observe(sig(i, { fadingOrDone: true }));
    expect(onset).not.toBeNull();
    expect(onset!.via).toBe("inference");
    // The guard that matters here is that onset is NOT the fade tick — we must
    // not tell someone they fell asleep at minute 44 because that is when the
    // volume started dropping. It is anchored at the point the evidence
    // reached the bound, which is far earlier than the fade and far later than
    // the first quiet tick. (This assertion used to read `<= 2 * TICK`, which
    // pinned it to tick one and was the cause of "you drifted off in 1 min".)
    const q = tickLogLR(sig(0, { fadingOrDone: false }), DEFAULT_PARAMS);
    const crossing = (Math.ceil(boundA(DEFAULT_PARAMS) / q) - 1) * TICK;
    expect(onset!.atMs).toBe(crossing);
    expect(onset!.atMs).toBeLessThan(i * TICK); // strictly before the fade tick
  });

  it("an interaction mid-build sets progress back (more ticks to alarm)", () => {
    const BUILD = 6; // quiet ticks that accumulate real evidence (S > 0, below A)
    const ticksToAlarm = (interrupt: boolean) => {
      const d = new SleepDetector();
      let i = 0;
      for (; i < BUILD; i++) d.observe(sig(i)); // quiet, hidden, no fade — builds S
      if (interrupt) { d.observe(sig(i, { interacted: true })); i++; } // knock S down
      // now let it fade uninterrupted until it alarms
      let onset = null;
      while (!onset) { onset = d.observe(sig(i, { fadingOrDone: true })); i++; }
      return i;
    };
    expect(ticksToAlarm(true)).toBeGreaterThan(ticksToAlarm(false));
  });

  it("NEVER alarms on a fully-interactive stream, even with fadingOrDone true", () => {
    const d = new SleepDetector();
    for (let i = 0; i < 200; i++) {
      expect(d.observe(sig(i, { interacted: true, hidden: false, fadingOrDone: true }))).toBeNull();
    }
  });

  it("emits at most once", () => {
    const d = new SleepDetector();
    let count = 0;
    for (let i = 0; i < 200; i++) {
      if (d.observe(sig(i, { fadingOrDone: true }))) count++;
    }
    expect(count).toBe(1);
  });

  it("A boundary grows as alpha shrinks", () => {
    expect(boundA({ ...DEFAULT_PARAMS, alpha: 0.001 })).toBeGreaterThan(boundA({ ...DEFAULT_PARAMS, alpha: 0.05 }));
  });
});

// ---------------------------------------------------------------------------
// Onset timestamp — regression for "it says I drifted off in one minute"
// ---------------------------------------------------------------------------

describe("reported onset time", () => {
  const TICK = 15_000;

  /** A night nobody touches: start it, put the phone down, let it fade. */
  function untouchedNight(totalMs: number) {
    const d = new SleepDetector();
    const fadeAt = totalMs - 60_000;
    for (let t = 0; t <= totalMs; t += TICK) {
      const o = d.observe({ t, interacted: false, hidden: true, fadingOrDone: t >= fadeAt });
      if (o) return o;
    }
    return null;
  }

  it("does not claim sleep within the first minute of an untouched night", () => {
    // The bug: candidateOnset was pinned to the first tick that lifted S off
    // the zero floor, which for an untouched night is tick one. fmtDuration
    // then rendered 0ms as "1 min".
    const onset = untouchedNight(45 * 60_000);
    expect(onset).not.toBeNull();
    expect(onset!.atMs).toBeGreaterThan(60_000);
  });

  it("reports the moment the evidence became conclusive, not when it started", () => {
    // A = log((1-beta)/alpha) = log(42.5) ≈ 3.75, and a quiet tick contributes
    // log(0.999) - log(0.88) ≈ 0.1268, so ~30 quiet ticks ≈ 7.5 minutes.
    const onset = untouchedNight(45 * 60_000);
    const quiet = tickLogLR(
      { t: 0, interacted: false, hidden: true, fadingOrDone: false },
      DEFAULT_PARAMS,
    );
    // The first observation happens at t = 0, so the nth lands at (n-1)*TICK.
    const n = Math.ceil(boundA(DEFAULT_PARAMS) / quiet);
    expect(onset!.atMs).toBe((n - 1) * TICK);
    expect(onset!.atMs).toBeGreaterThan(6 * 60_000); // ~7.25 min, a believable figure
  });

  it("restarts the clock when sustained interaction resets the hypothesis", () => {
    // Someone awake and fiddling for the first ten minutes, then settling,
    // should be credited from when they settled — not from the very start.
    const d = new SleepDetector();
    const TOTAL = 60 * 60_000;
    const fadeAt = TOTAL - 60_000;
    let onset = null;
    for (let t = 0; t <= TOTAL; t += TICK) {
      // Interact on every tick for the first 10 minutes: S is pinned to 0.
      const interacted = t < 10 * 60_000;
      const o = d.observe({ t, interacted, hidden: true, fadingOrDone: t >= fadeAt });
      if (o && !onset) onset = o;
    }
    expect(onset).not.toBeNull();
    expect(onset!.atMs).toBeGreaterThan(10 * 60_000);
  });
});
