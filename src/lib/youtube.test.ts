import { describe, expect, test } from "vitest";
import { youtubeFeedUrl, parseYouTubeFeed, parseFeedFor } from "./youtube";

describe("turning what someone pastes into a feed URL", () => {
  test("a channel URL", () => {
    expect(youtubeFeedUrl("https://www.youtube.com/channel/UCuDUP15RMVaHsZ-ln9SyYqg")).toEqual({
      kind: "feed",
      url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCuDUP15RMVaHsZ-ln9SyYqg",
    });
  });

  test("a playlist URL", () => {
    expect(youtubeFeedUrl("https://www.youtube.com/playlist?list=PLabc123")).toEqual({
      kind: "feed",
      url: "https://www.youtube.com/feeds/videos.xml?playlist_id=PLabc123",
    });
  });

  test("the feed URL itself, pasted straight in", () => {
    const u = "https://www.youtube.com/feeds/videos.xml?channel_id=UCuDUP15RMVaHsZ-ln9SyYqg";
    expect(youtubeFeedUrl(u)).toEqual({ kind: "feed", url: u });
  });

  test("m.youtube.com and a missing scheme still resolve", () => {
    expect(youtubeFeedUrl("m.youtube.com/channel/UCuDUP15RMVaHsZ-ln9SyYqg")).toEqual({
      kind: "feed",
      url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCuDUP15RMVaHsZ-ln9SyYqg",
    });
  });

  test("an @handle cannot be resolved without fetching the page, and says so", () => {
    // The channel_id is not derivable from the handle — it only appears in the
    // HTML. Returning null here would be indistinguishable from "not YouTube",
    // and the user would get a generic "bad feed" for a URL that is obviously
    // a channel. So it is its own outcome, and the UI can say what to do.
    expect(youtubeFeedUrl("https://www.youtube.com/@bubexplains")).toEqual({
      kind: "handle",
      handle: "bubexplains",
    });
  });

  test("a watch URL is a single video, not a channel", () => {
    expect(youtubeFeedUrl("https://www.youtube.com/watch?v=Km4dGTJYiwQ")).toEqual({
      kind: "unsupported",
      reason: "video",
    });
  });

  test("anything that is not YouTube is not ours to claim", () => {
    expect(youtubeFeedUrl("https://example.com/feed.xml")).toBeNull();
    expect(youtubeFeedUrl("https://notyoutube.com/channel/UCabc")).toBeNull();
  });

  test("a lookalike host does not pass", () => {
    // youtube.com.evil.test ends with neither youtube.com nor a dot boundary
    // into it — the check must be on the host, not a substring of the URL.
    expect(youtubeFeedUrl("https://youtube.com.evil.test/channel/UCabc")).toBeNull();
  });
});

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/"
      xmlns="http://www.w3.org/2005/Atom">
  <title>Bub Explains</title>
  <entry>
    <id>yt:video:AAAAAAAAAAA</id>
    <yt:videoId>AAAAAAAAAAA</yt:videoId>
    <title>Confusing Facts About Algebra To Help You Sleep</title>
    <published>2026-07-01T10:00:00+00:00</published>
    <media:group>
      <media:thumbnail url="https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg"/>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:BBBBBBBBBBB</id>
    <yt:videoId>BBBBBBBBBBB</yt:videoId>
    <title>Everything About The Milky Way To Help You Sleep</title>
    <published>2026-06-20T10:00:00+00:00</published>
  </entry>
