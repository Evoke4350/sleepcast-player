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
  beforeEach(() => localStorage.clear());

  /** Drive a session to a detected onset. Copied from the existing passing
   *  test at the top of this file — the detector only concludes once the fade
   *  is under way, which is why fadingOrDone turns on at tick 34 rather than
   *  at the start. Measured onset is 435_000ms, not the 34 * 15s = 510_000ms
   *  the tick count suggests: the detector backdates onset to behind the tick
   *  that detected it, rather than to the tick doing the detecting. */
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

  it("credits a feed with both onset and slept-through when it led and later auto-advanced", () => {
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

  it("credits an entry starting exactly on the onset millisecond to onset, not slept-through", () => {
    // The partition is e.t <= atMs for onset and e.t > atMs for slept-through,
    // so a tie on the boundary millisecond belongs to onset. Pinning this
    // because it's the kind of off-by-one that's easy to flip by accident.
    const start = 1_000_000;
    const s = sessionWithOnset(start);
    s.noteEpisode("before", "e0", start + 100_000);
    s.noteEpisode("boundary", "e1", start + 435_000); // exactly onset.atMs
    const night = s.finish("faded", start + 900_000);
    expect(night.onsetFeedId).toBe("boundary");
    expect(night.onsetEpisodeId).toBe("e1");
    expect(night.sleptThrough).toBeUndefined();
  });

  it("leaves onset absent and puts every entry in slept-through when onset precedes all of them", () => {
    // Distinct from the empty-timeline case above: entries exist, but the
    // listener was already asleep before any of them started.
    const start = 1_000_000;
    const s = sessionWithOnset(start);
    s.noteEpisode("a", "e1", start + 500_000); // after onset (435_000)
    s.noteEpisode("b", "e2", start + 600_000); // after onset
    const night = s.finish("faded", start + 900_000);
    expect(night.onsetFeedId).toBeUndefined();
    expect(night.sleptThrough).toEqual(["a", "b"]);
  });

  it("credits the only episode of a single-episode night with onset", () => {
    const start = 1_000_000;
    const s = sessionWithOnset(start);
    s.noteEpisode("only", "e1", start);
    const night = s.finish("faded", start + 900_000);
    expect(night.onsetFeedId).toBe("only");
    expect(night.onsetEpisodeId).toBe("e1");
    expect(night.sleptThrough).toBeUndefined();
  });

  it("credits the entry with the latest t before onset even when appended out of order", () => {
    // noteEpisode takes an explicit `now`, so a clock adjustment or a resumed
    // night can append an earlier t after a later one. Attribution must go by
    // t, not by append order.
    const start = 1_000_000;
    const s = sessionWithOnset(start);
    s.noteEpisode("late", "e2", start + 400_000);
    s.noteEpisode("early", "e1", start + 100_000);
    const night = s.finish("faded", start + 900_000);
    expect(night.onsetFeedId).toBe("late");
    expect(night.onsetEpisodeId).toBe("e2");
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
