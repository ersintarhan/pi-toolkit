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

interface CommandActionState {
	ops: CommandOps | null;
	pending: PendingAction | null;
	activePivot: PendingPivot | null;
}

interface BindCommandContextPatch {
	original: ExtensionRunner["bindCommandContext"];
	patched: ExtensionRunner["bindCommandContext"];
}

const STATE_KEY = Symbol.for("pi-toolkit.auto-context.command-actions.state.v1");
const PATCH_KEY = Symbol.for("pi-toolkit.auto-context.bind-command-context.patch.v1");

function getState(): CommandActionState {
	const globals = globalThis as Record<symbol, unknown>;
	const existing = globals[STATE_KEY] as CommandActionState | undefined;
	if (existing) return existing;
	const state: CommandActionState = { ops: null, pending: null, activePivot: null };
	globals[STATE_KEY] = state;
	return state;
}

// ── Accessors ───────────────────────────────────────────────

export function isArmed(): boolean { return getState().ops?.navigateTree != null; }
export function hasPending(): boolean { return getState().pending !== null; }
export function getActivePivot(): PendingPivot | null { return getState().activePivot; }

export function clearPending(): void {
	const state = getState();
	state.pending = null;
	state.activePivot = null;
}

export function clearCommandContext(): void {
	const state = getState();
	state.ops = null;
	state.pending = null;
	state.activePivot = null;
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
	const state = getState();
	if (state.ops?.navigateTree == null) {
		return {
			content: [{ type: "text", text: `Command context not captured. ${params.fallbackHint}` }],
			details: {},
		};
	}
	if (state.pending) {
		return {
			content: [{ type: "text", text: `Another pending action (${state.pending.kind}) is already scheduled. Wait for the current turn to finish.` }],
			details: {},
		};
	}
	state.pending = params.action;
	return {
		content: [{ type: "text", text: params.successText }],
		details: params.details ?? {},
	};
}

// ── Patch ───────────────────────────────────────────────────

export function patchBindCommandContext(): boolean {
	const prototype = ExtensionRunner.prototype;
	const markers = prototype as unknown as Record<symbol, unknown>;
	if (markers[PATCH_KEY]) return true;
	try {
		const original = prototype.bindCommandContext;
		if (typeof original !== "function") return false;

		const patched: typeof original = function (this: ExtensionRunner, ...args: Parameters<typeof original>) {
			const actions = args[0];
			// Only arm when navigateTree is actually a function, so isArmed() never
			// reports armed for a pi version that lacks this private API.
			getState().ops = actions && typeof actions.navigateTree === "function"
				? { navigateTree: actions.navigateTree }
				: null;
			return Reflect.apply(original, this, args);
		};

		prototype.bindCommandContext = patched;
		markers[PATCH_KEY] = { original, patched } satisfies BindCommandContextPatch;
		return true;
	} catch {
		return false;
	}
}

export function restoreBindCommandContext(): boolean {
	const prototype = ExtensionRunner.prototype;
	const markers = prototype as unknown as Record<symbol, unknown>;
	const patch = markers[PATCH_KEY] as BindCommandContextPatch | undefined;
	if (!patch?.original || prototype.bindCommandContext !== patch.patched) return false;
	prototype.bindCommandContext = patch.original;
	delete markers[PATCH_KEY];
	clearCommandContext();
	return true;
}

// ── Execute pending actions ─────────────────────────────────

export async function runPending(
	notify?: (msg: string, level: "info" | "warning" | "error") => void,
	runtime?: RuntimeContext,
): Promise<void> {
	const state = getState();
	const ops = state.ops;
	if (!ops) return;
	// Consume before awaiting so a long-running action does not block further
	// scheduling. During the await below, `hasPending()` returns false and the
	// session is typically being replaced anyway.
	const action = state.pending;
	state.pending = null;
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
				state.activePivot = action;
				const r = await ops.navigateTree(action.targetId, { summarize: true });
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
			finally { state.activePivot = null; }
			return;
		}

		default: {
			// Exhaustiveness: if a new kind is added without a case, TS surfaces it here.
			const _exhaustive: never = action.kind;
			return _exhaustive;
		}
	}
}
