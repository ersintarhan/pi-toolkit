/**
 * Anthropic Messages API payload introspection + cache_control patching.
 *
 * Payload shape (what pi-ai's anthropic provider builds, see
 * @earendil-works/pi-ai/dist/providers/anthropic.js):
 *
 *   {
 *     model: string,
 *     system?: Array<{ type: "text", text: string, cache_control?: {...} }>,
 *     tools?: Array<{ name, description, input_schema, cache_control?: {...} }>,
 *     messages: Array<{
 *       role: "user" | "assistant",
 *       content: string | Array<TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock>
 *     }>,
 *     ...
 *   }
 *
 * Cache_control marker budget is 4 per request (Anthropic hard limit; 5+ → 400).
 * Lookback window is 20 blocks per breakpoint, counted across tools+system+messages.
 *
 * We treat the payload as a tagged union by structural duck-typing; we never
 * import @earendil-works/pi-ai types because that pulls in a hard peer dep
 * for an extension that should no-op on non-anthropic providers.
 */

export interface CacheControl {
	type: "ephemeral";
	ttl?: "5m" | "1h";
}

export interface AnthropicPayload {
	model?: string;
	system?: Array<{ type: string; text?: string; cache_control?: CacheControl }>;
	tools?: Array<{ name?: string; cache_control?: CacheControl }>;
	messages?: Array<{
		role: "user" | "assistant";
		content: string | Array<any>;
	}>;
}

/**
 * Defensive purge of any leftover `_anchorCacheOwner` fields that 0.2.0 may
 * have stamped onto blocks. Anthropic's API strictly rejects unknown fields
 * ("Extra inputs are not permitted"). Idempotent.
 *
 * 0.2.0 wrote the owner tag directly onto the block, which works locally but
 * Anthropic validates the payload server-side. 0.2.1 moved to a WeakMap, but
 * resumed sessions or replayed payloads may still carry the stale field.
 */
export function purgeLegacyOwnerFields(payload: AnthropicPayload): void {
	const strip = (b: any) => { if (b && typeof b === "object" && "_anchorCacheOwner" in b) delete b._anchorCacheOwner; };
	payload.system?.forEach(strip);
	payload.tools?.forEach(strip);
	payload.messages?.forEach(m => Array.isArray(m.content) && m.content.forEach(strip));
}

/**
 * Structural check: is this an Anthropic Messages API payload?
 *
 * We require `messages` array AND either `system` or `tools` to be present —
 * OpenAI's chat/completions payload also has `messages` but differs in the
 * `tools` shape (function wrapper) and lacks the top-level `system` field.
 */
export function isAnthropicPayload(payload: unknown): payload is AnthropicPayload {
	if (!payload || typeof payload !== "object") return false;
	const p = payload as any;
	if (!Array.isArray(p.messages)) return false;
	// system: array of {type:"text", text} — OpenAI uses a message with role="system" inside `messages`
	if (Array.isArray(p.system) && p.system.length > 0) {
		const first = p.system[0];
		if (first && typeof first === "object" && first.type === "text") return true;
	}
	// tools: Anthropic tools have `input_schema` at top level, OpenAI wraps in `function`
	if (Array.isArray(p.tools) && p.tools.length > 0) {
		const first = p.tools[0];
		if (first && typeof first === "object" && "input_schema" in first) return true;
	}
	return false;
}

/** Count blocks in `system` + `tools`; used for lookback-budget decisions. */
export function countPrefixBlocks(payload: AnthropicPayload): { system: number; tools: number } {
	return {
		system: payload.system?.length ?? 0,
		tools: payload.tools?.length ?? 0,
	};
}

/** Return all cache_control markers in the payload, in render order (system → tools → messages). */
export interface MarkerRef {
	section: "system" | "tools" | "messages";
	/** Index within its containing array. For messages, this is the message index. */
	idx: number;
	/** For messages: index of the block inside content[] that carries the marker. */
	blockIdx?: number;
	control: CacheControl;
	/** Free-form tag we set when we own the marker so we can preserve it. */
	owner?: string;
}

/**
 * Ownership tracking lives in a WeakMap, NOT on the block itself.
 *
 * Anthropic's API strictly validates the payload schema and rejects any extra
 * field on tool_result / text / tool_use blocks (e.g. `_anchorCacheOwner: Extra
 * inputs are not permitted`). Tagging via WeakMap keeps the block shape pure
 * and is naturally scoped to the current request — the next call gets a fresh
 * payload from pi-ai so we never accumulate stale tags.
 */
