import { describe, it, expect, vi, afterEach } from "vitest";
import { NetworkHold, isOffline } from "./network-hold";

const online = () => window.dispatchEvent(new Event("online"));

describe("NetworkHold", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resumes once when the network comes back", () => {
    const h = new NetworkHold();
    const resume = vi.fn();
    h.hold(resume, false);
    expect(h.holding).toBe(true);
    online();
    online();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(h.holding).toBe(false);
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
    expect(h.holding).toBe(true);
    expect(h.resumeNow()).toBe(true);
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

    const listener = vi.fn();
    h.hold(vi.fn(), true); // the listener's pause
    h.hold(listener, false);
    online();
    expect(listener).not.toHaveBeenCalled();
  });

  it("reads navigator.onLine", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(isOffline()).toBe(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    expect(isOffline()).toBe(false);
  });
});
