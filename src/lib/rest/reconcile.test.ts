import { describe, it, expect, beforeEach } from "vitest";
import { reconcileLive, settleLive, killedNightToRecord, resumeTarget, SNAPSHOT_FRESH_MS } from "./reconcile";
import { appendNight, loadNights } from "./ledger";
import { loadLive, saveLive, loadLastNight, type LiveSession } from "../store";

const ep = (id: string) => ({ id, title: id.toUpperCase(), url: `https://x/${id}.mp3`, feedId: "f", date: "2024-01-01" }) as any;

const T0 = 1_000_000_000;
const snap = (over: Partial<LiveSession> = {}): LiveSession => ({
  savedAt: T0 + 20 * 60_000,     // 20 min into a 45 min night
  remainingMs: 25 * 60_000,
  totalSeconds: 45 * 60,
  position: 600,
  current: ep("b"),
  playedIds: ["a"],
  pool: [ep("a"), ep("b"), ep("c")],
  skipIntroByFeedId: {}, feedTitles: {}, artworkByFeedId: {},
  nightStartedAt: T0,
  timerMinutes: 45,
  ...over,
});

describe("reconcileLive", () => {
  beforeEach(() => localStorage.clear());

  it("records the killed night in the rest ledger", () => {
    saveLive(snap());
    reconcileLive(snap(), T0 + 10 * 60 * 60_000);
    const nights = loadNights();
    expect(nights).toHaveLength(1);
    expect(nights[0]).toMatchObject({
      startedAt: T0, timerMinutes: 45, endedVia: "faded",
      sleptAtMs: null, timeToSleepMs: null, detector: "none",
    });
  });

  it("ends the night at its scheduled end, not when the page reopened", () => {
    reconcileLive(snap(), T0 + 10 * 60 * 60_000);
    expect(loadLastNight()?.endedAt).toBe(T0 + 45 * 60_000);
  });

  it("records the night's own end as when it was last seen alive", () => {
    // Its touches (and audio) stopped with the tab: nothing after was observed.
    reconcileLive(snap(), T0 + 10 * 60 * 60_000);
    expect(loadNights()[0].endedAt).toBe(T0 + 20 * 60_000);
  });

  it("marks the episode that was playing as played", () => {
    reconcileLive(snap(), T0 + 10 * 60 * 60_000);
    expect(loadLastNight()?.playedIds).toEqual(["a", "b"]);
  });

  it("records whether a killed night's shuffle leaned", () => {
    reconcileLive(snap({ shuffleLean: { a: 1.5 } }), T0 + 10 * 60 * 60_000);
    expect(loadNights()[0].shuffle).toBe("leaned");
  });

  it("leaves a plain or malformed-lean snapshot unmarked", () => {
    for (const shuffleLean of [undefined, {}, { a: 1 }, null, [1.5], { a: -1 }, { a: "x" }]) {
      localStorage.clear();
      reconcileLive(snap({ shuffleLean: shuffleLean as Record<string, number> | undefined }), T0 + 10 * 60 * 60_000);
      expect(loadNights()[0]).not.toHaveProperty("shuffle");
    }
  });

  it("keeps whether the night was a varied mix", () => {
    reconcileLive(snap({ wasVaried: true }), T0 + 10 * 60 * 60_000);
    expect(loadLastNight()?.wasVaried).toBe(true);
  });

  it("clears the snapshot so the night is recorded once", () => {
    saveLive(snap());
    reconcileLive(snap(), T0 + 10 * 60 * 60_000);
    expect(loadLive()).toBeNull();
  });

  it("estimates the start of a snapshot saved before nightStartedAt existed", () => {
    reconcileLive(snap({ nightStartedAt: undefined, timerMinutes: undefined }), T0 + 10 * 60 * 60_000);
    expect(loadNights()[0]).toMatchObject({ startedAt: T0, timerMinutes: 45 });
  });

  it("ends a timerless night (no remaining time) where it was last seen", () => {
    reconcileLive(snap({ remainingMs: 0 }), T0 + 10 * 60 * 60_000);
    expect(loadLastNight()?.endedAt).toBe(T0 + 20 * 60_000);
  });
});

describe("settleLive", () => {
  beforeEach(() => localStorage.clear());

  it("keeps a revivable snapshot for the resume card and records nothing", () => {
    saveLive(snap());
    expect(settleLive(snap(), T0 + 30 * 60_000)).not.toBeNull();
    expect(loadNights()).toHaveLength(0);
    expect(loadLive()).not.toBeNull();
  });

  it("reconciles a snapshot too old to revive", () => {
    saveLive(snap());
    expect(settleLive(snap(), T0 + 10 * 60 * 60_000)).toBeNull();
    expect(loadNights()).toHaveLength(1);
    expect(loadLive()).toBeNull();
  });

  // Killed during the final fade: under a minute left, so not worth reviving,
  // but the night did happen and nearly finished.
  it("reconciles a night killed in its last minute", () => {
    const s = snap({ remainingMs: 30_000 });
    saveLive(s);
    expect(settleLive(s, s.savedAt + 5 * 60_000)).toBeNull();
    expect(loadNights()).toHaveLength(1);
  });

  // A snapshot written seconds ago may belong to a night still playing in
  // another tab. Reconciling it would double-record that night when it ends.
  it("leaves a just-written snapshot alone", () => {
    const s = snap({ remainingMs: 30_000 });
    saveLive(s);
    expect(settleLive(s, s.savedAt + SNAPSHOT_FRESH_MS - 1)).toBeNull();
    expect(loadNights()).toHaveLength(0);
    expect(loadLive()).not.toBeNull();
  });

  it("reconciles a snapshot saved in the future (the clock stepped back)", () => {
    const s = snap();
    saveLive(s);
    expect(settleLive(s, s.savedAt - 60 * 60_000)).toBeNull();
    expect(loadNights()).toHaveLength(1);
    // Its start is never after its end (now, here).
    expect(loadNights()[0].startedAt).toBeLessThanOrEqual(loadLastNight()!.endedAt);
    expect(loadLive()).toBeNull();
  });

  it("does nothing without a snapshot", () => {
    expect(settleLive(null, T0)).toBeNull();
    expect(loadNights()).toHaveLength(0);
  });
});

