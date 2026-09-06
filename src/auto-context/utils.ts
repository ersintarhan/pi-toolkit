import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { anchorPayloadOf, isAnchorToolResult } from "./context/anchors.js";

function getSessionsDir(): string {
	return path.join(getAgentDir(), "sessions");
}

// Home prefixes that may introduce the same project. The local home covers the
// normal case; the /Users and /home spellings cover a session that was recorded
// on another OS and synced here. Restricted to the current username so two
// accounts on one machine never collapse into each other.
let cachedHomePrefixes: string[] | undefined;
function homePrefixes(): string[] {
	if (cachedHomePrefixes) return cachedHomePrefixes;
	const home = os.homedir();
	const user = path.basename(home);
	cachedHomePrefixes = [...new Set([home, `/Users/${user}`, `/home/${user}`])];
	return cachedHomePrefixes;
}

/**
 * Rewrite a leading home directory to "~" so one project matches itself across
 * machines.
 *
 * A synced session keeps the cwd it was recorded with, and typically only the
 * home prefix differs: `/Users/me/proj` on macOS against `/home/me/proj` on
 * Linux. Comparing the home-relative form lets a `cwd`-scoped recall see both.
 * Paths outside home are returned unchanged, since they cannot be reconciled.
 *
 * An unknown cwd stays undefined so it still fails a scope check, as before.
 */
function homeRelative(dir: string | undefined): string | undefined {
	if (dir === undefined) return undefined;
	for (const home of homePrefixes()) {
		if (dir === home) return "~";
		if (dir.startsWith(home + path.sep) || dir.startsWith(home + "/")) {
			return "~" + dir.slice(home.length);
		}
	}
	return dir;
}

interface SessionFile {
	file: string;
	mtime: number;
}

function listJsonlFiles(dir: string): SessionFile[] {
	let files: string[];
	try { files = fs.readdirSync(dir); } catch { return []; }

	const sessions: SessionFile[] = [];
	for (const file of files) {
		if (!file.endsWith(".jsonl")) continue;
		const fullPath = path.join(dir, file);
		try {
			const stat = fs.statSync(fullPath);
			if (stat.isFile()) sessions.push({ file: fullPath, mtime: stat.mtimeMs });
		} catch { /* skip */ }
	}
	return sessions;
}

/**
 * Return every session file, sorted newest-first by mtime.
 *
 * Deliberately not narrowed to the active session directory. Pi derives that
 * directory name by encoding the cwd, and the encoding has changed between
 * releases, so one cwd can own several directories on disk. Scanning them all
 * and matching on the recorded header cwd is the only way a `cwd`-scoped recall
 * sees sessions written by an older Pi. `peekSessionCwd` keeps that cheap.
 */
function listSessionFiles(): SessionFile[] {
	const sessionsDir = getSessionsDir();
	let subdirs: string[];
	try { subdirs = fs.readdirSync(sessionsDir); } catch { return []; }

	const all: SessionFile[] = [];
	for (const subdir of subdirs) {
		const subdirPath = path.join(sessionsDir, subdir);
		try {
			if (!fs.statSync(subdirPath).isDirectory()) continue;
		} catch { continue; }
		all.push(...listJsonlFiles(subdirPath));
	}
	return all.sort((a, b) => b.mtime - a.mtime);
}

export interface AnchorScanResult {
	sessionFile: string;
	sessionId: string;
	sessionCwd?: string;
	anchorName: string;
	anchorId: string;
	summary: string;
	timestamp: string;
}

function abortError(): Error {
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

// A session header is the first line of the file, so a bounded read is enough to
// learn its cwd. Pi itself reads headers with a 4KB buffer; an entry that still
// does not fit degrades to "unknown", never to a wrong answer.
const HEADER_READ_BYTES = 4096;

/**
 * Session cwd without parsing the whole file: cached metadata when fresh, else a
 * bounded read of the header line.
 *
 * Returns undefined when the cwd cannot be established (unreadable file, header
 * larger than the bounded read, malformed JSON). Callers must treat undefined as
 * "unknown" and fall through to the authoritative full parse.
 */
function peekSessionCwd(file: string, mtime: number): string | undefined {
	const cached = _anchorCache.get(file);
	if (cached && cached.mtime === mtime) return cached.cwd;

	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(HEADER_READ_BYTES);
		const read = fs.readSync(fd, buf, 0, HEADER_READ_BYTES, 0);
		const chunk = buf.subarray(0, read).toString("utf-8");
		const newline = chunk.indexOf("\n");
		// Without a newline the header line was cut off mid-JSON, so we cannot tell
		// whether it matches. Report unknown instead of guessing.
		if (newline < 0) return undefined;
		const header = JSON.parse(chunk.slice(0, newline));
		return typeof header?.cwd === "string" ? header.cwd : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* best effort */ }
		}
	}
}

