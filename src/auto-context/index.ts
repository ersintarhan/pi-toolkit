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
import { patchBindCommandContext, restoreBindCommandContext, runPending, clearCommandContext, isArmed, hasPending, getActivePivot } from "./command-actions.js";
import { isAnchorEntry, anchorNameOf } from "./context/anchors.js";
import { registerContextRouter } from "./context/router.js";
import { thinBeforeLastAnchor } from "./context/thin.js";
import registerAnchorCache from "./anchor-cache/index.js";
import { createLogger } from "../logger.js";
import { setOptionalStatus } from "../status-display.js";

const log = createLogger("pi-auto-context");

export default function (pi: ExtensionAPI) {
	// Patch ExtensionRunner to auto-capture command context actions.
	const patchOk = patchBindCommandContext();

	registerContextRouter(pi);

	// Anchor-aware Anthropic prompt-cache breakpoint optimization.
	// No-ops on non-Anthropic providers; idempotent w.r.t. pi-better-messages-cache.
	registerAnchorCache(pi);

	// ── Context event: truncate old tool results + human-only footer status ──
	// Receives AgentMessage[]. Anchors are toolResults with toolName=="context" and details.anchor.
	let pendingRunTimer: ReturnType<typeof setTimeout> | undefined;

	function buildStatusParts(ctx: any): {
		latestAnchorName?: string;
		latestAnchorDistance: number;
	} {
		const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];
		const latestAnchor = branchEntries.filter(isAnchorEntry).at(-1);
		const latestAnchorName = latestAnchor ? anchorNameOf(latestAnchor) : undefined;
		const latestIdx = latestAnchor ? branchEntries.indexOf(latestAnchor) : -1;
		return {
			latestAnchorName,
			latestAnchorDistance: latestIdx >= 0 ? branchEntries.length - 1 - latestIdx : 0,
		};
	}

	pi.on("context", async (event, ctx) => {
		const messages = event.messages;
		if (!messages || messages.length === 0) return;

		const modified = thinBeforeLastAnchor(messages);

		// Human-facing footer status; never injected into the transcript or editor.
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
			setOptionalStatus(ctx, "auto-context", footerBits.length ? footerBits.join(" · ") : undefined);
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
		clearCommandContext();
		restoreBindCommandContext();
	});
}
