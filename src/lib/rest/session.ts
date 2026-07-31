import type { SleepSignal, SleepOnset, RestNight } from "./types";
import { SleepDetector, DEFAULT_PARAMS } from "./detector";
import { loadNights, loadParams } from "./ledger";
import { paramsFromHistory } from "./calibrate";

export class RestSession {
  private detector: SleepDetector;
  private onset: SleepOnset | null = null;
  private interactions = 0;
  private pendingInteraction = false;

  constructor(private startedAt: number, private timerMinutes: number) {
    const params = loadParams() ?? paramsFromHistory(loadNights()) ?? DEFAULT_PARAMS;
    this.detector = new SleepDetector(params);
  }

  private lastInteractionAt: number | null = null;

  /** Any transport touch since the last tick. */
  noteInteraction(now: number = Date.now()): void {
    this.interactions++;
    this.pendingInteraction = true;
    this.lastInteractionAt = now;
  }

  /** Observable wakefulness, for the opt-in quarter-hour rule. The detector's
   *  own onset is gated on the timer fade and says nothing mid-night, so
   *  interaction is the only live signal there is. */
  wakefulness(now: number): { interactions: number; msSinceLastInteraction: number | null } {
    return {
      interactions: this.interactions,
      msSinceLastInteraction:
        this.lastInteractionAt === null ? null : now - this.lastInteractionAt,
    };
  }

  tick(s: Omit<SleepSignal, "t" | "interacted"> & { now: number; interacted?: boolean }): void {
    if (this.onset) return;
    const sig: SleepSignal = {
      t: s.now - this.startedAt,
      interacted: s.interacted ?? this.pendingInteraction,
      hidden: s.hidden,
      fadingOrDone: s.fadingOrDone,
    };
    this.pendingInteraction = false;
    const o = this.detector.observe(sig);
    if (o) this.onset = o;
  }

  finish(endedVia: RestNight["endedVia"], now: number): RestNight {
    return {
      startedAt: this.startedAt,
      timerMinutes: this.timerMinutes,
      endedVia,
      sleptAtMs: this.onset ? this.onset.atMs : null,
      timeToSleepMs: this.onset ? this.onset.atMs : null,
      interactions: this.interactions,
      detector: this.onset ? "inference" : "none",
    };
  }
}
