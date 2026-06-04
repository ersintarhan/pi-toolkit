/**
 * pi-auto-context — automatic context management for pi.
 *
 * One router tool, always active:
 *   context — view, recall, anchor, pivot
 *
 * Also registers a context event hook to:
 *   - inject a status line ([pi-auto-context] model=… | context=…% | tool=…% | anchor=…)
 *   - truncate old tool results (before the last anchor) to save context window
 *   - remind once if no anchors exist after 10+ entries
 *
 * Uses a private API hack to capture command-only closures from
 * ExtensionRunner.prototype.bindCommandContext, then executes a pending pivot
 * after agent_end + setTimeout(0). Upstream equivalent: pi.runWhenIdle() (#2023).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { patchBindCommandContext, runPending, clearPending, isArmed, hasPending, getActivePivot } from "./command-actions.js";
import { isAnchorEntry, isAnchorToolResult, anchorNameOf } from "./context/anchors.js";
import { registerContextRouter } from "./context/router.js";
import registerAnchorCache from "./anchor-cache/index.js";

export default function (pi: ExtensionAPI) {
	// Patch ExtensionRunner to auto-capture command context actions.
	const patchOk = patchBindCommandContext();

	registerContextRouter(pi);

	// Anchor-aware Anthropic prompt-cache breakpoint optimization.
	// No-ops on non-Anthropic providers; idempotent w.r.t. pi-better-messages-cache.
	registerAnchorCache(pi);

	// ── Context event: truncate old tool results + status line + anchor reminder ──
	// Receives AgentMessage[]. Anchors are toolResults with toolName=="context" and details.anchor.
	let anchorReminderSent = false;
	let pendingRunTimer: ReturnType<typeof setTimeout> | undefined;
	pi.on("context", async (event, ctx) => {
		const messages = event.messages;
		if (!messages || messages.length === 0) return;

		let modified = false;

		// Find the last anchor index in AgentMessage[] by toolResult details
		let lastAnchorIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (isAnchorToolResult(messages[i])) {
				lastAnchorIdx = i;
				break;
			}
		}

		// Truncate tool results before the last anchor (skip anchor toolResults themselves)
		if (lastAnchorIdx > 0) {
			for (let i = 0; i < lastAnchorIdx; i++) {
				const m = messages[i] as any;
				if (m.role === "toolResult" && !isAnchorToolResult(m)) {
					if (typeof m.content === "string" && m.content.length > 50) {
						m.content = m.content.slice(0, 20) + `…✂${m.content.length}`;
						modified = true;
					} else if (Array.isArray(m.content)) {
						for (const part of m.content) {
							if (part.type === "text" && part.text && part.text.length > 50) {
								part.text = part.text.slice(0, 20) + `…✂${part.text.length}`;
								modified = true;
							}
						}
					}
				}
			}
		}

		// Insert status as a standalone message AFTER the last user message.
		// Rationale: putting pi-status at the tail keeps the request prefix identical
		// to the no-status baseline, so prefix cache hits are preserved across turns.
		const currentModel = ctx.model;
		if (currentModel) {
			const usage = ctx.getContextUsage?.();
			const parts: string[] = [];
			if (usage && typeof usage.percent === "number") {
				// 1% precision; pi-status sits after the last user message and other
				// fields change each turn, so rounding gains nothing.
				const pct = Math.min(100, Math.round(usage.percent));
				parts.push(`context=${pct}%`);
			}

			// Tool-output share — proxy for context noise density. Only surface it
			// when the share is meaningfully high (>50%) so the status line does not
			// imply compaction pressure during normal runs.
			let totalChars = 0;
			let toolChars = 0;
			for (const m of messages as any[]) {
				let mc = 0;
				if (typeof m.content === "string") mc = m.content.length;
				else if (Array.isArray(m.content)) {
					for (const part of m.content) {
						if (typeof part?.text === "string") mc += part.text.length;
						else if (typeof part?.content === "string") mc += part.content.length;
					}
				}
				totalChars += mc;
				if (m.role === "toolResult") toolChars += mc;
			}
			if (totalChars > 0) {
				const toolPct = Math.round((toolChars / totalChars) * 100);
				if (toolPct > 50) parts.push(`toolShare=${toolPct}%`);
			}

			// Anchor info — only consider anchors on the current branch so status
			// reflects where the agent actually is, not orphaned anchors from abandoned branches.
			const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];
			const anchors = branchEntries.filter(isAnchorEntry);
			let latestAnchorName: string | undefined;
			let latestAnchorDistance = 0;
			if (anchors.length > 0) {
				const latestAnchor = anchors[anchors.length - 1];
				latestAnchorName = anchorNameOf(latestAnchor);
				if (latestAnchorName) {
					// Distance to the most recent anchor, measured in branch entries.
					// Long distance (e.g. -15) reminds the agent to checkpoint progress
					// rather than risk a long un-anchored chain that's hard to pivot back to.
					const latestIdx = branchEntries.indexOf(latestAnchor);
					latestAnchorDistance = latestIdx >= 0 ? branchEntries.length - 1 - latestIdx : 0;
					parts.push(`anchor=${latestAnchorName} (-${latestAnchorDistance})`);
				}
			}

			// Anchor reminder — only once per session
			if (!anchorReminderSent) {
				if (anchors.length > 0) {
					anchorReminderSent = true;
				} else if (branchEntries.length > 10) {
					parts.push(`hint=no-anchors-yet`);
					anchorReminderSent = true;
				}
			}

			// Human-facing footer mirror of the model status line. Uses pi's status
			// bar (alongside git branch / other extensions), never the transcript
			// or input editor.
			if (ctx.hasUI) {
				const footerBits: string[] = [];
				if (usage && typeof usage.percent === "number") {
					footerBits.push(`ctx ${Math.min(100, Math.round(usage.percent))}%`);
				}
				if (latestAnchorName) {
					footerBits.push(
						`anchor:${latestAnchorName}${latestAnchorDistance > 0 ? ` -${latestAnchorDistance}` : ""}`,
					);
				}
				ctx.ui.setStatus("auto-context", footerBits.length ? footerBits.join(" · ") : undefined);
			}

			const statusMsg = {
				role: "custom",
				customType: "pi-status",
				content: `[pi-auto-context] ${parts.join(" | ")}`,
				display: false,
				timestamp: Date.now(),
			} as any;

			// Find last user message and insert AFTER it.
			let inserted = false;
			for (let i = messages.length - 1; i >= 0; i--) {
				if ((messages[i] as any).role === "user") {
					messages.splice(i + 1, 0, statusMsg);
					inserted = true;
					break;
				}
			}
			if (!inserted) messages.push(statusMsg);
			modified = true;
		}

		if (modified) return { messages };
	});

	pi.on("session_before_tree", async (event) => {
		const pivot = getActivePivot();
		if (!pivot) return;
		if (event.preparation.targetId !== pivot.targetId) return;

		const sourceLeaf = event.preparation.oldLeafId;
		const sourceInfo = `Pivoted from: ${sourceLeaf?.slice(0, 8) ?? "unknown"}`;
		return {
			summary: {
				summary: `${sourceInfo}\n\n${pivot.carryover}`,
			},
		};
	});

	// ── Execute pending actions after agent fully settles ──
	pi.on("agent_end", async (_event, ctx) => {
		if (!hasPending()) return;
		const notify = ctx.hasUI
			? (msg: string, level: "info" | "warning" | "error") => ctx.ui.notify(msg, level)
			: undefined;
		const runtime = {
			sendFollowUp: (msg: string) => pi.sendUserMessage(msg, { deliverAs: "followUp" }),
			getEditorText:
				ctx.hasUI && typeof ctx.ui.getEditorText === "function"
					? () => ctx.ui.getEditorText()
					: undefined,
			setEditorText:
				ctx.hasUI && typeof ctx.ui.setEditorText === "function"
					? (t: string) => ctx.ui.setEditorText(t)
					: undefined,
		};
		if (pendingRunTimer) clearTimeout(pendingRunTimer);
		pendingRunTimer = setTimeout(() => {
			pendingRunTimer = undefined;
			if (!hasPending()) return;
			runPending(notify, runtime).catch((e) => {
				if (notify) notify(`pi-auto-context runPending error: ${e}`, "error");
				else console.error("[pi-auto-context] runPending error:", e);
			});
		}, 0);
	});

	// Warn once if patch failed or command context was never bound.
	let warnedOnce = false;
	pi.on("session_start", async (_event, ctx) => {
		anchorReminderSent = false;
		if (warnedOnce) return;
		if (!patchOk) {
			warnedOnce = true;
			if (ctx.hasUI) ctx.ui.notify("pi-auto-context: failed to patch ExtensionRunner — pivot will fall back to built-in /tree", "warning");
		} else if (!isArmed()) {
			warnedOnce = true;
			if (ctx.hasUI) ctx.ui.notify("pi-auto-context: command context not captured — pivot will fall back to built-in /tree", "warning");
		}
	});

	// Clear stale pending state on session shutdown.
	pi.on("session_shutdown", async (_event, ctx) => {
		anchorReminderSent = false;
		if (ctx.hasUI) ctx.ui.setStatus("auto-context", undefined);
		if (pendingRunTimer) {
			clearTimeout(pendingRunTimer);
			pendingRunTimer = undefined;
		}
		clearPending();
	});
}
