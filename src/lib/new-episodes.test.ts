import { describe, it, expect, beforeEach } from "vitest";
import { isNew, loadSeen, markSeen, newCount, newestOf, seedSeen } from "./new-episodes";

const d = (iso: string) => ({ date: iso });
const T = (iso: string) => Date.parse(iso);

describe("new episodes", () => {
  beforeEach(() => localStorage.clear());

  it("newest ignores undated episodes", () => {
    expect(newestOf([d("2026-11-01"), d("junk"), d("2026-11-03")])).toBe(T("2026-11-03"));
    expect(newestOf([])).toBe(0);
  });

  it("a show without a mark has nothing new", () => {
    expect(newCount("a", [d("2026-11-01")], {})).toBe(0);
  });

  it("counts episodes after the mark, and opening the show clears them", () => {
    markSeen("a", [d("2026-11-01"), d("2026-10-01")]);
    const eps = [d("2026-11-05"), d("2026-11-03"), d("2026-11-01"), d("2026-10-01")];
    expect(newCount("a", eps, loadSeen())).toBe(2);
    expect(isNew(eps[0], loadSeen().a)).toBe(true);
    expect(isNew(eps[2], loadSeen().a)).toBe(false);
    markSeen("a", eps);
    expect(newCount("a", eps, loadSeen())).toBe(0);
  });

  it("seeding marks only shows without one, only once loaded", () => {
    markSeen("a", [d("2026-10-01")]);
    expect(seedSeen({ a: [d("2026-11-01")], b: [d("2026-11-02")], c: [], e: undefined })).toBe(true);
    const seen = loadSeen();
    expect(seen.a).toBe(T("2026-10-01")); // kept
    expect(seen.b).toBe(T("2026-11-02"));
    expect(seen.c).toBeUndefined();
    expect(seedSeen({ a: [d("2026-11-01")], b: [d("2026-11-02")] })).toBe(false);
  });
});
