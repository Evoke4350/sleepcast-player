import { describe, it, expect } from "vitest";
import { parseOpml, buildOpml } from "./opml";

const SAMPLE = `<?xml version="1.0"?>
<opml version="2.0">
  <head><title>subs</title></head>
  <body>
    <outline text="Podcasts">
      <outline type="rss" text="Sleep With Me" xmlUrl="https://feed.sleepwithmepodcast.com/" />
      <outline type="rss" text="Get Sleepy" xmlUrl="https://feeds.megaphone.fm/SGP8517078272" htmlUrl="https://x" />
    </outline>
    <outline type="rss" text="Flat One" xmlUrl="https://example.com/feed.rss" />
    <outline text="no url here" />
  </body>
</opml>`;

describe("parseOpml", () => {
  it("collects nested and flat outlines with xmlUrl, skips entries without", () => {
    const feeds = parseOpml(SAMPLE);
    expect(feeds).toEqual([
      { url: "https://feed.sleepwithmepodcast.com/", title: "Sleep With Me" },
      { url: "https://feeds.megaphone.fm/SGP8517078272", title: "Get Sleepy" },
      { url: "https://example.com/feed.rss", title: "Flat One" },
    ]);
  });

  it("uses null title when text/title attributes absent", () => {
    const feeds = parseOpml(
      `<opml><body><outline xmlUrl="https://a.example/f"/></body></opml>`
    );
    expect(feeds).toEqual([{ url: "https://a.example/f", title: null }]);
  });

  it("throws on non-OPML documents", () => {
    expect(() => parseOpml("<html><body>nope</body></html>")).toThrow(/OPML/);
    expect(() => parseOpml("{not xml at all")).toThrow(/OPML/);
  });
});

describe("buildOpml", () => {
  it("round-trips through parseOpml", () => {
    const feeds = [
      { url: "https://a.example/f", title: "A" },
      { url: "https://b.example/g", title: 'Quote " & amp' },
    ];
    const xml = buildOpml(feeds);
    expect(parseOpml(xml)).toEqual([
      { url: "https://a.example/f", title: "A" },
      { url: "https://b.example/g", title: 'Quote " & amp' },
    ]);
  });
});
