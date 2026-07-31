import { describe, it, expect } from "vitest";
import { fadeVolume, formatTime, parseFeedXml, diverseByMeta } from "./engine";
import type { Episode } from "./engine";

const eps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, title: `E${i}`, url: `u${i}`, feedId: "f", date: "" }));

describe("fadeVolume", () => {
  it("1 outside window, 0 at end, monotonic", () => {
    expect(fadeVolume(600, 60)).toBe(1);
    expect(fadeVolume(0, 60)).toBe(0);
    let prev = 1;
    for (let s = 60; s >= 0; s--) { const v = fadeVolume(s, 60); expect(v).toBeLessThanOrEqual(prev); prev = v; }
  });
});

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
