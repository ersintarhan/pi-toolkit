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
	// NOTE: This handler must NOT inject a visible status message into the transcript.
	// Previously it spliced a `{role:"custom",customType:"pi-status",display:false}` message after
	// the last user message. That message leaked into the input editor area (visible to the
	// user despite display:false) — bad UX and conflicts with powerline-footer. The model-facing
	// status line is now injected at the provider-payload level in `before_provider_request` below,
	// where mutations are sent to the LLM but NEVER persisted/rendered in the UI.
	let anchorReminderSent = false;
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

	// ── before_provider_request: inject a HIDDEN model-facing status line ──
	// Runs at the provider-payload level. Mutations here are sent to the LLM but
	// NEVER persisted to the transcript or rendered in the UI, so the user never
	// sees `[pi-auto-context] ...`. This replaces the old context-event splice
	// (custom pi-status message) which leaked into the input editor.
	pi.on("before_provider_request", async (event, ctx) => {
		if (!ctx.model) return;
		const payload = event.payload as any;
		const msgs = payload?.messages;
		if (!Array.isArray(msgs) || msgs.length === 0) return;

		const { parts } = buildStatusParts(ctx);

		// Tool-output share — proxy for context noise density. Only surface it when
		// meaningfully high (>50%). Computed from the payload's LLM-format messages.
		let totalChars = 0;
		let toolChars = 0;
		for (const m of msgs as any[]) {
			let mc = 0;
			if (typeof m.content === "string") mc = m.content.length;
			else if (Array.isArray(m.content)) {
				for (const part of m.content) {
					if (typeof part?.text === "string") mc += part.text.length;
				}
			}
			totalChars += mc;
			// Anthropic tool outputs arrive as user messages with tool_result parts.
			if (m.role === "user" && Array.isArray(m.content)) {
				for (const part of m.content) {
					if (part?.type === "tool_result") {
						toolChars += typeof part?.content === "string" ? part.content.length : 0;
					}
				}
			}
		}
		if (totalChars > 0) {
			const toolPct = Math.round((toolChars / totalChars) * 100);
			if (toolPct > 50) parts.push(`toolShare=${toolPct}%`);
		}

		// Anchor reminder — only once per session (once-only state lives in closure).
		if (!anchorReminderSent) {
			const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];
			const anchors = branchEntries.filter(isAnchorEntry);
			if (anchors.length > 0) {
				anchorReminderSent = true;
			} else if (branchEntries.length > 10) {
				parts.push(`hint=no-anchors-yet`);
				anchorReminderSent = true;
			}
		}

		if (parts.length === 0) return;
		const note = `[pi-auto-context] ${parts.join(" | ")}`;

		// Insert as a trailing user message AFTER the last user message. Keeps the
		// request prefix identical to the no-status baseline (prefix-cache safe) and
		// matches previous semantics. Provider-agnostic: every provider's payload
		// exposes a `messages` array of {role, content} entries.
		const statusUserMsg = { role: "user", content: note, timestamp: Date.now() } as any;
		let inserted = false;
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i]?.role === "user") {
				msgs.splice(i + 1, 0, statusUserMsg);
				inserted = true;
				break;
			}
		}
		if (!inserted) msgs.push(statusUserMsg);
		return payload;
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
				else log.error("runPending error:", e);
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
