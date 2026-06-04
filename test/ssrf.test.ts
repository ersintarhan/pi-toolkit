import { test, expect, describe } from "bun:test";
import { isPrivateIpv4, isPrivateIpv6, isPrivateAddress } from "../src/search/ssrf";

describe("isPrivateIpv4", () => {
	test("rejects 0.0.0.0/8 (this-network)", () => {
		expect(isPrivateIpv4("0.0.0.0")).toBe(true);
		expect(isPrivateIpv4("0.0.0.1")).toBe(true);
		expect(isPrivateIpv4("0.255.255.255")).toBe(true);
	});

	test("rejects 10.0.0.0/8 (RFC1918)", () => {
		expect(isPrivateIpv4("10.0.0.1")).toBe(true);
		expect(isPrivateIpv4("10.255.255.255")).toBe(true);
		expect(isPrivateIpv4("10.1.2.3")).toBe(true);
	});

	test("rejects 127.0.0.0/8 (loopback)", () => {
		expect(isPrivateIpv4("127.0.0.1")).toBe(true);
		expect(isPrivateIpv4("127.0.0.53")).toBe(true);
		expect(isPrivateIpv4("127.255.255.255")).toBe(true);
	});

	test("rejects 169.254.0.0/16 (link-local / cloud metadata)", () => {
		expect(isPrivateIpv4("169.254.169.254")).toBe(true);
		expect(isPrivateIpv4("169.254.0.1")).toBe(true);
		expect(isPrivateIpv4("169.254.255.255")).toBe(true);
	});

	test("rejects 172.16.0.0/12 (RFC1918)", () => {
		expect(isPrivateIpv4("172.16.0.1")).toBe(true);
		expect(isPrivateIpv4("172.31.255.255")).toBe(true);
		expect(isPrivateIpv4("172.20.5.5")).toBe(true);
	});

	test("accepts 172.15.x.x and 172.32.x.x (outside /12)", () => {
		expect(isPrivateIpv4("172.15.0.1")).toBe(false);
		expect(isPrivateIpv4("172.32.0.1")).toBe(false);
	});

	test("rejects 192.168.0.0/16 (RFC1918)", () => {
		expect(isPrivateIpv4("192.168.0.1")).toBe(true);
		expect(isPrivateIpv4("192.168.1.1")).toBe(true);
		expect(isPrivateIpv4("192.168.255.255")).toBe(true);
	});

	test("rejects 192.0.0.0/24 (IETF protocol assignments)", () => {
		expect(isPrivateIpv4("192.0.0.0")).toBe(true);
		expect(isPrivateIpv4("192.0.0.1")).toBe(true);
	});

	test("rejects 100.64.0.0/10 (CGNAT)", () => {
		expect(isPrivateIpv4("100.64.0.1")).toBe(true);
		expect(isPrivateIpv4("100.127.255.255")).toBe(true);
		expect(isPrivateIpv4("100.100.100.100")).toBe(true);
	});

	test("accepts 100.63.x.x and 100.128.x.x (outside CGNAT)", () => {
		expect(isPrivateIpv4("100.63.0.1")).toBe(false);
		expect(isPrivateIpv4("100.128.0.1")).toBe(false);
	});

	test("rejects 198.18.0.0/15 (benchmarking)", () => {
		expect(isPrivateIpv4("198.18.0.1")).toBe(true);
		expect(isPrivateIpv4("198.19.255.255")).toBe(true);
	});

	test("rejects multicast and reserved (224+)", () => {
		expect(isPrivateIpv4("224.0.0.1")).toBe(true);
		expect(isPrivateIpv4("239.255.255.255")).toBe(true);
		expect(isPrivateIpv4("240.0.0.1")).toBe(true);
		expect(isPrivateIpv4("255.255.255.255")).toBe(true);
	});

	test("accepts public IPs", () => {
		expect(isPrivateIpv4("1.1.1.1")).toBe(false);
		expect(isPrivateIpv4("8.8.8.8")).toBe(false);
		expect(isPrivateIpv4("93.184.216.34")).toBe(false);
	});

	test("rejects malformed inputs", () => {
		expect(isPrivateIpv4("")).toBe(true);
		expect(isPrivateIpv4("not-an-ip")).toBe(true);
		expect(isPrivateIpv4("1.2.3")).toBe(true);
		expect(isPrivateIpv4("1.2.3.4.5")).toBe(true);
		expect(isPrivateIpv4("999.1.1.1")).toBe(true);
		expect(isPrivateIpv4("-1.0.0.0")).toBe(true);
	});
});

describe("isPrivateIpv6", () => {
	test("rejects ::1 (loopback)", () => {
		expect(isPrivateIpv6("::1")).toBe(true);
	});

	test("rejects fe80::1 (link-local)", () => {
		expect(isPrivateIpv6("fe80::1")).toBe(true);
	});

	test("rejects fc00::1 (ULA)", () => {
		expect(isPrivateIpv6("fc00::1")).toBe(true);
	});

	test("rejects fd00::1 (ULA)", () => {
		expect(isPrivateIpv6("fd00::1")).toBe(true);
	});

	test("rejects ::ffff:127.0.0.1 (IPv4-mapped loopback)", () => {
		expect(isPrivateIpv6("::ffff:127.0.0.1")).toBe(true);
	});

	test("rejects ::ffff:10.0.0.1 (IPv4-mapped private)", () => {
		expect(isPrivateIpv6("::ffff:10.0.0.1")).toBe(true);
	});

	test("rejects ff00::1 (multicast)", () => {
		expect(isPrivateIpv6("ff00::1")).toBe(true);
	});

	test("rejects :: (unspecified)", () => {
		expect(isPrivateIpv6("::")).toBe(true);
	});

	test("accepts global unicast addresses", () => {
		expect(isPrivateIpv6("2606:4700:4700::1111")).toBe(false);
		expect(isPrivateIpv6("2001:db8::1")).toBe(false);
		expect(isPrivateIpv6("2607:f8b0:4004:800::200e")).toBe(false);
	});

	test("strips zone id before checking", () => {
		expect(isPrivateIpv6("fe80::1%eth0")).toBe(true);
	});

	test("rejects malformed input", () => {
		expect(isPrivateIpv6("not-an-ip")).toBe(true);
	});
});

describe("isPrivateAddress", () => {
	test("dispatches IPv4 to isPrivateIpv4", () => {
		expect(isPrivateAddress("127.0.0.1")).toBe(true);
		expect(isPrivateAddress("10.0.0.1")).toBe(true);
		expect(isPrivateAddress("1.1.1.1")).toBe(false);
	});

	test("dispatches IPv6 to isPrivateIpv6", () => {
		expect(isPrivateAddress("::1")).toBe(true);
		expect(isPrivateAddress("fe80::1")).toBe(true);
		expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
	});

	test("rejects unrecognized input as unsafe", () => {
		expect(isPrivateAddress("not-an-ip")).toBe(true);
		expect(isPrivateAddress("")).toBe(true);
	});
});
