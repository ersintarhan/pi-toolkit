/**
 * Private API hack: auto-capture command-only closures from ExtensionRunner.
 *
 * pi's public API only exposes navigateTree on ExtensionCommandContext
 * (command handlers), not on ExtensionContext (tools/events). We patch
 * ExtensionRunner.prototype.bindCommandContext to capture that closure when the
 * runtime binds it, then execute pending pivot actions after agent_settled +
 * setTimeout(0), outside both the agent run and extension event dispatch.
 *
 * agent_settled solves the timing half of #2023; the private patch remains
 * necessary because settled event contexts still omit navigateTree.
 */

import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../logger.js";

const log = createLogger("pi-auto-context");

// ── Types ───────────────────────────────────────────────────

/**
 * A pending deferred action.
 *
 * pi-auto-context only schedules pivots. We keep the discriminated-union shape
 * so adding more actions later stays a one-line change.
 */
export type PendingAction =
	| { kind: "pivot"; targetId: string; carryover: string; message?: string; label?: string; expectedInjection?: string };

export type PendingPivot = Extract<PendingAction, { kind: "pivot" }>;

export interface RuntimeContext {
	sendFollowUp: (msg: string) => void | Promise<void>;
	/** Snapshot/restore the input editor so a programmatic pivot does not leave
	 *  the built-in /tree handler's auto-filled target text in the prompt. */
	getEditorText?: () => string;
	setEditorText?: (text: string) => void;
}

export interface CommandOps {
	navigateTree: (targetId: string, options?: {
		summarize?: boolean;
		customInstructions?: string;
		replaceInstructions?: boolean;
		label?: string;
	}) => Promise<{ cancelled: boolean }>;
}

// ── State ───────────────────────────────────────────────────

let _ops: CommandOps | null = null;
let _pending: PendingAction | null = null;
let _activePivot: PendingPivot | null = null;

// ── Accessors ───────────────────────────────────────────────

export function isArmed(): boolean { return _ops?.navigateTree != null; }
export function hasPending(): boolean { return _pending !== null; }
export function getActivePivot(): PendingPivot | null { return _activePivot; }

export function clearPending(): void {
	_pending = null;
	_activePivot = null;
}

/**
 * Router-facing helper: dispatch a pending action.
 *
 * Callers do action-specific validation first, then hand off to scheduleAction
 * which handles the isArmed / hasPending / set / response boilerplate.
 */
export interface ScheduleParams {
	/** Short hint pointing at the built-in fallback command, e.g. "Use built-in `/tree` instead." */
	fallbackHint: string;
	/** The action to schedule. */
	action: PendingAction;
	/** Success text shown to the model when the action was scheduled. */
	successText: string;
	/** Structured details echoed back to the model. */
	details?: Record<string, any>;
}

export function scheduleAction(params: ScheduleParams): { content: Array<{ type: "text"; text: string }>; details: Record<string, any> } {
	if (!isArmed()) {
		return {
			content: [{ type: "text", text: `Command context not captured. ${params.fallbackHint}` }],
			details: {},
		};
	}
	if (hasPending()) {
		return {
			content: [{ type: "text", text: `Another pending action (${_pending?.kind}) is already scheduled. Wait for the current turn to finish.` }],
			details: {},
		};
	}
	_pending = params.action;
	return {
		content: [{ type: "text", text: params.successText }],
		details: params.details ?? {},
	};
}

// ── Patch ───────────────────────────────────────────────────

let _patched = false;

export function patchBindCommandContext(): boolean {
	if (_patched) return true;
	try {
		const orig = ExtensionRunner.prototype.bindCommandContext;
		if (typeof orig !== "function") return false;

		ExtensionRunner.prototype.bindCommandContext = function (actions: any) {
			// Only arm when navigateTree is actually a function, so isArmed() never
			// reports armed for a pi version that lacks this private API.
			_ops = actions && typeof actions.navigateTree === "function"
				? {
					navigateTree: actions.navigateTree,
				}
				: null;
			return orig.call(this, actions);
		};

		_patched = true;
		return true;
	} catch {
		return false;
	}
}

// ── Execute pending actions ─────────────────────────────────

export async function runPending(
	notify?: (msg: string, level: "info" | "warning" | "error") => void,
	runtime?: RuntimeContext,
): Promise<void> {
	if (!_ops) return;
	// Consume before awaiting so a long-running action does not block further
	// scheduling. During the await below, `hasPending()` returns false and the
	// session is typically being replaced anyway.
	const action = _pending;
	_pending = null;
	if (!action) return;

	const reportError = (message: string, error?: unknown) => {
		if (notify) {
			notify(error === undefined ? message : `${message}: ${error}`, "error");
			return;
		}
		if (error === undefined) log.error(message);
		else log.error(`${message}:`, error);
	};

	switch (action.kind) {
		case "pivot": {
			if (!runtime) {
				reportError("Pivot failed: runtime context not available");
				return;
			}
			// pi's built-in /tree handler auto-fills the editor with the target
			// entry's text when the editor is empty. For a programmatic pivot that is
			// noise, so we clear it afterwards — but only when it holds *exactly* that
			// injected text, so a draft the user typed during summarization is never
			// clobbered (and unknown injection => we leave it, never guess).
			const prevEditor = runtime.getEditorText?.();
			try {
				// Let navigateTree build the new branch summary so agent state stays in sync.
				_activePivot = action;
				const r = await _ops.navigateTree(action.targetId, { summarize: true });
				if (r.cancelled) {
					notify?.("Pivot cancelled", "warning");
				} else {
					if (
						runtime.getEditorText &&
						runtime.setEditorText &&
						action.expectedInjection &&
						runtime.getEditorText() === action.expectedInjection &&
						action.expectedInjection !== prevEditor
					) {
						runtime.setEditorText(prevEditor ?? "");
					}
					if (action.message) await runtime.sendFollowUp(action.message);
					notify?.(`Pivoted to ${action.label ?? action.targetId.slice(0, 8)}`, "info");
				}
			} catch (e) { reportError("Pivot failed", e); }
			finally { _activePivot = null; }
			return;
		}

		default: {
			// Exhaustiveness: if a new kind is added without a case, TS surfaces it here.
			const _exhaustive: never = action.kind;
			return _exhaustive;
		}
	}
}
