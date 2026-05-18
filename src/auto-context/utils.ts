import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

function getSessionsDir(): string {
	return path.join(getAgentDir(), "sessions");
}

/**
 * Walk the sessions directory and return all .jsonl files sorted newest-first by mtime.
 */
function listSessionFiles(): Array<{ file: string; mtime: number }> {
	const sessionsDir = getSessionsDir();
	if (!fs.existsSync(sessionsDir)) return [];

	const all: Array<{ file: string; mtime: number }> = [];
	for (const subdir of fs.readdirSync(sessionsDir)) {
		const subdirPath = path.join(sessionsDir, subdir);
		let stat: fs.Stats;
		try { stat = fs.statSync(subdirPath); } catch { continue; }
		if (!stat.isDirectory()) continue;
		for (const file of fs.readdirSync(subdirPath)) {
			if (!file.endsWith(".jsonl")) continue;
			const fullPath = path.join(subdirPath, file);
			try {
				const fstat = fs.statSync(fullPath);
				all.push({ file: fullPath, mtime: fstat.mtimeMs });
			} catch { /* skip */ }
		}
	}
	all.sort((a, b) => b.mtime - a.mtime);
	return all;
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

export async function scanAnchors(
	keyword: string,
	scope: "cwd" | "all",
	cwd: string,
	limit = 10,
	offset = 0,
	signal?: AbortSignal,
): Promise<AnchorScanResult[]> {
	if (limit <= 0) return [];

	const lowerKw = keyword.toLowerCase();
	const results: AnchorScanResult[] = [];
	const timeValue = (ts: string) => {
		const value = Date.parse(ts);
		return Number.isFinite(value) ? value : 0;
	};

	for (const { file, mtime } of listSessionFiles()) {
		if (signal?.aborted) break;

		const cached = loadSessionAnchors(file, mtime);
		if (scope === "cwd" && cached.cwd !== cwd) continue;
		if (cached.anchors.length === 0) continue;

		for (const a of cached.anchors) {
			if (signal?.aborted) break;
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

	results.sort((a, b) => timeValue(b.timestamp) - timeValue(a.timestamp));
	return results.slice(offset, offset + limit);
}

// ── Anchor cache ────────────────────────────────────
// Caches parsed anchor entries per session file. Keyed by (file, mtime);
// mtime invalidates naturally when pi's session-manager appends new entries.
// Memory bound: typical session has O(10) anchors × O(hundreds) of sessions.

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

function loadSessionAnchors(file: string, mtime: number): CachedSessionAnchors {
	const cached = _anchorCache.get(file);
	if (cached && cached.mtime === mtime) return cached;

	let raw: string;
	try { raw = fs.readFileSync(file, "utf-8"); }
	catch {
		const empty: CachedSessionAnchors = { mtime, anchors: [] };
		_anchorCache.set(file, empty);
		return empty;
	}

	let header: any = null;
	const anchors: CachedAnchorEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
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
			const a = entry.message.details.anchor;
			if (!a?.name || !a?.summary) continue;
			anchors.push({
				anchorId: entry.id,
				anchorName: a.name,
				summary: a.summary,
				timestamp: entry.timestamp ?? "",
			});
		}
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