export async function scanAnchors(
	keyword: string,
	scope: "cwd" | "all",
	cwd: string,
	limit = 10,
	offset = 0,
	signal?: AbortSignal,
): Promise<AnchorScanResult[]> {
	if (signal?.aborted) throw abortError();
	if (limit <= 0) return [];

	const lowerKw = keyword.toLowerCase();
	const results: AnchorScanResult[] = [];
	const timeValue = (ts: string) => {
		const value = Date.parse(ts);
		return Number.isFinite(value) ? value : 0;
	};
	const files = listSessionFiles();

	// Sessions synced from another machine record that machine's home prefix, so
	// scope matching compares home-relative paths rather than literal ones.
	const wantCwd = homeRelative(cwd);

	for (const { file, mtime } of files) {
		if (signal?.aborted) throw abortError();

		// Reject non-matching sessions from the header alone, so a cwd-scoped recall
		// never streams (or caches) unrelated projects' sessions. The check below
		// stays authoritative for headers this cannot read.
		if (scope === "cwd") {
			const peeked = peekSessionCwd(file, mtime);
			if (peeked !== undefined && homeRelative(peeked) !== wantCwd) continue;
		}

		const cached = await loadSessionAnchors(file, mtime, signal);
		if (scope === "cwd" && homeRelative(cached.cwd) !== wantCwd) continue;
		if (cached.anchors.length === 0) continue;

		for (const a of cached.anchors) {
			if (signal?.aborted) throw abortError();
			const haystack = `${a.anchorName}\n${a.summary}`.toLowerCase();
			if (!haystack.includes(lowerKw)) continue;
			results.push({
				sessionFile: file,
				sessionId: cached.sessionId ?? "",
				sessionCwd: cached.cwd,
				anchorName: a.anchorName,
				anchorId: a.anchorId,
				summary: a.summary,
				timestamp: a.timestamp,
			});
		}
	}

	const existing = new Set(files.map(({ file }) => file));
	for (const file of _anchorCache.keys()) {
		if (!existing.has(file)) _anchorCache.delete(file);
	}

	results.sort((a, b) => timeValue(b.timestamp) - timeValue(a.timestamp));
	return results.slice(offset, offset + limit);
}

// ── Anchor cache ────────────────────────────────────
// Caches small parsed anchor metadata per session file. mtime invalidates
// appended sessions; every completed scan prunes files removed on disk.
// ponytail: Deliberately no numeric LRU cap—the old cap caused full sequential
// scans to thrash. Only cwd-matching sessions are ever parsed and stored, so the
// map tracks the projects actually recalled, not every session on disk.

interface CachedAnchorEntry {
	anchorId: string;
	anchorName: string;
	summary: string;
	timestamp: string;
}

interface CachedSessionAnchors {
	mtime: number;
	sessionId?: string;
	cwd?: string;
	anchors: CachedAnchorEntry[];
}

const _anchorCache = new Map<string, CachedSessionAnchors>();

async function loadSessionAnchors(file: string, mtime: number, signal?: AbortSignal): Promise<CachedSessionAnchors> {
	const cached = _anchorCache.get(file);
	if (cached && cached.mtime === mtime) return cached;
	if (signal?.aborted) throw abortError();

	const input = fs.createReadStream(file, { encoding: "utf8" });
	const lines = readline.createInterface({ input, crlfDelay: Infinity });
	const onAbort = () => {
		lines.close();
		input.destroy();
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	let header: any = null;
	const anchors: CachedAnchorEntry[] = [];
	try {
		for await (const line of lines) {
			if (signal?.aborted) throw abortError();
			const isSession = line.includes('"type":"session"');
			const isAnchor = line.includes('"toolName":"context"') && line.includes('"anchor"');
			if (!isSession && !isAnchor) continue;

			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }
			if (entry.type === "session") {
				header = entry;
				continue;
			}
			if (entry.type === "message" && isAnchorToolResult(entry.message)) {
				const anchor = anchorPayloadOf(entry.message);
				if (!anchor?.name || !anchor?.summary) continue;
				anchors.push({
					anchorId: entry.id,
					anchorName: anchor.name,
					summary: anchor.summary,
					timestamp: entry.timestamp ?? "",
				});
			}
		}
		if (signal?.aborted) throw abortError();
	} catch (error) {
		if (signal?.aborted || (error as Error)?.name === "AbortError") throw abortError();
		const empty: CachedSessionAnchors = { mtime, anchors: [] };
		_anchorCache.set(file, empty);
		return empty;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		lines.close();
		input.destroy();
	}

	const result: CachedSessionAnchors = {
		mtime,
		sessionId: header?.id,
		cwd: header?.cwd,
		anchors,
	};
	_anchorCache.set(file, result);
	return result;
}
