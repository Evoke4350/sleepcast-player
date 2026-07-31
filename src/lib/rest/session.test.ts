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
