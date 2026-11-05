// Covers kept with the app: the built-in shows' (public/shows) and the
// catalog's (public/catalog). Served from here, so showing one sends nothing
// to the show's host; a show added by link has none, and draws its own.

import { CATALOG } from "./catalog";

export function localCover(feed: { id: string; url: string; builtin?: boolean }): string | undefined {
  if (feed.builtin) return `/shows/${feed.id}.jpg`;
  return CATALOG.find((c) => c.url === feed.url)?.art;
}
