const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal)$/i;

/** Returns true if the IP string (v4 or v6) is in a private/reserved range,
 *  or is not an address this can parse (fail closed). */
export function isPrivateIp(ip: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return isPrivateIpv4(ip.split(".").map(Number));
  if (ip.includes(":")) {
    const h = ipv6Hextets(ip);
    return h === null ? true : isPrivateIpv6(h);
  }
  return true;
}

function isPrivateIpv4(p: number[]): boolean {
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n > 255)) return true;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return true;           // this network, private, loopback
  if (a === 169 && b === 254) return true;                     // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;            // private
  if (a === 192 && b === 168) return true;                     // private
  if (a === 100 && b >= 64 && b <= 127) return true;           // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;        // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true;         // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;          // TEST-NET-3
  if (a >= 224) return true;                                   // multicast, reserved, broadcast
  return false;
}

/** Expand an IPv6 string (with ::, an optional zone, or an embedded IPv4
 *  tail) into its eight 16-bit groups; null if it isn't valid IPv6. */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = s.slice(0, -v4[0].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 2 && fill === 0)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isPrivateIpv6(h: number[]): boolean {
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d — IPv4-mapped: judge the IPv4 address it carries.
  if (zeros(0, 5) && h[5] === 0xffff) {
    return isPrivateIpv4([h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff]);
  }
  if (zeros(0, 6)) return true;                         // ::/96: unspecified (reaches localhost), loopback, IPv4-compatible
  if (h[0] === 0x64 && h[1] === 0xff9b) return true;    // NAT64 64:ff9b::/96 and local-use 64:ff9b:1::/48
  if (h[0] === 0x100 && zeros(1, 4)) return true;       // discard-only 100::/64
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;  // documentation 2001:db8::/32
  if ((h[0] & 0xfe00) === 0xfc00) return true;          // unique local fc00::/7 (Fly's fdaa:: private net)
  if ((h[0] & 0xffc0) === 0xfe80) return true;          // link-local fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return true;          // site-local fec0::/10 (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true;          // multicast ff00::/8
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

/**
 * Read a response body, giving up as soon as it passes `max` bytes. Returns
 * null when it was too large. arrayBuffer() reads everything before anyone can
 * measure it, so a chunked response with no content-length could stream
 * gigabytes into memory before the size check ran.
 */
export async function readCapped(resp: Response, max: number): Promise<ArrayBuffer | null> {
  if (!resp.body) return new ArrayBuffer(0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}
