const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal)$/i;
const PRIVATE_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/;

/** Returns true if the IP string (v4 or v6) is in a private/reserved range. */
export function isPrivateIp(ip: string): boolean {
  // IPv4-mapped IPv6: "::ffff:1.2.3.4"
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateIp(mapped[1]);

  // Pure IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    if (PRIVATE_IP.test(ip)) return true;
    // CGNAT: 100.64.0.0/10 — second octet 64–127
    const parts = ip.split(".").map(Number);
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }

  // IPv6
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;                                        // loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;      // fc00::/7
  if (lower.startsWith("fe80")) return true;                              // link-local fe80::/10
  return false;
}

export function isAllowedFeedUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname;
  if (PRIVATE_HOST.test(host)) return false;
  if (host.startsWith("[") || host.includes(":")) return false; // IPv6 literals: reject
  if (/^[\d.]+$/.test(host)) return false;                       // any raw IPv4: reject
  return true;
}

/**
 * isAllowedFeedUrl proves the target is a public host; it does NOT prove the
 * target is a feed. Without this check, any public HTTPS URL round-trips
 * through this server — a free anonymizing proxy on your egress bill.
 *
 * The declared Content-Type is only a hint here: feed hosts routinely mislabel
 * as text/plain or application/octet-stream, so trusting it would reject real
 * feeds while an attacker can set it to whatever passes. The body is the
 * authority — a feed opens like XML.
 */
export function looksLikeFeed(body: ArrayBuffer): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(body.slice(0, Math.min(1024, body.byteLength)))
    .replace(/^﻿/, "")
    .trimStart()
    .toLowerCase();
  return (
    head.startsWith("<?xml") ||
    head.startsWith("<rss") ||
    head.startsWith("<feed") ||
    head.startsWith("<rdf:rdf") ||
    head.startsWith("<!doctype rss")
  );
}

/**
 * Resolves all A/AAAA records for hostname and returns false if ANY resolves to
 * a private/reserved IP. Returns false on lookup error (fail-closed).
 * Uses dynamic import so vitest jsdom env doesn't choke on node:dns/promises.
 */
export async function resolvesToPublicIp(hostname: string): Promise<boolean> {
  return (await resolvePublicIps(hostname)).length > 0;
}

export interface PinnedAddress {
  address: string;
  family: number;
}

/**
 * Resolve a hostname to its A/AAAA records and return them ONLY if every one
 * is public. Any private/reserved address, a lookup error, or an empty result
 * yields [] (fail-closed).
 *
 * Returning the addresses — rather than just a yes/no — is what closes the
 * DNS-rebinding window: checking the name and then letting fetch() resolve it
 * again is two independent lookups, and an attacker controlling a 0-TTL record
 * can answer public for the check and private for the fetch. The caller pins
 * these exact addresses for the connection (see relay.ts), so the bytes come
 * from the host we actually validated.
 */
export async function resolvePublicIps(hostname: string): Promise<PinnedAddress[]> {
  try {
    const dns = await import("node:dns/promises");
    const results = await dns.lookup(hostname, { all: true });
    for (const { address } of results) {
      if (isPrivateIp(address)) return [];
    }
    return results.map((r) => ({ address: r.address, family: r.family }));
  } catch {
    return [];
  }
}
