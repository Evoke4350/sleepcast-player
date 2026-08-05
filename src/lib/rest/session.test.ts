import { describe, it, expect, beforeEach } from "vitest";
import { RestSession } from "./session";

describe("RestSession", () => {
  beforeEach(() => localStorage.clear());

  it("records onset + time-to-sleep after a quiet run, counts interactions", () => {
    const s = new RestSession(1000, 60);
    s.noteInteraction();
    s.noteInteraction();
    for (let i = 0; i < 40; i++) s.tick({ interacted: false, hidden: true, fadingOrDone: i >= 34, now: 1000 + i * 15000 });
    const night = s.finish("faded", 1000 + 60 * 60000);
    expect(night.interactions).toBe(2);
    expect(night.sleptAtMs).not.toBeNull();
    expect(night.detector).toBe("inference");
  });

  it("no onset on a fully-interactive night → sleptAtMs null, detector none", () => {
    const s = new RestSession(1000, 60);
    for (let i = 0; i < 60; i++) { s.noteInteraction(); s.tick({ interacted: true, hidden: false, fadingOrDone: false, now: 1000 + i * 15000 }); }
    const night = s.finish("ended", 1000 + 60 * 60000);
    expect(night.sleptAtMs).toBeNull();
    expect(night.detector).toBe("none");
    expect(night.interactions).toBe(60);
  });
});

describe("attributing sleep onset to what was playing", () => {
  /** Drive a session to a detected onset. Copied from the existing passing
   *  test at the top of this file — the detector only concludes once the fade
   *  is under way, which is why fadingOrDone turns on at tick 34 rather than
   *  at the start. Onset therefore lands somewhere after 34 * 15s = 510_000ms. */
  function sessionWithOnset(start: number) {
    const s = new RestSession(start, 60);
    for (let i = 0; i < 40; i++) {
      s.tick({ interacted: false, hidden: true, fadingOrDone: i >= 34, now: start + i * 15_000 });
    }
    return s;
  }

  it("credits the episode that was playing at the onset moment", () => {
    const start = 1_000_000;
    const s = sessionWithOnset(start);
    s.noteEpisode("swm", "ep1", start);
    s.noteEpisode("boring", "ep2", start + 10_000);
    const night = s.finish("faded", start + 900_000);
    expect(night.sleptAtMs).not.toBeNull();
    // Both started before onset; the LAST one before it is what was playing.
    expect(night.onsetFeedId).toBe("boring");
    expect(night.onsetEpisodeId).toBe("ep2");
  });

  it("records feeds that auto-advanced after onset as slept-through", () => {
    const start = 1_000_000;
    const s = sessionWithOnset(start);
    s.noteEpisode("swm", "ep1", start);              // before onset — it led
    s.noteEpisode("boring", "ep2", start + 700_000); // after onset (>510_000)
    const night = s.finish("faded", start + 900_000);
    expect(night.onsetFeedId).toBe("swm");
    expect(night.sleptThrough).toEqual(["boring"]);
  });

  it("does not list the onset feed as slept-through as well", () => {
    // A feed that led AND auto-advanced later earns onset credit once and
    // slept-through credit once, but must not be double-counted as one night's
    // worth of two different things in the same array.
    const start = 1_000_000;
    const s = sessionWithOnset(start);
    s.noteEpisode("swm", "ep1", start);
    s.noteEpisode("swm", "ep2", start + 700_000);
    const night = s.finish("faded", start + 900_000);
    expect(night.onsetFeedId).toBe("swm");
    expect(night.sleptThrough).toEqual(["swm"]);
  });

  it("records skips, and does so even when no onset was ever detected", () => {
    // A night where the listener stayed awake still tells you what failed.
    const s = new RestSession(1_000_000, 45);
    s.noteEpisode("swm", "ep1", 1_000_000);
    s.noteSkip("swm");
    const night = s.finish("ended", 1_100_000);
    expect(night.sleptAtMs).toBeNull();
    expect(night.onsetFeedId).toBeUndefined();
    expect(night.skipped).toEqual(["swm"]);
  });

  it("does not repeat a feed skipped twice", () => {
    const s = new RestSession(1_000_000, 45);
    s.noteSkip("swm");
    s.noteSkip("swm");
    expect(s.finish("ended", 1_100_000).skipped).toEqual(["swm"]);
  });

  it("leaves onset absent when nothing had started yet", () => {
    // A clock or resume artefact. Better absent than invented.
    const s = sessionWithOnset(1_000_000);
    const night = s.finish("faded", 1_900_000);
    expect(night.onsetFeedId).toBeUndefined();
    expect(night.sleptThrough).toBeUndefined();
  });

  it("omits the fields entirely rather than writing empty arrays", () => {
    // loadNights() parses 90 stored nights without them; absent and [] must
    // not become two different shapes in the ledger.
    const s = new RestSession(1_000_000, 45);
    const night = s.finish("ended", 1_100_000);
    expect("skipped" in night).toBe(false);
    expect("sleptThrough" in night).toBe(false);
  });
});
