// A backup of everything the listener has built up, as one file.
//
// All of it lives in this browser's localStorage and nowhere else: clearing
// site data, Safari's seven-day purge for sites not visited, or a new phone
// loses the feeds, the play ledger and every night the rest engine learned
// from. The file is the raw stored strings for the keys below, so a restore
// is the same bytes back and every loader's own sanitizing still applies.
//
// Left out on purpose: the feed caches (re-fetchable, and megabytes each),
// the night in progress and last night (short-lived, and tied to the episodes
// on the device they were played on), and the one-off cleanup marker.

import { evictOneFeedCache, loadState } from "./store";
import { downloadFile } from "./download";
import { noteBackedUp } from "./keep";

export const BACKUP_KEYS = [
  "sleepcast2.state",
  "sleepcast2.timer",
  "sleepcast2.plays",
  "sleepcast2.positions",
  "sleepcast2.blocked",
  "sleepcast2.rest",
  "sleepcast2.rest.params",
  "sleepcast2.rest.quiet",
  "sleepcast2.rest.stepback",
  "sleepcast2.rest.goodbye",
  "sleepcast2.experiment",
  "sleepcast2.keptTimer",
] as const;

const APP = "sleepcast";
const VERSION = 1;
// Removing it makes the load-time cleanup (web-cleanup.ts) run again over
// what was restored, in case the backup predates it.
const CLEANUP_KEY = "sleepcast2.cleanup";

export interface Backup {
  app: typeof APP;
  version: typeof VERSION;
  exportedAt: string;
  data: Partial<Record<(typeof BACKUP_KEYS)[number], string>>;
}

export interface BackupSummary {
  feeds: number;
  nights: number;
  plays: number;
}

// The feeds and settings aren't stored until something is first changed:
// until then they are the defaults, which is what loadState returns.
function storedOrDefault(k: (typeof BACKUP_KEYS)[number]): string | null {
  const v = localStorage.getItem(k);
  if (v === null && k === "sleepcast2.state") return JSON.stringify(loadState());
  return v;
}

export function buildBackup(now = new Date()): Backup {
  const data: Backup["data"] = {};
  for (const k of BACKUP_KEYS) {
    const v = storedOrDefault(k);
    if (v !== null) data[k] = v;
  }
  return { app: APP, version: VERSION, exportedAt: now.toISOString(), data };
}

/** Save a backup file and remember when, for the reminder (keep.ts). */
export function downloadBackup(now = new Date()): BackupSummary {
  downloadFile(new Blob([JSON.stringify(buildBackup(now))], { type: "application/json" }), backupFilename(now));
  noteBackedUp(now.getTime());
  return summarizeStored();
}

/** sleepcast-backup-2026-10-22.json, in local time. */
export function backupFilename(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `sleepcast-backup-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.json`;
}

function count(raw: string | undefined | null, pick: (v: unknown) => unknown): number {
  if (!raw) return 0;
  try {
    const v = pick(JSON.parse(raw));
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

export function summarize(data: Record<string, string | undefined | null>): BackupSummary {
  return {
    feeds: count(data["sleepcast2.state"], (s) => (s as { feeds?: unknown })?.feeds),
    nights: count(data["sleepcast2.rest"], (n) => n),
    plays: count(data["sleepcast2.plays"], (p) => p),
  };
}

/** What is stored here now, in the same terms as a backup's summary. */
export function summarizeStored(): BackupSummary {
  const data: Record<string, string | null> = {};
  for (const k of BACKUP_KEYS) data[k] = storedOrDefault(k);
  return summarize(data);
}

export type ParsedBackup =
  | { ok: true; backup: Backup; summary: BackupSummary }
  | { ok: false; error: string };

export function parseBackup(text: string): ParsedBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't a Sleepcast backup. Pick the .json file Back up saved." };
  }
  const b = raw as Partial<Backup> | null;
  if (!b || typeof b !== "object" || b.app !== APP || typeof b.data !== "object" || b.data === null) {
    return { ok: false, error: "That file isn't a Sleepcast backup. Pick the .json file Back up saved." };
  }
  if (typeof b.version !== "number" || b.version > VERSION) {
    return { ok: false, error: "That backup is from a newer Sleepcast. Reload the page to update, then try again." };
  }
  const data: Backup["data"] = {};
  for (const k of BACKUP_KEYS) {
    const v = (b.data as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (typeof v !== "string") return { ok: false, error: "That backup is damaged, so nothing was changed." };
    try {
      JSON.parse(v);
    } catch {
      return { ok: false, error: "That backup is damaged, so nothing was changed." };
    }
    data[k] = v;
  }
  const state = data["sleepcast2.state"];
  if (!state || !Array.isArray((JSON.parse(state) as { feeds?: unknown })?.feeds)) {
    return { ok: false, error: "That backup has no feeds or settings in it, so nothing was changed." };
  }
  const exportedAt = typeof b.exportedAt === "string" ? b.exportedAt : "";
  const backup: Backup = { app: APP, version: VERSION, exportedAt, data };
  return { ok: true, backup, summary: summarize(data) };
}

/**
 * Replace what's stored with the backup. All or nothing: if the browser runs
 * out of room partway, what was there before is put back and this throws.
 * The caller reloads afterwards so every loader reads the restored data.
 */
export function restoreBackup(backup: Backup): void {
  const before = new Map<string, string | null>();
  for (const k of BACKUP_KEYS) before.set(k, localStorage.getItem(k));
  // The feed caches are the only thing taking real room, and they refetch.
  while (evictOneFeedCache()) { /* free the quota for the restore */ }
  try {
    for (const k of BACKUP_KEYS) {
      const v = backup.data[k];
      if (v === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    }
  } catch (e) {
    for (const [k, v] of before) {
      try {
        if (v === null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch { /* the old values fit before; nothing better to do */ }
    }
    throw e;
  }
  try { localStorage.removeItem(CLEANUP_KEY); } catch { /* ignore */ }
  // What's here now is that backup: nights after it are the ones at risk.
  const at = Date.parse(backup.exportedAt);
  noteBackedUp(Number.isFinite(at) ? at : Date.now());
}
