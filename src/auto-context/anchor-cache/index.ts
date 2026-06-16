/**
 * anchor-cache — Anthropic prompt-cache breakpoint optimization for pi-auto-context.
 *
 * Problem
 * -------
 * pi-auto-context truncates tool results older than the most recent on-branch
 * anchor. On Anthropic, that mutation poisons the default rolling `last_user`
 * cache marker because the 20-block lookback window misses prior writes and
 * every turn pays full prefix cost.
 *
 * Approach (post-0.2.2 design — battle-tested layout)
 * ---------------------------------------------------
 * Rather than ADD markers (which collides with @mcowger/pi-better-messages-cache
 * and Anthropic's 4-marker hard limit), we **shift** the existing rolling
 * message-level marker onto the last on-branch anchor's tool_result block.
 *
 *   pi default       : [system, tools, last_user]                = 3 markers
 *   + better-cache   : [system, tools, last_user, last_tool_use] = 4 markers
 *   our shift        : [system, tools, LAST_ANCHOR, last_tool_use] (replaces last_user)
 *
 * Net marker count: unchanged. TTL: 5m everywhere — Anthropic requires
 * 1h-markers to come BEFORE 5m-markers in payload order (tools → system →
 * messages), and our anchor lives in `messages`, so it must match upstream
 * TTL. The cache win comes from the marker being on a STABLE block (the
 * anchor) instead of the moving `last_user` target.
 *
 * Idempotency
 * -----------
 * - Tagged ownership via WeakMap<block, owner> — never written to the
 *   payload, so Anthropic's strict schema validator can't reject it.
 * - `purgeLegacyOwnerFields()` strips any stale `_anchorCacheOwner` field
 *   left over from 0.2.0 / 0.2.1 on resumed sessions.
 * - `enforceMarkerLimit(...)` as a final safety net on every request,
 *   protecting our anchor marker and evicting foreign markers oldest-first.
 *
 * Verification
 * ------------
 * Anthropic responses include `usage.cache_read_input_tokens` and
 * `usage.cache_creation_input_tokens`. After 2-3 anchored turns:
 *   - cache_read grows steadily (prefix served from cache)
 *   - cache_creation stays near zero on turns without new anchors
 *
 * Set PI_ANCHOR_CACHE_DEBUG=1 to log chosen layout per request.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isAnthropicPayload,
	findToolResultBlock,
	setMessageMarker,
	dropMessageMarker,
	listMarkers,
	enforceMarkerLimit,
	countMarkersRaw,
	purgeLegacyOwnerFields,
	type AnthropicPayload,
	type CacheControl,
} from "./anthropic-payload.js";
import { isAnchorEntry } from "../context/anchors.js";

/**
 * Anchor TTL is always 5m.
 *
 * Reason: pi's hook chain is ordered by extension load order (alphabetical).
 * pi-claude-oauth-adapter loads AFTER pi-auto-context and may inject new
 * system blocks with cache_control copied from existing markers. Even if we
 * upgrade all prefix markers to 1h, the oauth adapter runs later and can
 * inject a 5m marker on a new system block, producing the invalid sequence
 * tools(1h) → system(1h) → oauth-injected-system(5m) → messages(anchor 1h).
 *
 * With 5m everywhere, any post-hook injection is always valid: 5m after 5m
 * is fine regardless of position.
 *
 * The cache win comes from marker STABILITY (anchor never moves between
 * turns), not from TTL length. 5m auto-refreshes on every cache hit, so
 * as long as turns come within 5 minutes the prefix stays warm indefinitely.
 *
 * Override: PI_ANCHOR_CACHE_TTL=1h (preferred) or PI_CACHE_TTL=1h.
 * Both cache layers intentionally read the same envs in the same priority
 * order to avoid mixed 5m/1h message markers, which Anthropic rejects.
 */
function resolveAnchorTTL(): "5m" | "1h" {
	const env = process.env.PI_ANCHOR_CACHE_TTL ?? process.env.PI_CACHE_TTL;
	if (env === "1h") return "1h";
	return "5m";
}

function resolveAnchorMarkerBudget(): number {
	const raw = process.env.PI_ANCHOR_CACHE_MARKER_BUDGET;
	// Default 4: matches the documented layout [system, tools, LAST_ANCHOR,
	// last_tool_use]. Anthropic hard-fails at 5 markers, so 4 leaves the
	// collaborator's rolling marker intact rather than evicting it.
	if (!raw) return 4;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return 4;
	return Math.max(1, Math.min(4, parsed));
}

/**
 * Debug logger for anchor-cache layout diagnostics.
 *
 * Writes to ~/.pi/agent/logs/anchor-cache-debug.log ONLY when
 * PI_ANCHOR_CACHE_DEBUG is set. Never uses console.* — pi surfaces console
 * output to the transcript/editor area, which clutters the UI and conflicts
 * with powerline-footer's input-area notification rendering. To inspect,
 * set PI_ANCHOR_CACHE_DEBUG=1 and `tail -f` the log file.
 *
 * Accepts either a string or a lazy thunk so the expensive layout summary
 * (listMarkers/countMarkersRaw) is only computed when debug is actually on.
 */
