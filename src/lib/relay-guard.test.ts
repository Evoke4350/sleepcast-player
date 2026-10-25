import { describe, it, expect } from "vitest";
import { isAllowedFeedUrl, looksLikeFeed, readCapped } from "./relay-guard";

const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("looksLikeFeed", () => {
  it("accepts the shapes real feeds arrive in", () => {
    expect(looksLikeFeed(buf('<?xml version="1.0"?><rss version="2.0"></rss>'))).toBe(true);
    expect(looksLikeFeed(buf('<rss version="2.0"><channel></channel></rss>'))).toBe(true);
    expect(looksLikeFeed(buf('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'))).toBe(true);
    expect(looksLikeFeed(buf('<rdf:RDF xmlns="http://purl.org/rss/1.0/"></rdf:RDF>'))).toBe(true);
  });

  it("tolerates a BOM, leading whitespace, and odd casing", () => {
    expect(looksLikeFeed(buf('﻿<?xml version="1.0"?><rss></rss>'))).toBe(true);
    expect(looksLikeFeed(buf('\n\n  <?xml version="1.0"?><rss></rss>'))).toBe(true);
    expect(looksLikeFeed(buf('<?XML version="1.0"?><RSS></RSS>'))).toBe(true);
  });

  it("rejects the payloads that would make this a general-purpose proxy", () => {
    expect(looksLikeFeed(buf("<!doctype html><html><body>hi</body></html>"))).toBe(false);
    expect(looksLikeFeed(buf('{"not":"a feed"}'))).toBe(false);
    expect(looksLikeFeed(buf("\x89PNG\r\n\x1a\n"))).toBe(false);
    expect(looksLikeFeed(buf("plain text file"))).toBe(false);
    expect(looksLikeFeed(buf(""))).toBe(false);
  });

  it("does not let a feed marker further down the body vouch for the file", () => {
    // An attacker appending "<rss>" after 1KB of payload must not pass.
    expect(looksLikeFeed(buf("x".repeat(2000) + "<rss></rss>"))).toBe(false);
  });
});

describe("isAllowedFeedUrl", () => {
  it("accepts https podcast hosts", () => {
    expect(isAllowedFeedUrl("https://feeds.supercast.com/feeds/abc")).toBe(true);
    expect(isAllowedFeedUrl("https://feed.sleepwithmepodcast.com/")).toBe(true);
  });
  it("rejects http, localhost, private IPs, fly internal", () => {
    for (const u of ["http://feeds.supercast.com/x", "https://localhost/x", "https://127.0.0.1/x",
      "https://10.0.0.1/x", "https://192.168.1.1/x", "https://172.16.0.1/x", "https://169.254.169.254/x",
      "https://[fdaa::1]/x", "https://sleepcast.internal/x", "not a url"]) {
      expect(isAllowedFeedUrl(u)).toBe(false);
    }
  });
});

describe("readCapped", () => {
  // A body with no content-length used to be read whole with arrayBuffer()
  // and only then measured, so an endless or huge chunked response was
  // buffered into the 512MB machine before the cap applied.
  function streamOf(chunks: number, size: number, onPull?: () => void): Response {
    let sent = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(c) {
        onPull?.();
        if (sent++ >= chunks) { c.close(); return; }
        c.enqueue(new Uint8Array(size).fill(60));
      },
    }));
  }

  it("returns the body when it fits", async () => {
    const buf = await readCapped(streamOf(3, 10), 100);
    expect(buf?.byteLength).toBe(30);
  });

  it("returns null once the body passes the cap, without reading the rest", async () => {
    let pulls = 0;
    const buf = await readCapped(streamOf(1_000_000, 1024, () => pulls++), 4096);
    expect(buf).toBeNull();
    expect(pulls).toBeLessThan(10);
  });

  it("handles an empty body", async () => {
    expect((await readCapped(new Response(null), 10))?.byteLength).toBe(0);
  });
});