const MARKER_OWNERS = new WeakMap<object, string>();

function getOwner(block: unknown): string | undefined {
	return typeof block === "object" && block !== null ? MARKER_OWNERS.get(block) : undefined;
}

function setOwner(block: unknown, owner: string): void {
	if (typeof block === "object" && block !== null) MARKER_OWNERS.set(block, owner);
}

function clearOwner(block: unknown): void {
	if (typeof block === "object" && block !== null) MARKER_OWNERS.delete(block);
}

export function listMarkers(payload: AnthropicPayload): MarkerRef[] {
	const out: MarkerRef[] = [];
	if (payload.system) {
		for (let i = 0; i < payload.system.length; i++) {
			const b = payload.system[i];
			if (b?.cache_control) out.push({ section: "system", idx: i, control: b.cache_control, owner: getOwner(b) });
		}
	}
	if (payload.tools) {
		for (let i = 0; i < payload.tools.length; i++) {
			const t = payload.tools[i];
			if (t?.cache_control) out.push({ section: "tools", idx: i, control: t.cache_control, owner: getOwner(t) });
		}
	}
	if (payload.messages) {
		for (let i = 0; i < payload.messages.length; i++) {
			const m = payload.messages[i];
			if (!Array.isArray(m.content)) continue;
			for (let j = 0; j < m.content.length; j++) {
				const block = m.content[j];
				if (block?.cache_control) out.push({ section: "messages", idx: i, blockIdx: j, control: block.cache_control, owner: getOwner(block) });
			}
		}
	}
	return out;
}

/**
 * Find the message + block within `payload.messages` that contains a tool_result
 * with the given tool_use_id. Returns null if not found.
 *
 * The Anthropic provider packs consecutive toolResult AgentMessages into a single
 * user message with content=[tool_result, tool_result, ...], so we must scan
 * each block, not just per-message.
 */
export function findToolResultBlock(
	payload: AnthropicPayload,
	toolUseId: string,
): { msgIdx: number; blockIdx: number } | null {
	if (!payload.messages) return null;
	for (let i = 0; i < payload.messages.length; i++) {
		const m = payload.messages[i];
		if (m.role !== "user" || !Array.isArray(m.content)) continue;
		for (let j = 0; j < m.content.length; j++) {
			const block = m.content[j];
			if (block?.type === "tool_result" && block?.tool_use_id === toolUseId) {
				return { msgIdx: i, blockIdx: j };
			}
		}
	}
	return null;
}

/** Apply cache_control to a specific block; tag with owner so listMarkers can identify it later. */
export function setMessageMarker(
	payload: AnthropicPayload,
	msgIdx: number,
	blockIdx: number,
	control: CacheControl,
	owner: string,
): void {
	const block = payload.messages?.[msgIdx]?.content as any[] | undefined;
	if (!block) return;
	const target = block[blockIdx];
	if (!target) return;
	target.cache_control = control;
	setOwner(target, owner);
}

export function dropMessageMarker(payload: AnthropicPayload, msgIdx: number, blockIdx: number): void {
	const block = payload.messages?.[msgIdx]?.content as any[] | undefined;
	if (!block) return;
	const target = block[blockIdx];
	if (!target) return;
	delete target.cache_control;
	clearOwner(target);
}

export function dropSystemMarker(payload: AnthropicPayload, idx: number): void {
	const b = payload.system?.[idx];
	if (!b) return;
	delete b.cache_control;
	clearOwner(b);
}

export function dropToolsMarker(payload: AnthropicPayload, idx: number): void {
	const t = payload.tools?.[idx];
	if (!t) return;
	delete t.cache_control;
	clearOwner(t);
}

/**
 * Ground-truth marker count via JSON traversal. Counts every `cache_control`
 * field reachable from the payload root, regardless of nesting depth or block
 * shape. This is the number Anthropic's server-side validator sees.
 *
 * We use this instead of trusting listMarkers() for the 4-limit check, because
 * listMarkers() only inspects known block shapes (top-level system/tools blocks,
 * direct message content blocks) and can undercount when an upstream extension
 * places markers in unexpected positions.
 */
