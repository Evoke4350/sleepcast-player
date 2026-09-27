import { describe, it, expect, vi, afterEach } from "vitest";
import { NetworkHold, isOffline } from "./network-hold";

const online = () => window.dispatchEvent(new Event("online"));

describe("NetworkHold", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resumes once when the network comes back", () => {
    const h = new NetworkHold();
    const resume = vi.fn();
    h.hold(resume);
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
    h.hold(first);
    h.hold(second);
    online();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a cancelled hold never resumes", () => {
    const h = new NetworkHold();
    const resume = vi.fn();
    h.hold(resume);
    h.cancel();
    online();
    expect(h.resumeNow()).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });

  it("stays pending for a tap when auto-resume is not allowed", () => {
    const h = new NetworkHold();
    const resume = vi.fn();
    let allowed = false;
    h.hold(resume, () => allowed);
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
    h.hold(resume, () => allowed);
    online();
    allowed = true;
    online();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("reads navigator.onLine", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(isOffline()).toBe(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    expect(isOffline()).toBe(false);
  });
});
