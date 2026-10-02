import { describe, it, expect, beforeEach } from "vitest";
import { recordNightEnd, type NightEnd } from "./night-end";
import { noteSounded, saveLive, loadLive, loadLastNight, loadLastEpisode, loadState, type LiveSession } from "./store";
import { loadNights } from "./rest/ledger";
import { RestSession } from "./rest/session";

const ep = { id: "a", title: "A", url: "https://x/a.mp3", feedId: "f", date: "2024-01-01" };
const older = { ...ep, id: "z", title: "Z", url: "https://x/z.mp3" };
const live: LiveSession = {
  savedAt: 1, remainingMs: 10 * 60_000, totalSeconds: 2700, position: 60, current: ep,
  playedIds: [], pool: [ep], skipIntroByFeedId: {}, feedTitles: {}, artworkByFeedId: {},
};
const end = (over: Partial<NightEnd> = {}): NightEnd => ({
  reason: "faded", played: true, timerMinutes: 45, modeKind: "minutes",
  lastNight: { pool: [ep], playedIds: ["a"], feedTitles: {}, artworkByFeedId: {}, skipIntroByFeedId: {}, wasVaried: false },
  rest: new RestSession(1_000, 45), now: 5_000,
  ...over,
});

describe("recordNightEnd", () => {
  beforeEach(() => { localStorage.clear(); saveLive(live); });

  it("a played night clears the snapshot and writes every record", () => {
    recordNightEnd(end());
    expect(loadLive()).toBeNull();
    expect(loadLastNight()).toMatchObject({ endedVia: "faded", endedAt: 5_000 });
    expect(loadNights()).toHaveLength(1);
    expect(loadState().settings.lastSession).not.toBeNull();
  });

  it("only a faded night stamps the re-arm", () => {
    recordNightEnd(end({ reason: "ended" }));
    expect(loadState().settings.lastSession).toBeNull();
    expect(loadLastNight()?.endedVia).toBe("ended");
  });

  it("a never-played night the listener ends clears the snapshot and records nothing", () => {
    noteSounded(null, older); // an earlier night's pick stands
    recordNightEnd(end({ played: false, reason: "ended" }));
    expect(loadLive()).toBeNull();
    expect(loadLastNight()).toBeNull();
    expect(loadLastEpisode()?.id).toBe(older.id);
    expect(loadNights()).toHaveLength(0);
  });

  it("a never-played night the app gives up on keeps the snapshot", () => {
    recordNightEnd(end({ played: false, reason: "ended", gaveUp: true }));
    expect(loadLive()).not.toBeNull();
    expect(loadNights()).toHaveLength(0);
  });

  it("a revived night ended before it sounded is recorded, with its own reason", () => {
    recordNightEnd(end({ played: false, revivedFrom: 1, reason: "ended" }));
    expect(loadLive()).toBeNull();
    expect(loadNights()).toHaveLength(1);
    expect(loadLastNight()?.endedVia).toBe("ended");
  });

  it("a revived night the app gives up on before it sounded keeps its snapshot", () => {
    recordNightEnd(end({ played: false, revivedFrom: 1, reason: "ended", gaveUp: true }));
    expect(loadLive()).not.toBeNull();
    expect(loadNights()).toHaveLength(0);
  });

  it("a revived night whose snapshot another tab has already recorded records nothing", () => {
    localStorage.clear();
    recordNightEnd(end({ played: false, revivedFrom: 1, reason: "ended" }));
    expect(loadNights()).toHaveLength(0);
    expect(loadLastNight()).toBeNull();
  });

  it("a revived night whose snapshot another tab has replaced records nothing and leaves it", () => {
    saveLive({ ...live, savedAt: 99 });
    recordNightEnd(end({ played: false, revivedFrom: 1, reason: "ended" }));
    expect(loadLive()?.savedAt).toBe(99);
    expect(loadNights()).toHaveLength(0);
  });

  it("gaveUp does not keep the snapshot of a night that played", () => {
    recordNightEnd(end({ gaveUp: true }));
    expect(loadLive()).toBeNull();
  });
});

describe("the last episode", () => {
  it("ending a night doesn't touch it (it is saved at first sound)", () => {
    localStorage.clear();
    noteSounded(null, older);
    saveLive(live);
    recordNightEnd(end());
    expect(loadLastEpisode()?.id).toBe(older.id);
    expect(loadNights()).toHaveLength(1);
  });
});
