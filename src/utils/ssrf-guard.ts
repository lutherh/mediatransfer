/**
 * SSRF (Server-Side Request Forgery) defence-in-depth guard.
 *
 * Use {@link assertPublicHttpUrl} to validate any URL that is taken from a
 * user-supplied source before performing an outbound `fetch`. The guard:
 *
 *   1. Rejects non-`http(s)` schemes (e.g. `file:`, `gopher:`).
 *   2. Rejects literal hostnames that always denote internal targets:
 *      `localhost`, `metadata.google.internal`, anything ending `.internal`.
 *   3. DNS-resolves the hostname (`dns.lookup` with `all: true`) and rejects
 *      if any returned address is loopback, link-local, RFC1918, CGNAT
 *      (100.64/10), unique-local IPv6 (fc00::/7), IPv6 loopback `::1`, or an
 *      IPv4-mapped IPv6 form of any of the above.
 *
 * **Opt-out for local development:** Set the `SSRF_ALLOWED_HOSTS` env var to a
 * comma-separated list of hostnames you want to allow even though they would
 * normally fail private-address checks (e.g. `immich.local,my.lan.box`). This
 * is intended for the developer's own machine and MUST NOT be used in a
 * shared/production deployment — it disables the SSRF guard for those hosts.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Parse `SSRF_ALLOWED_HOSTS` into a lower-cased Set. */
function getAllowlist(): Set<string> {
  const raw = process.env.SSRF_ALLOWED_HOSTS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/** Test whether an IPv4 dotted-quad falls inside any blocked range. */
function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    // Unparseable — fail closed.
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  // 0.0.0.0/8 (this network)
  if (a === 0) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 link-local (covers AWS/GCP IMDS 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Test whether an IPv6 address is loopback/link-local/unique-local or IPv4-mapped private. */
function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  // IPv6 loopback
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  // Unspecified
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
  // IPv4-mapped (::ffff:a.b.c.d) — re-check against IPv4 rules
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
  // Unique-local fc00::/7  → first byte 0xfc or 0xfd
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  return false;
}

/** True if the given address (IPv4 or IPv6 literal) belongs to a non-public range. */
function isPrivateAddress(addr: string, family: number): boolean {
  if (family === 4) return isPrivateIPv4(addr);
  if (family === 6) return isPrivateIPv6(addr);
  // Unknown family — fail closed.
  return true;
}

/**
 * Validate that `rawUrl` is a public http(s) URL safe to fetch from the
 * server. Returns the parsed `URL` on success; throws `Error` on rejection.
 *
 * Errors thrown here are intended to be surfaced to the API client as a
 * `400` with `{ ok: false, error: <message> }` — they do not leak stack
 * frames or internal state.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http(s) URLs allowed');
  }

  const host = url.hostname.toLowerCase();
  if (host.length === 0) {
    throw new Error('invalid URL');
  }

  const allowlist = getAllowlist();
  if (allowlist.has(host)) {
    return url;
  }

  // Hard-deny named hosts that always identify internal targets.
  if (host === 'localhost' || host === 'metadata.google.internal' || host.endsWith('.internal')) {
    throw new Error(`host not allowed: ${host}`);
  }

  // If the URL hostname is itself an IP literal, dns.lookup returns it as-is;
  // we still rely on isPrivateAddress for the rejection so the logic stays
  // unified. Use isIP() to determine family without a network round-trip.
  let addrs: { address: string; family: number }[];
  if (isIP(host) !== 0) {
    addrs = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addrs = await lookup(host, { all: true });
    } catch {
      throw new Error(`DNS resolution failed for ${host}`);
    }
  }

  if (addrs.length === 0) {
    throw new Error(`DNS resolution failed for ${host}`);
  }

  for (const { address, family } of addrs) {
    if (isPrivateAddress(address, family)) {
      // Generic message to the caller (avoid using this endpoint as a DNS
      // resolution oracle); detailed reason is preserved in `cause` for the
      // server-side log only.
      throw new Error('host not allowed', {
        cause: `host resolves to non-public address: ${host} -> ${address}`,
      });
    }
  }

  return url;
}
