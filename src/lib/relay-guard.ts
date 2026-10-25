const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal)$/i;

/** An https URL to a named host that isn't local: no IP literals, no
 *  localhost, .local or .internal. A public name that resolves to a private
 *  address is stopped by the platform: Workers can't reach private networks. */
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
