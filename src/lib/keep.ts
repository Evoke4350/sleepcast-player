// Keeping the listener's history from being lost.
//
// Everything lives in this browser's localStorage, which the browser may
// clear on its own: Safari drops a site's storage after seven days without a
// visit, and any browser may evict it when the disk runs low. Two defences:
// ask the browser to keep it (navigator.storage.persist, granted or not as
// the browser sees fit), and remind the listener to save a backup once there
// are enough nights since the last one to be worth losing sleep over.

import { writeMakingRoom } from "./store";

const KEY_BACKED_UP = "sleepcast2.backup.at";
const KEY_SNOOZE = "sleepcast2.backup.snooze";

/** Nights to have recorded, with no backup yet, before the first reminder. */
export const FIRST_REMINDER_NIGHTS = 5;
/** New nights since the last backup before the next reminder. */
export const NEXT_REMINDER_NIGHTS = 14;
/** How long "Not now" holds the reminder off. */
export const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/** When the last backup was saved here (or restored from), or null. */
export function lastBackedUpAt(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY_BACKED_UP));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function noteBackedUp(at = Date.now()): void {
  writeMakingRoom(KEY_BACKED_UP, String(at));
  try { localStorage.removeItem(KEY_SNOOZE); } catch { /* ignore */ }
}

export function snoozeBackupReminder(now = Date.now()): void {
  writeMakingRoom(KEY_SNOOZE, String(now + SNOOZE_MS));
}

function snoozedUntil(): number {
  try {
    return Number(localStorage.getItem(KEY_SNOOZE)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Whether to remind the listener to back up, and how many nights the
 * reminder is about: those recorded since the last backup, or all of them
 * when there has been none. Null when there's too little to lose, or while
 * snoozed.
 */
export function backupReminder(
  nights: readonly { startedAt: number }[],
  now = Date.now(),
): { nights: number; everBackedUp: boolean } | null {
  if (snoozedUntil() > now) return null;
  const at = lastBackedUpAt();
  const since = at === null ? nights.length : nights.filter((n) => n.startedAt > at).length;
  const due = at === null ? FIRST_REMINDER_NIGHTS : NEXT_REMINDER_NIGHTS;
  return since >= due ? { nights: since, everBackedUp: at !== null } : null;
}

/**
 * Ask the browser to exempt this site's storage from clearing on its own.
 * Chrome and Safari decide silently (Home Screen apps, frequent visits);
 * Firefox asks, so this is only called once there's history to keep.
 * Resolves to whether storage is now persistent; false where unsupported.
 */
export async function keepStorage(): Promise<boolean> {
  const s = typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!s?.persisted || !s.persist) return false;
  try {
    return (await s.persisted()) || (await s.persist());
  } catch {
    return false;
  }
}

/** Whether storage is persistent, without asking for it. */
export async function storageKept(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    return false;
  }
}
