import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  backupReminder, noteBackedUp, snoozeBackupReminder, lastBackedUpAt, keepStorage,
  FIRST_REMINDER_NIGHTS, NEXT_REMINDER_NIGHTS, SNOOZE_MS,
} from "./keep";
import { parseBackup, restoreBackup, buildBackup } from "./backup";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-23T08:00:00Z");
const nightsEnding = (n: number, lastAt = NOW - DAY) => Array.from({ length: n }, (_, i) => ({ startedAt: lastAt - (n - 1 - i) * DAY }));

describe("backupReminder", () => {
  beforeEach(() => localStorage.clear());

  it("waits for a few nights before the first reminder", () => {
    expect(backupReminder(nightsEnding(FIRST_REMINDER_NIGHTS - 1), NOW)).toBeNull();
    expect(backupReminder(nightsEnding(FIRST_REMINDER_NIGHTS), NOW)).toEqual({ nights: FIRST_REMINDER_NIGHTS, everBackedUp: false });
  });

  it("after a backup, counts only the nights since it", () => {
    const nights = nightsEnding(40);
    noteBackedUp(nights[39 - NEXT_REMINDER_NIGHTS + 1].startedAt - 1);
    expect(backupReminder(nights, NOW)).toEqual({ nights: NEXT_REMINDER_NIGHTS, everBackedUp: true });
    noteBackedUp(nights[39 - NEXT_REMINDER_NIGHTS + 2].startedAt - 1);
    expect(backupReminder(nights, NOW)).toBeNull();
  });

  it("Not now holds it off for a week, and a backup clears the snooze", () => {
    const nights = nightsEnding(10);
    snoozeBackupReminder(NOW);
    expect(backupReminder(nights, NOW + SNOOZE_MS - 1)).toBeNull();
    expect(backupReminder(nights, NOW + SNOOZE_MS + 1)).not.toBeNull();
    noteBackedUp(0.5 * NOW);
    expect(localStorage.getItem("sleepcast2.backup.snooze")).toBeNull();
  });

  it("a restore counts as backed up, as of the backup's date", () => {
    localStorage.setItem("sleepcast2.rest", JSON.stringify(nightsEnding(3)));
    const text = JSON.stringify(buildBackup(new Date(NOW)));
    const parsed = parseBackup(text);
    if (!parsed.ok) throw new Error("expected ok");
    restoreBackup(parsed.backup);
    expect(lastBackedUpAt()).toBe(NOW);
  });
});

describe("keepStorage", () => {
  const real = Object.getOwnPropertyDescriptor(navigator, "storage");
  afterEach(() => {
    if (real) Object.defineProperty(navigator, "storage", real);
    else delete (navigator as { storage?: unknown }).storage;
  });
  const fake = (storage: unknown) => Object.defineProperty(navigator, "storage", { value: storage, configurable: true });

  it("asks only when not already kept", async () => {
    const persist = vi.fn(async () => true);
    fake({ persisted: async () => true, persist });
    expect(await keepStorage()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    fake({ persisted: async () => false, persist });
    expect(await keepStorage()).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("false where unsupported or refused", async () => {
    fake(undefined);
    expect(await keepStorage()).toBe(false);
    fake({ persisted: async () => false, persist: async () => { throw new Error("no"); } });
    expect(await keepStorage()).toBe(false);
  });
});
