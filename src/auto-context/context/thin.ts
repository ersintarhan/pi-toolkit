import { isAnchorToolResult } from "./anchors.js";

/**
 * Thin out everything before the last anchor, in place.
 *
 * Only entries ahead of the anchor are touched, so the live tool-use loop and
 * the reasoning attached to it are never disturbed. Returns true when anything
 * changed.
 *
 * Two kinds of residue, handled differently:
 *
 * - **Tool results** are truncated to a stub. They are data, so a marker telling
 *   the model something was here is enough.
 * - **Assistant thinking** is dropped whole. It is the noisiest thing left in
 *   the window: high volume, in the model's own voice, and full of the dead ends
 *   it already abandoned. Anthropic only requires a thinking block on the
 *   *final* assistant message, ahead of the lastmost tool_use/tool_result pair;
 *   earlier ones are recommended, not required. Removal is the only safe edit —
 *   the signature authenticates the block, so a rewritten one is rejected while
 *   an absent one is fine.
 */
export function thinBeforeLastAnchor(messages: any[]): boolean {
	if (!messages || messages.length === 0) return false;

	let lastAnchorIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isAnchorToolResult(messages[i])) {
			lastAnchorIdx = i;
			break;
		}
	}
	if (lastAnchorIdx <= 0) return false;

	let modified = false;
	for (let i = 0; i < lastAnchorIdx; i++) {
		const m = messages[i];
		if (m?.role === "toolResult" && !isAnchorToolResult(m)) {
			if (typeof m.content === "string" && m.content.length > 50) {
				m.content = m.content.slice(0, 20) + `…✂${m.content.length}`;
				modified = true;
			} else if (Array.isArray(m.content)) {
				for (const part of m.content) {
					if (part?.type === "text" && part.text && part.text.length > 50) {
						part.text = part.text.slice(0, 20) + `…✂${part.text.length}`;
						modified = true;
					}
				}
			}
		} else if (m?.role === "assistant" && Array.isArray(m.content)) {
			const kept = m.content.filter((part: any) => part?.type !== "thinking");
			// Never empty a message: a content-less assistant turn is invalid.
			if (kept.length !== m.content.length && kept.length > 0) {
				m.content = kept;
				modified = true;
			}
		}
	}
	return modified;
}
