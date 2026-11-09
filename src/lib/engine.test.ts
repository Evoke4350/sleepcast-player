import { describe, it, expect } from "vitest";
import { formatTime, parseFeedXml, diverseByMeta, feedVolume, rearmMinutes, secondsToEnd } from "./engine";
import type { Episode } from "./engine";

const eps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, title: `E${i}`, url: `u${i}`, feedId: "f", date: "" }));

describe("formatTime", () => {
  it("renders", () => { expect(formatTime(90)).toBe("1:30"); expect(formatTime(3600)).toBe("1:00:00"); });
});

describe("parseFeedXml", () => {
  it("extracts episodes with enclosures", () => {
    const xml = `<rss><channel><title>Show</title><item><title>Ep1</title><guid>g1</guid><pubDate>Tue, 09 Jun 2026 16:00:00 -0000</pubDate><enclosure url="https://x/a.mp3" length="1"/></item><item><title>NoAudio</title></item></channel></rss>`;
    const f = parseFeedXml(xml, "feed1");
    expect(f.title).toBe("Show");
    expect(f.episodes.length).toBe(1);
    expect(f.episodes[0]).toMatchObject({ id: "g1", url: "https://x/a.mp3", feedId: "feed1" });
  });
  it("extracts itunes:image artwork", () => {
    const xml = `<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Show</title><itunes:image href="https://x/art.jpg"/><image><url>https://x/legacy.png</url></image></channel></rss>`;
    expect(parseFeedXml(xml, "f").artwork).toBe("https://x/art.jpg");
  });
  it("falls back to image>url artwork", () => {
    const xml = `<rss><channel><title>Show</title><image><url>https://x/legacy.png</url><title>Show</title></image></channel></rss>`;
    expect(parseFeedXml(xml, "f").artwork).toBe("https://x/legacy.png");
  });
  it("artwork undefined when absent or malformed", () => {
    const bare = `<rss><channel><title>Show</title></channel></rss>`;
    expect(parseFeedXml(bare, "f").artwork).toBeUndefined();
    const empty = `<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Show</title><itunes:image/><image></image></channel></rss>`;
    expect(parseFeedXml(empty, "f").artwork).toBeUndefined();
  });
});

describe("diverseByMeta", () => {
  const mk = (n: number): Episode[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `e${i}`, title: `Ep ${i}`, url: "u", feedId: `f${i % 3}`,
      date: `${2018 + (i % 4)}-01-02`,
    }));
  it("spreads picks across feed-year buckets", () => {
    const picks = diverseByMeta(mk(60), 8, () => 0.5);
    expect(picks.length).toBe(8);
    const buckets = new Set(picks.map((e) => `${e.feedId}|${new Date(e.date).getFullYear()}`));
    expect(buckets.size).toBeGreaterThanOrEqual(6);
  });
  it("returns everything when pool is small", () => {
    expect(diverseByMeta(mk(5), 8).length).toBe(5);
  });
});

describe("feedVolume", () => {
  it("is the trim, clamped to [0, 1]", () => {
    expect(feedVolume(0.5)).toBe(0.5);
    expect(feedVolume(1.5)).toBe(1);
    expect(feedVolume(-0.2)).toBe(0);
  });
});

describe("rearmMinutes", () => {
  it("halves and rounds to nearest 5", () => {
    expect(rearmMinutes(60)).toBe(30);
    expect(rearmMinutes(45)).toBe(25); // 22.5 -> 25
  });
  it("floors at 10", () => {
    expect(rearmMinutes(15)).toBe(10);
    expect(rearmMinutes(10)).toBe(10);
    expect(rearmMinutes(5)).toBe(10);
  });
});

describe("secondsToEnd", () => {
  it("minutes mode follows the timer", () => {
    expect(secondsToEnd("minutes", 42, 100)).toBe(42);
  });
  it("one-episode follows episode remaining, Infinity until known", () => {
    expect(secondsToEnd("one-episode", 42, 30)).toBe(30);
    expect(secondsToEnd("one-episode", 42, null)).toBe(Infinity);
  });
  it("all-night never ends on its own", () => {
    expect(secondsToEnd("all-night", 42, 30)).toBe(Infinity);
  });
});

describe("parseFeedXml details", () => {
  const xml = `<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Show</title><itunes:author>Otis</itunes:author><description><![CDATA[<p>Old books, read slowly.</p>]]></description>
    <item><title>Ep1</title><guid>g1</guid><enclosure url="https://x/a.mp3"/><itunes:duration>1:02:03</itunes:duration><description><![CDATA[Chapter <b>one</b>.]]></description><itunes:author>Item author</itunes:author></item>
    <item><title>Ep2</title><guid>g2</guid><enclosure url="https://x/b.mp3"/><itunes:summary>Chapter two</itunes:summary></item></channel></rss>`;
  const f = parseFeedXml(xml, "f");
  it("reads lengths when the feed gives them", () => {
    expect(f.episodes[0].durationSec).toBe(3723);
    expect("durationSec" in f.episodes[1]).toBe(false);
  });
  it("keeps episode notes beside the episodes, not on them", () => {
    expect(f.notes).toEqual({ g1: "Chapter one.", g2: "Chapter two" });
    expect("note" in f.episodes[0]).toBe(false);
  });
  it("reads the channel's author and description, not an item's", () => {
    expect(f.author).toBe("Otis");
    expect(f.about).toBe("Old books, read slowly.");
  });
});