function debugLog(lineOrThunk: string | (() => string)): void {
	if (!process.env.PI_ANCHOR_CACHE_DEBUG) return;
	try {
		const piDir = process.env.PI_HOME ?? join(homedir(), ".pi", "agent");
		const logsDir = join(piDir, "logs");
		mkdirSync(logsDir, { recursive: true });
		const line = typeof lineOrThunk === "function" ? lineOrThunk() : lineOrThunk;
		appendFileSync(join(logsDir, "anchor-cache-debug.log"), `${new Date().toISOString()} ${line}\n`);
	} catch {
		// Debug logging is best-effort; never surface to UI.
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", async (event, ctx) => {
		const payload = event.payload as unknown;
		if (!isAnthropicPayload(payload)) return; // not Anthropic — no-op

		// Strip any stale _anchorCacheOwner fields stamped by 0.2.0 on resumed
		// sessions. Anthropic's API rejects unknown fields server-side.
		purgeLegacyOwnerFields(payload);
		const markerBudget = resolveAnchorMarkerBudget();

		// Find on-branch anchor toolResult entries; we want the last (newest) one.
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		let lastAnchorToolCallId: string | null = null;
		for (const entry of branch) {
			if (!isAnchorEntry(entry)) continue;
			const tcid = (entry as any)?.message?.toolCallId;
			if (typeof tcid === "string" && tcid.length > 0) lastAnchorToolCallId = tcid;
		}
		if (!lastAnchorToolCallId) {
			const droppedByLimit = enforceMarkerLimit(payload, markerBudget);
			debugLog(
				`[anchor-cache] no on-branch anchors — enforced budget=${markerBudget} dropped-by-limit=${droppedByLimit} raw=${countMarkersRaw(payload)}`,
			);
			return event.payload;
		}

		const anchorLoc = findToolResultBlock(payload, lastAnchorToolCallId);
		if (!anchorLoc) {
			const droppedByLimit = enforceMarkerLimit(payload, markerBudget);
			debugLog(
				`[anchor-cache] anchor ${lastAnchorToolCallId} not in payload — enforced budget=${markerBudget} dropped-by-limit=${droppedByLimit} raw=${countMarkersRaw(payload)}`,
			);
			return event.payload;
		}

		const anchorTTL = resolveAnchorTTL();
		const anchorControl: CacheControl = { type: "ephemeral", ttl: anchorTTL };

		// Strategy: shift the rolling message-level marker onto the anchor block.
		// Drop existing message-level markers BEFORE the anchor (they'd violate
		// TTL ordering: 5m before 1h is invalid). Leave message markers AFTER the
		// anchor alone — 5m after 1h is valid, and those are rolling markers we
		// don't want to interfere with.
		const beforeMarkers = listMarkers(payload);
		let droppedPreAnchor = 0;
		for (const m of beforeMarkers) {
			if (m.section !== "messages") continue;
			if (m.idx > anchorLoc.msgIdx) continue; // post-anchor markers can stay (5m after our TTL is fine)
			if (m.idx === anchorLoc.msgIdx && m.blockIdx! >= anchorLoc.blockIdx) continue;
			dropMessageMarker(payload, m.idx, m.blockIdx!);
			droppedPreAnchor++;
		}

		// When using 1h (opt-in only), upgrade tools+system markers to match.
		// Safe default is 5m — no upgrade needed, any post-hook injection is valid.
		if (anchorTTL === "1h") {
			upgradePrefixMarkersTo1h(payload);
		}

		// Install our anchor marker (owned by us).
		setMessageMarker(payload, anchorLoc.msgIdx, anchorLoc.blockIdx, anchorControl, "last_anchor");

		// Safety net: always enforce a marker budget after shifting. Default is 3
		// (not 4) so we preserve one slot for any downstream/request-finalizer
		// mutation outside this hook chain. Override via
		// PI_ANCHOR_CACHE_MARKER_BUDGET=4 once the runtime is proven stable.
		const droppedByLimit = enforceMarkerLimit(payload, markerBudget);

		debugLog(() => {
			const finalMarkers = listMarkers(payload).map(m =>
				`${m.section}#${m.idx}${m.blockIdx !== undefined ? `[${m.blockIdx}]` : ""}` +
				`${m.owner ? `=${m.owner}` : ""}` +
				`${m.control.ttl ? `(${m.control.ttl})` : "(5m)"}`
			);
			const rawCount = countMarkersRaw(payload);
			const mismatch = rawCount !== finalMarkers.length ? ` ⚠️ MISMATCH raw=${rawCount} listed=${finalMarkers.length}` : "";
			return `[anchor-cache] ttl=${anchorTTL} anchor=msg${anchorLoc.msgIdx}[${anchorLoc.blockIdx}] ` +
				`dropped-pre=${droppedPreAnchor} dropped-by-limit=${droppedByLimit} raw=${rawCount}${mismatch} ` +
				`final=[${finalMarkers.join(", ")}]`;
		});

		return event.payload;
	});
}

/**
 * Upgrade all tools+system cache_control markers to 1h. Required when we
 * install a 1h anchor marker in `messages`, because Anthropic rejects payloads
 * where a later block has longer TTL than an earlier one.
 *
 * Cost analysis: 1h writes are 2x base vs 1.25x for 5m. But tools/system are
 * STABLE across turns — they're written once per cache-key change and then
 * read 0.1x for every subsequent turn. 2x write amortizes after ~2 reads. In
 * a typical session we expect 10s-100s of reads per write, so net cost
 * decreases significantly while idle-tolerance jumps from 5min to 1h.
 */
function upgradePrefixMarkersTo1h(payload: AnthropicPayload): void {
	if (payload.tools) {
		for (const t of payload.tools) {
			if (t.cache_control) t.cache_control = { type: "ephemeral", ttl: "1h" };
		}
	}
	if (payload.system) {
		for (const s of payload.system) {
			if (s.cache_control) s.cache_control = { type: "ephemeral", ttl: "1h" };
		}
	}
}
