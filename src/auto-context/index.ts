/**
 * pi-auto-context — automatic context management for pi.
 *
 * One router tool, always active:
 *   context — view, recall, anchor, pivot
 *
 * Also registers a context event hook to:
 *   - show a footer status (context % and current anchor) in the TUI status bar
 *   - truncate old tool results (before the last anchor) to save context window
 *
 * Uses a private API hack to capture command-only closures from
 * ExtensionRunner.prototype.bindCommandContext, then executes a pending pivot
 * after agent_settled + setTimeout(0). The settled event avoids retries,
 * auto-compaction, and follow-up continuations; the timer exits event dispatch
 * before invoking the private command operation (#2023).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { patchBindCommandContext, runPending, clearPending, isArmed, hasPending, getActivePivot } from "./command-actions.js";
import { isAnchorEntry, isAnchorToolResult, anchorNameOf } from "./context/anchors.js";
import { registerContextRouter } from "./context/router.js";
import registerAnchorCache from "./anchor-cache/index.js";
import { createLogger } from "../logger.js";

const log = createLogger("pi-auto-context");

export default function (pi: ExtensionAPI) {
	// Patch ExtensionRunner to auto-capture command context actions.
	const patchOk = patchBindCommandContext();

	registerContextRouter(pi);

	// Anchor-aware Anthropic prompt-cache breakpoint optimization.
	// No-ops on non-Anthropic providers; idempotent w.r.t. pi-better-messages-cache.
	registerAnchorCache(pi);

	// ── Context event: truncate old tool results + footer status ──
	// Receives AgentMessage[]. Anchors are toolResults with toolName=="context" and details.anchor.
	// NOTE: This handler only truncates old tool results and updates the footer
	// status. It must NOT inject any message into the transcript — model-facing
	// status notes were removed because they distracted the agent.
	let pendingRunTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Build the context/anchor status parts shared by the footer (human) and the
	 * model-facing payload note. Pure so it can run from any event with a ctx.
	 */
	function buildStatusParts(ctx: any): {
		parts: string[];
		latestAnchorName?: string;
		latestAnchorDistance: number;
	} {
		const parts: string[] = [];
		let latestAnchorName: string | undefined;
		let latestAnchorDistance = 0;

		const usage = ctx.getContextUsage?.();
		if (usage && typeof usage.percent === "number") {
			const pct = Math.min(100, Math.round(usage.percent));
			parts.push(`context=${pct}%`);
		}

		// Only consider anchors on the current branch so status reflects where the
		// agent actually is, not orphaned anchors from abandoned branches.
		const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];
		const anchors = branchEntries.filter(isAnchorEntry);
		if (anchors.length > 0) {
			const latestAnchor = anchors[anchors.length - 1];
			latestAnchorName = anchorNameOf(latestAnchor);
			if (latestAnchorName) {
				const latestIdx = branchEntries.indexOf(latestAnchor);
				latestAnchorDistance = latestIdx >= 0 ? branchEntries.length - 1 - latestIdx : 0;
				parts.push(`anchor=${latestAnchorName} (-${latestAnchorDistance})`);
			}
		}

		return { parts, latestAnchorName, latestAnchorDistance };
	}

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

		// Human-facing footer status. Uses pi's status bar (alongside git branch /
		// other extensions), never the transcript or input editor. The model-facing
		// status is injected separately in `before_provider_request`.
		const currentModel = ctx.model;
		if (currentModel && ctx.hasUI) {
			const { latestAnchorName, latestAnchorDistance } = buildStatusParts(ctx);
			const usage = ctx.getContextUsage?.();
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
	pi.on("agent_settled", async (_event, ctx) => {
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
				else log.error("runPending error:", e);
			});
		}, 0);
	});

	// Warn once if patch failed or command context was never bound.
	let warnedOnce = false;
	pi.on("session_start", async (_event, ctx) => {
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
		if (ctx.hasUI) ctx.ui.setStatus("auto-context", undefined);
		if (pendingRunTimer) {
			clearTimeout(pendingRunTimer);
			pendingRunTimer = undefined;
		}
		clearPending();
	});
}
