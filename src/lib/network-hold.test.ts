import { describe, it, expect, vi, afterEach } from "vitest";
import { NetworkHold, isOffline } from "./network-hold";

const online = () => window.dispatchEvent(new Event("online"));

describe("NetworkHold", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resumes once when the network comes back", () => {
    const h = new NetworkHold();
    const resume = vi.fn();
    h.hold(resume, false);
    online();
    online();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(h.resumeNow()).toBe(false); // nothing left pending
  });

  it("holding again replaces the earlier resume", () => {
    const h = new NetworkHold();
    const first = vi.fn();
    const second = vi.fn();
    h.hold(first, false);
    h.hold(second, false);
    online();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a cancelled hold never resumes", () => {
    const h = new NetworkHold();
    const resume = vi.fn();
    h.hold(resume, false);
    h.cancel();
    online();
    expect(h.resumeNow()).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });

  it("stays pending for a tap when auto-resume is not allowed", () => {
    const h = new NetworkHold();
    const resume = vi.fn();
    let allowed = false;
    h.hold(resume, false, () => allowed);
    online();
    expect(resume).not.toHaveBeenCalled();
    expect(h.resumeNow()).toBe(true); // still pending for the tap
    expect(resume).toHaveBeenCalledTimes(1);
    allowed = true;
    online();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("a later online event resumes once auto-resume is allowed", () => {
    const h = new NetworkHold();
    const resume = vi.fn();
    let allowed = false;
    h.hold(resume, false, () => allowed);
    online();
    allowed = true;
    online();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("never auto-resumes over the listener's own pause", () => {
    const h = new NetworkHold();
    const resume = vi.fn();
    h.hold(resume, true);
    online();
    expect(resume).not.toHaveBeenCalled();
    expect(h.resumeNow()).toBe(true);
  });

  it("a re-hold keeps the first reading, not the pause the hold made", () => {
    const h = new NetworkHold();
    const first = vi.fn();
    const second = vi.fn();
    h.hold(first, false);
    h.hold(second, true); // paused by the first hold, not the listener
    online();
    expect(second).toHaveBeenCalledTimes(1);

    h.cancel(); // sound came back
    const listener = vi.fn();
    h.hold(vi.fn(), true); // the listener's pause
    h.hold(listener, false);
    online();
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps the first reading through a resume that fails again", () => {
    const h = new NetworkHold();
    h.hold(vi.fn(), false);
    online(); // the reload runs, is refused, leaves the element paused
    const again = vi.fn();
    h.hold(again, true); // failed again before any sound
    online();
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("takes a fresh reading after cancel()", () => {
    const h = new NetworkHold();
    h.hold(vi.fn(), false);
    h.cancel(); // sound came back
    const later = vi.fn();
    h.hold(later, true); // the listener has since paused
    online();
    expect(later).not.toHaveBeenCalled();
  });

  it("a listener's tap settles the reading: sound was asked for", () => {
    const h = new NetworkHold();
    h.hold(vi.fn(), true); // paused by the listener
    h.resumeNow(true); // then they tapped play, still offline
    const again = vi.fn();
    h.hold(again, true); // failed again
    online();
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("reads navigator.onLine", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(isOffline()).toBe(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    expect(isOffline()).toBe(false);
  });
});