describe("reconcileLive interactions", () => {
  beforeEach(() => localStorage.clear());
  it("records the snapshot's interactions, not 0", () => {
    reconcileLive(snap({ interactions: 12 }), T0 + 10 * 60 * 60_000);
    expect(loadNights()[0].interactions).toBe(12);
  });
});

describe("killedNightToRecord (a watch import)", () => {
  beforeEach(() => localStorage.clear());

  it("offers a snapshot's night even when it could still be revived, and clears it only on commit", () => {
    // Timerless: revivable for hours, but the morning import ends the night.
    saveLive(snap({ remainingMs: 0, modeKind: "all-night" }));
    const now = T0 + 20 * 60_000 + 60 * 60_000;
    expect(settleLive(loadLive(), now)).not.toBeNull();
    const k = killedNightToRecord(now)!;
    expect(k.night).toMatchObject({ startedAt: T0, detector: "none" });
    expect(loadLive()).not.toBeNull();
    k.commit();
    expect(loadLive()).toBeNull();
    // Ended, not faded: no re-anchor offers to continue a night the import closed.
    expect(loadLastNight()?.endedVia).toBe("ended");
  });

  it("offers none that may still be playing in another tab", () => {
    saveLive(snap());
    expect(killedNightToRecord(T0 + 20 * 60_000 + SNAPSHOT_FRESH_MS - 1)).toBeNull();
  });
});

describe("reconcileLive when storage is full", () => {
  beforeEach(() => localStorage.clear());
  it("keeps the snapshot it couldn't record, and says so", () => {
    saveLive(snap());
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    let recorded: boolean;
    try {
      recorded = reconcileLive(snap(), T0 + 10 * 60 * 60_000);
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(recorded).toBe(false);
    expect(loadLive()).not.toBeNull();
  });
});

describe("reconcileLive and a night already recorded", () => {
  beforeEach(() => localStorage.clear());
  it("replaces it, keeping the watch's time: a woken tab killed again", () => {
    // The morning import recorded the suspended tab's snapshot; the watch timed it.
    appendNight({ startedAt: T0, timerMinutes: 45, endedVia: "faded", sleptAtMs: 12 * 60_000, timeToSleepMs: 12 * 60_000, interactions: 1, detector: "watch", inferredAtMs: null }, Date.now());
    // The tab woke, wrote a newer snapshot, and was killed again.
    reconcileLive(snap({ savedAt: T0 + 30 * 60_000, remainingMs: 15 * 60_000, interactions: 4 }), T0 + 10 * 60 * 60_000);
    const nights = loadNights();
    expect(nights).toHaveLength(1);
    expect(nights[0]).toMatchObject({ detector: "watch", sleptAtMs: 12 * 60_000, interactions: 4 });
  });
});

describe("resumeTarget (a resume card tapped)", () => {
  beforeEach(() => localStorage.clear());
  it("revives the card's snapshot while it is the one stored", () => {
    saveLive(snap());
    expect(resumeTarget(snap(), T0 + 21 * 60_000)).toMatchObject({ revive: { savedAt: snap().savedAt } });
  });
  it("revives a newer snapshot of the same night", () => {
    saveLive(snap({ savedAt: T0 + 22 * 60_000 }));
    expect(resumeTarget(snap(), T0 + 23 * 60_000)).toMatchObject({ revive: { savedAt: T0 + 22 * 60_000 } });
  });
  it("doesn't revive one that can no longer be revived (its timer ran out): it is settled", () => {
    saveLive(snap({ savedAt: T0 + 44 * 60_000, remainingMs: 40_000 }));
    expect(resumeTarget(snap(), T0 + 8 * 60 * 60_000)).toEqual({ card: null });
    expect(loadNights()).toHaveLength(1);
  });
  it("shows no card once the night is gone, another night's card when it's stored", () => {
    expect(resumeTarget(snap(), T0 + 21 * 60_000)).toEqual({ card: null });
    saveLive(snap({ savedAt: T0 + 22 * 60_000, nightStartedAt: T0 + 60_000 }));
    expect(resumeTarget(snap(), T0 + 23 * 60_000)).toMatchObject({ card: { nightStartedAt: T0 + 60_000 } });
  });
});

describe("resumeTarget for snapshots written before the night's start was known", () => {
  beforeEach(() => localStorage.clear());
  it("matches the card's night by its lineup", () => {
    const card = snap({ nightStartedAt: undefined });
    saveLive(snap({ nightStartedAt: undefined, savedAt: T0 + 22 * 60_000 }));
    expect(resumeTarget(card, T0 + 23 * 60_000)).toMatchObject({ revive: { savedAt: T0 + 22 * 60_000 } });
  });
});
