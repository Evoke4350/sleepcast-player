// Turning a YouTube @handle into a channel id.
//
// This exists because the alternative was worse. YouTube's Atom feed is keyed
// on channel_id, and a handle does not contain one — it only appears in the
// channel page's HTML. The app used to say so and tell the listener to open
// the channel, tap its name, and copy the /channel/UC… address. On a phone
// that instruction is close to impossible to follow: YouTube shows handles
// nearly everywhere now and rarely offers the id at all. So a URL that is
// obviously a channel was rejected with a chore attached.
//
// The server does the lookup instead. Two things keep that from becoming a
// second, softer version of the open proxy /api/relay's guard exists to
// prevent:
//
//   - The handle is validated to a narrow character class BEFORE it is put in
//     a URL, so this endpoint can only ever fetch a youtube.com channel page.
//     It is not "a URL with a check on it" — there is no URL from the caller.
//   - The only thing that ever comes back is a 24-character channel id. The
//     page itself is never returned, so this cannot be used to read anything.

/** YouTube handles: letters, digits, dot, underscore, hyphen. 3–30 in
 *  practice; 64 here so a future loosening does not break working links. */
const HANDLE = /^[A-Za-z0-9._-]{1,64}$/;

/** UC followed by exactly 22 characters of base64url. */
const CHANNEL_ID = /UC[A-Za-z0-9_-]{22}/;

/**
 * The channel page for a handle, or null if the handle is not one we will put
 * in a URL. Anything with a slash, a scheme, a query, a fragment or
 * whitespace is refused rather than escaped: escaping is a judgement call and
 * this does not need to make one.
 */
export function youtubeHandleUrl(handle: string): string | null {
  const clean = handle.startsWith("@") ? handle.slice(1) : handle;
  if (!HANDLE.test(clean)) return null;
  return `https://www.youtube.com/@${clean}`;
}

const CANONICAL = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i;
const OG_URL = /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i;

function idFromChannelUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(new RegExp(`/channel/(${CHANNEL_ID.source})(?:[/?#]|$)`));
  return m ? m[1] : null;
}

/**
 * The channel id a page declares itself to have, or null.
 *
 * Ordered by how much the page is asserting rather than merely mentioning:
 * canonical and og:url are the page saying what it is, externalId is its own
 * data about itself, browseId is a link target that happens to appear dozens
 * of times. A canonical pointing at a video yields null rather than the first
 * UC-shaped string on the page — a mistyped handle can land somewhere else
 * entirely, and subscribing the listener to a channel they never asked for is
 * worse than telling them it did not work.
 */
export function channelIdFromHtml(html: string): string | null {
  const canonical = idFromChannelUrl(html.match(CANONICAL)?.[1]);
  if (canonical) return canonical;

  const og = idFromChannelUrl(html.match(OG_URL)?.[1]);
  if (og) return og;

  for (const key of ["externalId", "browseId"]) {
    const m = html.match(new RegExp(`"${key}"\\s*:\\s*"(${CHANNEL_ID.source})"`));
    if (m) return m[1];
  }
  return null;
}
