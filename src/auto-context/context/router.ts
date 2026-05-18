import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveTarget, getAnchors, findAnchorByName, formatAnchorContent, type AnchorState } from "./anchors.js";
import { scheduleAction } from "../command-actions.js";
import { scanAnchors } from "../utils.js";

export function registerContextRouter(pi: ExtensionAPI) {
	pi.registerTool({
		name: "context",
		label: "Context",
		description: [
			"Context management.",
			"anchor: create a retrospective checkpoint.",
			"view: show current-session anchors.",
			"pivot: jump with carryover summary.",
			"recall: search past-session anchors by keyword, without switching.",
		].join(" "),
		promptSnippet: "Context management: anchor, view, pivot, recall",
		promptGuidelines: [
			"Use context(action='anchor') at meaningful task boundaries; summarize completed/decided state, not todos.",
			"Use context(action='view') to see anchors in this session before deciding where to pivot.",
			"Use context(action='pivot') to return to a prior anchor when changing approach; include carryover.",
			"Use context(action='recall') before related work to check past session anchors.",
		],
		parameters: Type.Object({
			action: StringEnum(["view", "recall", "anchor", "pivot"] as const, {
				description: "Action to perform",
			}),
			limit: Type.Optional(Type.Number({ description: "Max results to show. Default: 30 for view, 10 for recall." })),
			offset: Type.Optional(Type.Number({ description: "Skip N results. Default: 0. For view and recall." })),
			keyword: Type.Optional(Type.String({ description: "Keyword (case-insensitive) matched against anchor name and summary. For recall." })),
			scope: Type.Optional(StringEnum(["cwd", "all"] as const, { description: '"cwd" (default) limits recall to sessions in the current working directory; "all" scans every session. For recall.' })),
			name: Type.Optional(Type.String({ description: "Anchor name (must be unique). For anchor." })),
			summary: Type.Optional(Type.String({ description: "Retrospective state: what's done, key decisions, what was confirmed. For anchor." })),
			target: Type.Optional(Type.String({ description: "Target: anchor name, entry ID, or label. For pivot." })),
			carryover: Type.Optional(Type.String({ description: "Required summary of current progress to carry into the new branch. For pivot." })),
			message: Type.Optional(Type.String({ description: "Optional next-turn directive delivered as a user message. For pivot. Omit to leave the new branch idle." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			switch (params.action) {
				// ── view ─────────────────────────────────────────────
				case "view": {
					const limit = Math.max(0, Math.trunc(params.limit ?? 30));
					const offset = Math.max(0, Math.trunc(params.offset ?? 0));
					const anchors = getAnchors(ctx.sessionManager);

					if (anchors.length === 0) {
						return {
							content: [{ type: "text", text: "No anchors in this session." }],
							details: { anchors: 0 },
						};
					}

					const currentBranchIds = new Set(ctx.sessionManager.getBranch().map((e: any) => e.id));

					// Render order: on-branch newest-first, then off-branch newest-first.
					const onBranch = anchors
						.filter(a => currentBranchIds.has(a.data.targetId))
						.reverse()
						.map(a => ({ anchor: a, onBranch: true }));
					const offBranch = anchors
						.filter(a => !currentBranchIds.has(a.data.targetId))
						.reverse()
						.map(a => ({ anchor: a, onBranch: false }));
					const ordered = [...onBranch, ...offBranch];
					const shown = limit > 0 ? ordered.slice(offset, offset + limit) : [];
					const latestOnBranchId = onBranch[0]?.anchor.id;

					const lines: string[] = [];
					let inOffBranch = false;
					for (const item of shown) {
						const a = item.anchor;
						if (!item.onBranch && !inOffBranch) {
							if (lines.length > 0) lines.push("");
							lines.push("off-branch:");
							inOffBranch = true;
						} else if (lines.length > 0) {
							lines.push("");
						}
						const indent = item.onBranch ? "" : "  ";
						const summaryIndent = item.onBranch ? "  " : "    ";
						const marker = a.id === latestOnBranchId ? " <- latest" : "";
						lines.push(`${indent}${a.data.name} [${a.data.targetId.slice(0, 8)}]${marker}`);
						lines.push(`${summaryIndent}summary: ${a.data.summary}`);
					}

					const onBranchShown = shown.filter(item => item.onBranch).length;
					const onBranchHidden = onBranch.length - onBranchShown;
					if (onBranchHidden > 0) {
						if (lines.length > 0) lines.push("");
						lines.push(`... ${onBranchHidden} more on-branch anchor(s) (use offset to page)`);
					}

					const start = offset + 1;
					const end = offset + shown.length;
					const header = shown.length > 0
						? `anchors (${shown.length} shown, ${start}-${end} of ${anchors.length}; on-branch first)`
						: `anchors (0 shown, offset ${offset} of ${anchors.length})`;
					const body = lines.length > 0 ? `${header}\n${lines.join("\n")}` : header;
					return {
						content: [{ type: "text", text: body }],
						details: { total: anchors.length, shown: shown.length, offset, limit, hasMore: offset + shown.length < anchors.length },
					};
				}

				// ── recall ──────────────────────────────
				case "recall": {
					if (!params.keyword) {
						return { content: [{ type: "text", text: "`keyword` is required for recall." }], details: {} };
					}
					const limit = Math.max(0, Math.trunc(params.limit ?? 10));
					const offset = Math.max(0, Math.trunc(params.offset ?? 0));
					const scope = (params.scope ?? "cwd") as "cwd" | "all";
					const matches = await scanAnchors(params.keyword, scope, ctx.cwd, limit, offset, signal);

					if (matches.length === 0) {
						return {
							content: [{ type: "text", text: `No anchors matching "${params.keyword}" at offset ${offset} (scope: ${scope}).` }],
							details: { matches: 0, scope, offset, limit },
						};
					}

					const uniqueSessions = new Set(matches.map(m => m.sessionFile));
					const headerLine = `recall "${params.keyword}" (${matches.length} match${matches.length === 1 ? "" : "es"}, offset: ${offset}, across ${uniqueSessions.size} session${uniqueSessions.size === 1 ? "" : "s"}, scope: ${scope})`;

					const lines = matches.map(m => {
						const firstLine = (m.summary.split("\n")[0] ?? "").slice(0, 100);
						const ellipsis = (m.summary.split("\n")[0] ?? "").length > 100 ? "..." : "";
						const dateStr = m.timestamp ? m.timestamp.slice(0, 10) : "";
						const basename = m.sessionFile.split("/").pop() ?? m.sessionFile;
						return `- ${m.anchorName} [${m.anchorId.slice(0, 8)}]  @ ${basename}\n  (${dateStr}) ${firstLine}${ellipsis}`;
					});

					return {
						content: [{ type: "text", text: [headerLine, "", ...lines, "", "Use the built-in `/resume` command to switch into a matching session."].join("\n") }],
						details: { matches: matches.length, scope, offset, limit, anchors: matches },
					};
				}

				// ── anchor ──────────────────────────────────────────
				case "anchor": {
					if (!params.name || !params.summary) {
						return { content: [{ type: "text", text: "`name` and `summary` are required for anchor." }], details: {} };
					}

					// Check name uniqueness
					const existing = findAnchorByName(ctx.sessionManager, params.name);
					if (existing) {
						const firstLine = existing.summary.split("\n")[0] ?? "";
						const preview = firstLine.slice(0, 100);
						const ellipsis = firstLine.length > 100 ? "..." : "";
						return {
							content: [{
								type: "text",
								text: `Anchor "${params.name}" already exists at [${existing.targetId.slice(0, 8)}]:\n  summary: ${preview}${ellipsis}\nChoose a different name (e.g. ${params.name}-v2, ${params.name}-revised) or review the existing one via context(view).`,
							}],
							details: {},
						};
					}

					// Also check against generic labels
					const entries = ctx.sessionManager.getEntries();
					for (const e of entries) {
						if (ctx.sessionManager.getLabel(e.id) === params.name) {
							return {
								content: [{
									type: "text",
									text: `Label "${params.name}" is already used by entry [${e.id.slice(0, 8)}]. Choose a different name.`,
								}],
								details: {},
							};
						}
					}

					const leafId = ctx.sessionManager.getLeafId();
					if (!leafId) {
						return { content: [{ type: "text", text: "No current leaf to anchor." }], details: {} };
					}

					const anchorData: AnchorState = {
						name: params.name,
						targetId: leafId,
						summary: params.summary,
					};

					// Return anchor content in tool result:
					// - content: visible to LLM on this turn
					// - details.anchor: structured data for getAnchors() to discover via getEntries()
					const content = formatAnchorContent(params.name, params.summary);
					return {
						content: [{ type: "text", text: content }],
						details: { anchor: anchorData },
					};
				}

				// ── pivot ───────────────────────────────────────────
				case "pivot": {
					if (!params.target) {
						return { content: [{ type: "text", text: "`target` is required for pivot." }], details: {} };
					}
					if (!params.carryover) {
						return { content: [{ type: "text", text: "`carryover` is required for pivot." }], details: {} };
					}
					const targetId = resolveTarget(ctx.sessionManager, params.target);
					if (!targetId) {
						return { content: [{ type: "text", text: `Target "${params.target}" not found. Use context(action='view') to find valid anchors.` }], details: {} };
					}
					if (targetId === ctx.sessionManager.getLeafId()) {
						return { content: [{ type: "text", text: "Pivot target is already the current leaf. Choose an earlier anchor or entry." }], details: {} };
					}
					const preLeafId = ctx.sessionManager.getLeafId();
					const carryoverWithReturn = preLeafId
						? `${params.carryover}\n\n[Pivot from entry: ${preLeafId.slice(0, 12)}; pivot(target="${preLeafId.slice(0, 12)}") to return.]`
						: params.carryover!;
					return scheduleAction({
						fallbackHint: "Use built-in `/tree` to navigate instead.",
						action: {
							kind: "pivot",
							targetId,
							carryover: carryoverWithReturn,
							message: params.message,
						},
						successText: `Scheduled pivot to ${params.target} (${targetId.slice(0, 8)})${params.message ? " (with custom followUp message)" : ""}.`,
						details: { scheduled: "pivot", targetId, message: params.message },
					});
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: "${params.action}"` }], details: {} };
			}
		},
	});
}
