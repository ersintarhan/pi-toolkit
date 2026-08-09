import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

function getSessionsDir(): string {
	return path.join(getAgentDir(), "sessions");
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

/** Return session files sorted newest-first by mtime. */
function listSessionFiles(scope: "cwd" | "all", sessionDir?: string): SessionFile[] {
	if (scope === "cwd" && sessionDir) {
		return listJsonlFiles(sessionDir).sort((a, b) => b.mtime - a.mtime);
	}

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

export async function scanAnchors(
	keyword: string,
	scope: "cwd" | "all",
	cwd: string,
	limit = 10,
	offset = 0,
	signal?: AbortSignal,
	sessionDir?: string,
): Promise<AnchorScanResult[]> {
	if (signal?.aborted) throw abortError();
	if (limit <= 0) return [];

	const lowerKw = keyword.toLowerCase();
	const results: AnchorScanResult[] = [];
	const timeValue = (ts: string) => {
		const value = Date.parse(ts);
		return Number.isFinite(value) ? value : 0;
	};
	const files = listSessionFiles(scope, sessionDir);

	for (const { file, mtime } of files) {
		if (signal?.aborted) throw abortError();

		const cached = await loadSessionAnchors(file, mtime, signal);
		if (scope === "cwd" && cached.cwd !== cwd) continue;
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

	if (scope === "all") {
		const existing = new Set(files.map(({ file }) => file));
		for (const file of _anchorCache.keys()) {
			if (!existing.has(file)) _anchorCache.delete(file);
		}
	}

	results.sort((a, b) => timeValue(b.timestamp) - timeValue(a.timestamp));
	return results.slice(offset, offset + limit);
}

// ── Anchor cache ────────────────────────────────────
// Caches small parsed anchor metadata per session file. mtime invalidates
// appended sessions; a completed all-scope scan prunes files removed on disk.
// ponytail: Deliberately no numeric LRU cap—the old cap caused full sequential
// scans to thrash. Add per-cwd pruning only if one process starts visiting many
// changing session roots; normal Pi sessions keep a stable cwd.

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
			if (
				entry.type === "message" &&
				entry.message?.role === "toolResult" &&
				entry.message?.toolName === "context" &&
				entry.message?.details?.anchor
			) {
				const anchor = entry.message.details.anchor;
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
