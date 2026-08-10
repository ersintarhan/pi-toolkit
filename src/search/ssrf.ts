/**
 * SSRF guard for the LLM-driven web_fetch tool.
 *
 * web_fetch lets the model fetch arbitrary URLs, so without a guard it can be
 * steered at internal endpoints (cloud metadata 169.254.169.254, localhost,
 * RFC1918 ranges, etc.). We:
 *   1. allow only http/https,
 *   2. resolve the host (literal IPs are checked directly) and reject any
 *      address in a loopback / private / link-local / reserved range,
 *   3. re-validate on every redirect hop (see native-search httpFetch).
 *
 * Residual: a DNS-rebinding race between this check and fetch's own resolution
 * is not closed (that needs a connection-pinning dispatcher, which breaks TLS
 * SNI). This blocks the realistic vectors — literal internal IPs, internal
 * hostnames, and redirects to either. Set PI_SEARCH_ALLOW_PRIVATE_HOSTS=1 to
 * opt out (e.g. to fetch a local dev server).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** True for IPv4 addresses that must never be fetched server-side. */
export function isPrivateIpv4(ip: string): boolean {
	const parts = ip.split(".").map((p) => Number(p));
	if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
		return true; // not a clean dotted-quad => treat as unsafe
	}
	const [a, b] = parts;
	if (a === 0) return true; // 0.0.0.0/8 "this network"
	if (a === 10) return true; // 10.0.0.0/8 private
	if (a === 127) return true; // 127.0.0.0/8 loopback
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. metadata)
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
	if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
	if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
	if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
	if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
	return false;
}

/** True for IPv6 addresses that must never be fetched server-side. */
export function isPrivateIpv6(ip: string): boolean {
	let addr = ip.toLowerCase();
	const zone = addr.indexOf("%");
	if (zone !== -1) addr = addr.slice(0, zone); // drop scope id (fe80::1%eth0)

	// IPv4-embedded forms (::ffff:1.2.3.4, ::1.2.3.4, 64:ff9b::1.2.3.4): judge by the v4.
	const embedded = addr.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
	if (embedded && isIP(embedded[1]) === 4) return isPrivateIpv4(embedded[1]);

	const first = addr.split(":")[0];
	const hextet = first === "" ? 0 : Number.parseInt(first, 16);
	if (Number.isNaN(hextet)) return true;
	// Global unicast is 2000::/3. Default-deny everything outside it (loopback,
	// unspecified, ULA fc00::/7, link-local fe80::/10, multicast ff00::/8, …).
	return !(hextet >= 0x2000 && hextet <= 0x3fff);
}

/** Dispatch by address family; unrecognized input is treated as unsafe. */
export function isPrivateAddress(ip: string): boolean {
	const kind = isIP(ip);
	if (kind === 4) return isPrivateIpv4(ip);
	if (kind === 6) return isPrivateIpv6(ip);
	return true;
}

/**
 * Validate a URL for outbound fetching. Returns the parsed URL on success and
 * throws a descriptive Error otherwise. Honors PI_SEARCH_ALLOW_PRIVATE_HOSTS=1.
 */
export async function assertPublicUrl(
	url: string,
	allowPrivateHosts = process.env.PI_SEARCH_ALLOW_PRIVATE_HOSTS === "1",
): Promise<URL> {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Only http/https URLs are allowed");
	}
	if (allowPrivateHosts) return parsed;

	let host = parsed.hostname;
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1); // [::1] -> ::1
	if (!host) throw new Error("URL has no host");

	if (isIP(host)) {
		if (isPrivateAddress(host)) {
			throw new Error(`Refusing to fetch a private/loopback address: ${host}`);
		}
		return parsed;
	}

	const resolved = await lookup(host, { all: true });
	if (resolved.length === 0) throw new Error(`Cannot resolve host: ${host}`);
	for (const { address } of resolved) {
		if (isPrivateAddress(address)) {
			throw new Error(`Host ${host} resolves to a private/loopback address (${address})`);
		}
	}
	return parsed;
}