export function countMarkersRaw(payload: AnthropicPayload): number {
	let count = 0;
	const visit = (node: any): void => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) { for (const x of node) visit(x); return; }
		for (const [k, v] of Object.entries(node)) {
			if (k === "cache_control" && v && typeof v === "object") count++;
			else if (k !== "cache_control") visit(v);
		}
	};
	visit(payload);
	return count;
}

/**
 * Enforce the 4-marker hard limit using GROUND-TRUTH JSON count, not listMarkers.
 *
 * Phase 1 (preferred): use listMarkers + structured eviction tiers:
 *   1. message-level markers NOT owned by us (rolling foreign markers)
 *   2. tools markers NOT owned by us
 *   3. system markers NOT owned by us
 *   4. our own markers (last_anchor) — protected as last resort
 *
 * Phase 2 (fallback): if raw JSON count still > max after Phase 1 exhausted,
 * we have a marker in a shape listMarkers doesn't recognize. Walk the payload
 * and brute-force delete the first non-owned cache_control we find, scanning
 * sections in order: messages → tools → system (matches Anthropic processing
 * order, so we drop the latest/rolling markers first while preserving the
 * cacheable static prefix).
 *
 * Returns the number of markers dropped.
 */
export function enforceMarkerLimit(payload: AnthropicPayload, max = 4): number {
	let dropped = 0;

	// Phase 1: structured eviction
	let markers = listMarkers(payload);
	while (markers.length > max) {
		const candidate = pickEvictionTarget(markers);
		if (!candidate) break;
		switch (candidate.section) {
			case "messages": dropMessageMarker(payload, candidate.idx, candidate.blockIdx!); break;
			case "tools":    dropToolsMarker(payload, candidate.idx); break;
			case "system":   dropSystemMarker(payload, candidate.idx); break;
		}
		dropped++;
		markers = listMarkers(payload);
	}

	// Phase 2: brute-force fallback against ground-truth JSON count. Catches
	// markers in shapes listMarkers doesn't recognize (e.g. upstream extensions
	// stamping markers on nested blocks).
	while (countMarkersRaw(payload) > max) {
		const removed = bruteForceDropForeignMarker(payload);
		if (!removed) break; // only our own markers remain, can't drop more without losing anchor cache
		dropped++;
	}

	return dropped;
}

/**
 * Walk the payload and delete the first cache_control marker we find that is
 * not owned by us. Sections scanned in Anthropic processing order so we drop
 * later (rolling) markers before earlier (stable prefix) markers when foreign:
 * messages → tools → system. Returns true if a marker was dropped.
 */
function bruteForceDropForeignMarker(payload: AnthropicPayload): boolean {
	const tryDrop = (containerArrays: any[][]): boolean => {
		for (const arr of containerArrays) {
			for (const block of arr) {
				if (!block || typeof block !== "object") continue;
				if (block.cache_control && getOwner(block) === undefined) {
					delete block.cache_control;
					return true;
				}
				// Recurse into known content arrays (message.content, tool_result.content)
				if (Array.isArray(block.content) && tryDrop([block.content])) return true;
			}
		}
		return false;
	};

	// messages first (newest → oldest), then tools, then system
	if (payload.messages) {
		for (let i = payload.messages.length - 1; i >= 0; i--) {
			const m = payload.messages[i];
			if (Array.isArray(m.content) && tryDrop([m.content])) return true;
		}
	}
	if (payload.tools && tryDrop([payload.tools])) return true;
	if (payload.system && tryDrop([payload.system])) return true;

	return false;
}



function pickEvictionTarget(markers: MarkerRef[]): MarkerRef | null {
	// tier 1: foreign message markers, oldest first
	const foreignMessages = markers.filter(m => m.section === "messages" && !m.owner);
	if (foreignMessages.length > 0) return foreignMessages[0];
	// tier 2: foreign tools markers
	const foreignTools = markers.filter(m => m.section === "tools" && !m.owner);
	if (foreignTools.length > 0) return foreignTools[0];
	// tier 3: foreign system markers
	const foreignSystem = markers.filter(m => m.section === "system" && !m.owner);
	if (foreignSystem.length > 0) return foreignSystem[0];
	// tier 4: even our own — last resort, drop the OLDEST anchor (mid_anchor before last_anchor)
	const ownAnchors = markers.filter(m => m.section === "messages" && m.owner === "mid_anchor");
	if (ownAnchors.length > 0) return ownAnchors[0];
	return null;
}
