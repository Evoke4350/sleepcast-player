import { describe, it, expect } from "vitest";
import { isAllowedFeedUrl, isPrivateIp, looksLikeFeed, resolvesToPublicIp, resolvePublicIps, readCapped } from "./relay-guard";

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

describe("isPrivateIp", () => {
  it("returns true for RFC-1918 and reserved IPv4 ranges", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("10.255.255.255")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("169.254.0.1")).toBe(true);
    expect(isPrivateIp("0.0.0.0")).toBe(true);
  });

  it("returns true for CGNAT range 100.64.0.0/10", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
    expect(isPrivateIp("100.127.255.255")).toBe(true);
  });

  it("returns false for public IPv4", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("100.128.0.1")).toBe(false);  // just outside CGNAT
  });

  it("returns true for private/loopback/link-local IPv6", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
  });

  it("returns true for IPv4-mapped IPv6 with private address", () => {
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
  });

  it("returns false for public IPv6", () => {
    expect(isPrivateIp("2607:f8b0::1")).toBe(false);
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });
});

describe("resolvesToPublicIp", () => {
  it("returns false for localhost", async () => {
    expect(await resolvesToPublicIp("localhost")).toBe(false);
  });

  it("returns true for a real public host (real DNS, requires network)", async () => {
    // feeds.supercast.com resolves to Cloudflare/public IPs
    expect(await resolvesToPublicIp("feeds.supercast.com")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolvePublicIps — the DNS-rebinding fix. Returning the validated addresses
// (not just a boolean) is what lets the relay pin the connection to them.
// ---------------------------------------------------------------------------
describe("resolvePublicIps", () => {
  it("returns [] for a hostname that cannot resolve (fail-closed)", async () => {
    const got = await resolvePublicIps("no-such-host.invalid");
    expect(got).toEqual([]);
  });

  it("returns [] for localhost (resolves privately)", async () => {
    const got = await resolvePublicIps("localhost");
    expect(got).toEqual([]);
  });

  it("returns public addresses with their family for a real public host", async () => {
    const got = await resolvePublicIps("example.com");
    expect(got.length).toBeGreaterThan(0);
    for (const p of got) {
      expect(isPrivateIp(p.address)).toBe(false);
      expect([4, 6]).toContain(p.family);
    }
  });

  it("agrees with resolvesToPublicIp", async () => {
    expect(await resolvesToPublicIp("localhost")).toBe(false);
    expect(await resolvesToPublicIp("no-such-host.invalid")).toBe(false);
  });
});

describe("isPrivateIp: addresses that reach this machine or non-public networks", () => {
  // "::" is the unspecified address. Connecting to it reaches localhost on
  // Linux, so a feed host with AAAA "::" pointed the relay at this machine.
  it.each([
    "::",
    "0:0:0:0:0:0:0:0",
    "0:0:0:0:0:0:0:1",
    "::ffff:7f00:1",          // IPv4-mapped loopback, hex form
    "::127.0.0.1",            // IPv4-compatible (deprecated) loopback
    "fe90::1", "febf::1",     // rest of link-local fe80::/10
    "fec0::1",                // site-local (deprecated)
    "ff02::1",                // multicast
    "64:ff9b::a00:1",         // NAT64 prefix mapping 10.0.0.1
    "64:ff9b:1::1",           // local-use NAT64 prefix
    "::ffff:0:7f00:1",        // IPv4-translated loopback
    "::ffff:0:10.0.0.1",      // IPv4-translated private
    "2002:7f00:1::",          // 6to4 of 127.0.0.1
    "2002:c0a8:101::1",       // 6to4 of 192.168.1.1
    "2001:0:4136:e378::1",    // Teredo
    "224.0.0.1",              // IPv4 multicast
    "240.0.0.1",              // reserved
    "255.255.255.255",        // broadcast
    "198.18.0.1",             // benchmarking
    "192.0.0.1",              // IETF protocol assignments
  ])("blocks %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(["2606:4700::6810:84e5", "8.8.8.8", "::ffff:8.8.8.8", "2001:4860:4860::8888", "2002:808:808::1"])("allows public %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
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
