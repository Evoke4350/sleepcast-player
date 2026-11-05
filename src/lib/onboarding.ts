// The first visit: a welcome, the age question, a few shows to start with,
// and the analytics choice. Once per device, and never for someone who was
// already using Sleepcast before it existed.

import { storedAge } from "./age";
import { storedConsent } from "./analytics";
import { BUILTIN_FEEDS, addCustomFeed, loadState, saveState } from "./store";
import { CATALOG } from "./catalog";

export const ONBOARDED_KEY = "sc-onboarded";

/** Whether this device should see the first-visit screens: not seen them,
 *  and no sign of earlier use (the app's own data, an age answered, an
 *  analytics choice made). */
export function needsOnboarding(): boolean {
  try {
    if (localStorage.getItem(ONBOARDED_KEY)) return false;
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith("sleepcast2.")) return false;
    }
  } catch {
    return false; // no storage: nothing to remember the answers in
  }
  return storedAge() === null && storedConsent() === null;
}

export function markOnboarded(): void {
  try { localStorage.setItem(ONBOARDED_KEY, "1"); } catch { /* asks again next visit */ }
}

/** A show to pick on the first visit: the built-ins, then the catalog. */
// The built-ins' covers live in public/shows, copied like the catalog's, so
// the picker sends nothing to any show's host.
export interface StarterShow {
  key: string;
  title: string;
  art: string;
  builtinId?: string;
  url: string;
}

export const STARTER_SHOWS: StarterShow[] = [
  ...BUILTIN_FEEDS.map((f) => ({ key: f.id, title: f.title, art: `/shows/${f.id}.jpg`, builtinId: f.id, url: f.url })),
  ...CATALOG.map((c) => ({ key: c.url, title: c.title, art: c.art, url: c.url })),
];

/** Make the picked shows the ones in the shuffle: built-ins on or off, the
 *  catalog's added. With nothing picked, the defaults stand. */
export function applyStarterShows(keys: ReadonlySet<string>): void {
  if (keys.size === 0) return;
  let s = loadState();
  s = { ...s, feeds: s.feeds.map((f) => (f.builtin ? { ...f, enabled: keys.has(f.id) } : f)) };
  for (const show of STARTER_SHOWS) {
    if (!show.builtinId && keys.has(show.key)) s = addCustomFeed(s, show.url, show.title, true);
  }
  saveState(s);
}