</feed>`;

describe("parsing a YouTube Atom feed into episodes", () => {
  test("reads the channel title, not the fallback", () => {
    // parseFeedXml looks for `channel > title` and finds nothing in Atom, so a
    // YouTube feed added today shows up called literally "feed".
    expect(parseYouTubeFeed(ATOM, "f1").title).toBe("Bub Explains");
  });

  test("every entry becomes an episode", () => {
    const feed = parseYouTubeFeed(ATOM, "f1");
    expect(feed.episodes.length).toBe(2);
    expect(feed.episodes[0].title).toBe("Confusing Facts About Algebra To Help You Sleep");
    expect(feed.episodes[0].feedId).toBe("f1");
  });

  test("carries the video id, which is what the player needs", () => {
    const [first] = parseYouTubeFeed(ATOM, "f1").episodes;
    expect(first.youtubeId).toBe("AAAAAAAAAAA");
  });

  test("url is the watch page, so a broken night is still diagnosable", () => {
    const [first] = parseYouTubeFeed(ATOM, "f1").episodes;
    expect(first.url).toBe("https://www.youtube.com/watch?v=AAAAAAAAAAA");
  });

  test("the id is stable across refetches", () => {
    const a = parseYouTubeFeed(ATOM, "f1").episodes[0].id;
    const b = parseYouTubeFeed(ATOM, "f1").episodes[0].id;
    expect(a).toBe(b);
    expect(a).toContain("AAAAAAAAAAA");
  });

  test("published date survives, because the spread buckets by year", () => {
    expect(parseYouTubeFeed(ATOM, "f1").episodes[0].date).toBe("2026-07-01T10:00:00+00:00");
  });

  test("takes channel artwork from the first thumbnail it can find", () => {
    expect(parseYouTubeFeed(ATOM, "f1").artwork).toBe(
      "https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg",
    );
  });

  test("falls back to the <id> when yt:videoId is absent", () => {
    // <id> is "yt:video:ID" and is plain Atom; yt:videoId is the prefixed
    // convenience. A feed carrying only the former is still playable.
    const noPrefixed = ATOM.replace("<yt:videoId>BBBBBBBBBBB</yt:videoId>", "");
    const ids = parseYouTubeFeed(noPrefixed, "f1").episodes.map((e) => e.youtubeId);
    expect(ids).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB"]);
  });

  test("an entry with no video id at all is skipped rather than played as silence", () => {
    const broken = ATOM.replace("<yt:videoId>BBBBBBBBBBB</yt:videoId>", "").replace(
      "<id>yt:video:BBBBBBBBBBB</id>",
      "<id>tag:something-else</id>",
    );
    expect(parseYouTubeFeed(broken, "f1").episodes.length).toBe(1);
  });

  test("a podcast RSS feed handed here yields nothing, not garbage", () => {
    const rss = `<rss><channel><title>Show</title><item><title>Ep</title></item></channel></rss>`;
    expect(parseYouTubeFeed(rss, "f1").episodes).toEqual([]);
  });
});

describe("choosing a parser for a feed", () => {
  test("a YouTube feed URL gets the YouTube parser", () => {
    const feed = parseFeedFor(ATOM, "f1", "https://www.youtube.com/feeds/videos.xml?channel_id=UCabc");
    expect(feed.title).toBe("Bub Explains");
    expect(feed.episodes[0].youtubeId).toBe("AAAAAAAAAAA");
  });

  test("a podcast URL gets the podcast parser", () => {
    const rss = `<rss><channel><title>Show</title><item><title>Ep1</title><guid>g1</guid><enclosure url="https://x/a.mp3"/></item></channel></rss>`;
    const feed = parseFeedFor(rss, "f1", "https://example.com/feed.xml");
    expect(feed.title).toBe("Show");
    expect(feed.episodes[0].url).toBe("https://x/a.mp3");
    expect(feed.episodes[0].youtubeId).toBeUndefined();
  });

  test("dispatch is on the URL, not on Atom-vs-RSS", () => {
    // Legitimate podcasts publish Atom with real enclosures. Sniffing the
    // document and sending every <feed> to the YouTube parser would drop every
    // one of their episodes, since none carry a videoId.
    const atomPodcast = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Show</title><entry><title>Ep</title><id>tag:1</id></entry></feed>`;
    const feed = parseFeedFor(atomPodcast, "f1", "https://example.com/atom.xml");
    expect(feed.episodes).toEqual([]);
    expect(feed.title).not.toBe("YouTube channel");
  });
});
