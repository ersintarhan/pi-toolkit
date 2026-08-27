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
 * Net marker count: unchanged. The anchor adopts Pi's canonical retention
 * setting or the payload's existing marker TTL, and all markers are normalized
 * to avoid invalid mixed-TTL payloads. Payloads without a marker are untouched.
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
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isAnthropicPayload,
	findToolResultBlock,
	setMessageMarker,
	dropMessageMarker,
	listMarkers,
	enforceMarkerLimit,
	countMarkersRaw,
	purgeLegacyOwnerFields,
	resolveAnchorCacheTTL,
	clampPostAnchorMarkerTTLs,
	normalizeCacheMarkerTTLs,
	type CacheControl,
} from "./anthropic-payload.js";
import { isAnchorEntry } from "../context/anchors.js";

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
		const logsDir = join(getAgentDir(), "logs");
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
		const anchorTTL = resolveAnchorCacheTTL(payload);
		if (!anchorTTL) return event.payload;
		normalizeCacheMarkerTTLs(payload, anchorTTL);
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

		const anchorControl: CacheControl = { type: "ephemeral", ttl: anchorTTL };

		// Strategy: shift the rolling message-level marker onto the anchor block.
		// Drop historical message markers before the anchor; leave later rolling
		// markers in place (clamped to 5m below — they rewrite every turn).
		const beforeMarkers = listMarkers(payload);
		let droppedPreAnchor = 0;
		for (const m of beforeMarkers) {
			if (m.section !== "messages") continue;
			if (m.idx > anchorLoc.msgIdx) continue; // post-anchor rolling markers stay
			if (m.idx === anchorLoc.msgIdx && m.blockIdx! >= anchorLoc.blockIdx) continue;
			dropMessageMarker(payload, m.idx, m.blockIdx!);
			droppedPreAnchor++;
		}

		// Install our anchor marker (owned by us).
		setMessageMarker(payload, anchorLoc.msgIdx, anchorLoc.blockIdx, anchorControl, "last_anchor");

		// Rolling post-anchor markers restart every turn; keep them on 5m so the
		// 1h write premium is paid once per anchor, not every turn.
		if (anchorTTL === "1h") clampPostAnchorMarkerTTLs(payload, anchorLoc.msgIdx);

		// Safety net: the default budget is Anthropic's four-marker limit.
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
