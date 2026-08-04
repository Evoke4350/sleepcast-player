// YouTube channels as feeds.
//
// YouTube publishes Atom at /feeds/videos.xml, with no API key and no auth. It
// is a *notification* feed, not a media feed: there is no <enclosure>, and the
// only media element it carries is a <media:content> pointing at a Flash URL
// that has not worked since 2020. So a YouTube feed cannot be played by the
// <audio> element the way a podcast enclosure can — it needs the embedded
// player, which is why an episode here carries a videoId rather than a URL to
// stream.
//
// Two limits worth knowing before relying on this:
//   - The feed returns at most 15 entries. There is no paging and no archive.
//     That is a real library for this genre, where a single video runs hours,
//     and would be useless for a normal podcast.
//   - Playback goes through Google's player, which may show ads. Nothing here
//     can mute or skip them; suppressing them would be circumvention, not a
//     feature.

import { parseFeedXml, type Episode, type Feed } from "./engine";

/** Hosts whose /channel and /playlist URLs we will turn into a feed. Matched
 *  as whole hostnames — a substring test would accept youtube.com.evil.test. */
const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

export type YouTubeUrl =
  | { kind: "feed"; url: string }
  /** A channel we can see is a channel but cannot resolve: the channel_id
   *  appears only in the page HTML, never in the handle. The UI needs to tell
   *  the user to open the channel and copy the /channel/UC… URL, and it can
   *  only do that if this case is distinguishable from "not YouTube at all". */
  | { kind: "handle"; handle: string }
  | { kind: "unsupported"; reason: "video" };

const feedFor = (param: "channel_id" | "playlist_id", id: string) =>
  `https://www.youtube.com/feeds/videos.xml?${param}=${id}`;

/**
 * What a pasted YouTube URL means, or null if it is not YouTube and belongs to
 * the normal podcast path.
 */
export function youtubeFeedUrl(input: string): YouTubeUrl | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (!YT_HOSTS.has(url.hostname.toLowerCase())) return null;

  const path = url.pathname.replace(/\/+$/, "");

  // Already a feed URL. Normalised rather than echoed, so the same channel
  // pasted as m.youtube.com and www.youtube.com is one feed, not two.
  if (path === "/feeds/videos.xml") {
    const channel = url.searchParams.get("channel_id");
    if (channel) return { kind: "feed", url: feedFor("channel_id", channel) };
    const playlist = url.searchParams.get("playlist_id");
    if (playlist) return { kind: "feed", url: feedFor("playlist_id", playlist) };
    return null;
  }

  const channel = path.match(/^\/channel\/([A-Za-z0-9_-]+)$/);
  if (channel) return { kind: "feed", url: feedFor("channel_id", channel[1]) };

  if (path === "/playlist") {
    const list = url.searchParams.get("list");
    if (list) return { kind: "feed", url: feedFor("playlist_id", list) };
    return null;
  }

  const handle = path.match(/^\/@([A-Za-z0-9._-]+)/);
  if (handle) return { kind: "handle", handle: handle[1] };

  if (path === "/watch" || path.startsWith("/shorts/")) {
    return { kind: "unsupported", reason: "video" };
  }

  return null;
}

/** True for a feed URL this module produced — the player uses it to decide
 *  which playback backend an episode needs. */
export function isYouTubeFeedUrl(url: string): boolean {
  const parsed = youtubeFeedUrl(url);
  return parsed?.kind === "feed";
}

// Element lookup by localName rather than CSS selectors. YouTube's Atom
// declares a default namespace and prefixes yt: and media:, and selector
// matching across namespaces is inconsistent enough that engine.ts already
// carries a comment about it. Walking localName is namespace-proof.
function descendants(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagName("*")).filter(
    (el) => el.localName === localName,
  );
}

function childText(parent: Element, localName: string): string | undefined {
  for (const el of Array.from(parent.children)) {
    if (el.localName === localName) return el.textContent?.trim() || undefined;
  }
  return undefined;
}

/**
 * A YouTube Atom feed as a Feed. Entries without a video id are dropped rather
 * than kept as unplayable episodes — a night that reaches one would sit in
 * silence while the timer ran down, which is the worst failure this app has.
 */
export function parseYouTubeFeed(xmlText: string, feedId: string): Feed {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");

  const root = doc.documentElement;
  const title =
    (root && root.localName === "feed" ? childText(root, "title") : undefined) ??
    "YouTube channel";

  const episodes: Episode[] = [];
  for (const entry of descendants(doc, "entry")) {
    // <yt:videoId> is the reliable source; <id> is "yt:video:ID" and is the
    // fallback for feeds that omit the prefixed element.
    const videoId =
      childText(entry, "videoId") ??
      childText(entry, "id")?.match(/^yt:video:([A-Za-z0-9_-]+)$/)?.[1];
    if (!videoId) continue;

    episodes.push({
      id: childText(entry, "id") || `yt:video:${videoId}`,
      title: childText(entry, "title") ?? "untitled",
      // The watch page, not something streamable. Kept so a night that goes
      // wrong can be traced back to an actual video by a human.
      url: `https://www.youtube.com/watch?v=${videoId}`,
      feedId,
      date: childText(entry, "published") ?? "",
      youtubeId: videoId,
    });
  }

  const artwork = descendants(doc, "thumbnail")
    .map((el) => el.getAttribute("url") || undefined)
    .find(Boolean);

  return { id: feedId, title, episodes, artwork };
}

/**
 * Parse a feed with whichever parser its source URL calls for.
 *
 * Dispatch is on the URL, deliberately, not on whether the document is Atom or
 * RSS. Plenty of legitimate podcasts publish Atom with real enclosures, and
 * routing every <feed> to the YouTube parser would drop every one of their
 * episodes — none of them carry a videoId.
 */
export function parseFeedFor(xmlText: string, feedId: string, feedUrl: string): Feed {
  return isYouTubeFeedUrl(feedUrl)
    ? parseYouTubeFeed(xmlText, feedId)
    : parseFeedXml(xmlText, feedId);
}
