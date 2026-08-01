# Corrected detector model — gate on the uninterrupted fade

*Written during development of the detector, and preserved because
`detector.ts` cites it three times. The "Tests to rewrite" section below is the
original work order; those tests exist now and are green. Read it as the record
of why the detector is shaped this way, not as a to-do list.*

The original model treated `hidden` (phone locked) as strong sleep evidence.
Simulation proved that wrong: an awake, resting, phone-down listener is
indistinguishable from a sleeper by that signal, so the detector false-alarmed
on ~96% of awake nights and the "quiet awake" case was unfixable by any `alpha`.

**Human decision:** a night counts as "slept" only when the sleep timer **fades
fully to silence with no interaction** — the one behavioral signal that
separates awake (stops/extends the audio) from asleep (lets it fade). Precision
by construction; we happily under-count (someone who manually ends it is not
logged) but never lie.

## The model

**`tickLogLR(s, p)` — drop the `hidden` term entirely.** The only discriminative
per-tick signal is interaction. Keep the interaction term exactly as before:
```
tickLogLR = s.interacted
  ? Math.log(EPS_INTERACT) - Math.log(p.lambdaAwake)            // strong against sleep
  : Math.log(1 - EPS_INTERACT) - Math.log(1 - p.lambdaAwake);   // mild for sleep
```
Do NOT add a `fadingOrDone` term — `fadingOrDone` is now a **gate**, not evidence.

**`DetectorParams`:** keep the `pHiddenAwake`/`pHiddenAsleep` fields in the type
(reserved for Phase-2 HR; leave a comment) but they are unused by `tickLogLR`.
Revert `DEFAULT_PARAMS.alpha` to **0.02** — precision now comes from the gate, so
`alpha` only sets how much sustained quiet is needed to fix the onset *time*.

**`observe(s)` — add the fade gate.** The CUSUM still accumulates on quiet and
tracks `candidateOnset` (the tick `S` left the 0 floor = when the quiet stretch
began). But it only *emits* once evidence has crossed `A` **and** `s.fadingOrDone`
is true:
```
observe(s):
  if (this.decided) return null;
  const prev = this.S;
  this.S = Math.max(0, this.S + tickLogLR(s, this.p));
  if (this.S === 0) { this.candidateOnset = null; return null; }
  if (prev === 0) this.candidateOnset = s.t;
  if (this.S >= this.A && s.fadingOrDone) {
    this.decided = true;
    return { atMs: this.candidateOnset, confidence: 1 - Math.exp(-this.S), via: "inference" };
  }
  return null;
```
Onset is still the *early* time the quiet began (preserves time-to-sleep), but the
commit waits for the fade. A night that never reaches the fade never emits.

## Tests to rewrite

`src/lib/rest/detector.test.ts` (gate-aware):
- quiet stream with `fadingOrDone: false` throughout → **never emits** (new).
- quiet stream that builds evidence then enters the fade (`fadingOrDone: true`) →
  emits, `atMs` near the start of the quiet stretch.
- an interaction after evidence has built, before the fade → resets (delays/prevents).
- fully-interactive stream → never emits.
- emits at most once.
- `boundA` grows as `alpha` shrinks (unchanged).
- `tickLogLR`: interaction is strongly negative; a quiet tick is positive. (No
  `hidden` assertions.)

`src/lib/rest/detector.sim.test.ts` (precision now from the gate):
- `awakeNight`: taps at ~lambda, **ends without a fade** (`fadingOrDone: false`
  every tick — awake people stop the audio). Assert FP < 5% (should be ~0).
- `quietAwakeNight`: no taps, **no fade** (ends manually). Assert FP < 5% (~0).
- `asleepNight`: quiet after a short settle, `fadingOrDone: true` in the last few
  ticks. Assert recall > 90% and mean reported onset within ~6 min.
- Note in a comment: a quiet listener who *does* let the full timer fade untouched
  is counted as slept **by design** (the human's decision), so it is not a false
  positive under this definition.
- Revert `DEFAULT_PARAMS.alpha` to 0.02.

## Downstream (already consistent)

`RestSession.finish` (Task 5) is unchanged: it records whatever onset the detector
emitted, which is now already gated. No change needed there.
