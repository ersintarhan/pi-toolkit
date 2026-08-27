import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import {
	patchBindCommandContext,
	restoreBindCommandContext,
	scheduleAction,
	clearPending,
	clearCommandContext,
	isArmed,
	runPending,
	type RuntimeContext,
	type CommandOps,
} from "../src/auto-context/command-actions";

// ── Helpers ──────────────────────────────────────────────────

/** Patch the module and arm it with a mock navigateTree. */
function arm(navigateTree: CommandOps["navigateTree"]): void {
	patchBindCommandContext();
	// The patched bindCommandContext sets _ops from the actions argument,
	// then forwards to the original. We pass `{} as never` because the
	// original method expects a full ExtensionRunner instance — we only
	// need _ops to be armed, the original call's side-effects are irrelevant.
	try {
		ExtensionRunner.prototype.bindCommandContext.call({} as never, {
			navigateTree,
			fork: () => {},
			newSession: () => {},
			switchSession: () => {},
			reload: () => {},
			waitForIdle: () => {},
		});
	} catch {
		// Original bindCommandContext may fail on the stub `this` — that's fine,
		// _ops is already set by the patched wrapper before the forward call.
	}
}

/** Schedule a pivot action. */
function schedulePivot(overrides: {
	targetId?: string;
	expectedInjection?: string;
	message?: string;
	label?: string;
	carryover?: string;
}): void {
	clearPending();
	scheduleAction({
		fallbackHint: "Use /tree instead",
		action: {
			kind: "pivot",
			targetId: overrides.targetId ?? "target-123",
			carryover: overrides.carryover ?? "",
			expectedInjection: overrides.expectedInjection,
			message: overrides.message,
			label: overrides.label,
		},
		successText: "Pivot scheduled",
	});
}

// ── Tests ────────────────────────────────────────────────────

beforeEach(() => {
	restoreBindCommandContext();
	clearCommandContext();
});
afterEach(() => {
	restoreBindCommandContext();
	clearCommandContext();
});

describe("bindCommandContext patch", () => {
	test("is idempotent, shared across reloads, and removable", async () => {
		const original = ExtensionRunner.prototype.bindCommandContext;
		expect(patchBindCommandContext()).toBe(true);
		const patched = ExtensionRunner.prototype.bindCommandContext;
		const hot = await import(`../src/auto-context/command-actions.ts?hot=${Date.now()}`);

		expect(hot.patchBindCommandContext()).toBe(true);
		expect(ExtensionRunner.prototype.bindCommandContext).toBe(patched);

		arm(async () => ({ cancelled: false }));
		expect(isArmed()).toBe(true);
		expect(hot.isArmed()).toBe(true);

		clearCommandContext();
		expect(isArmed()).toBe(false);
		expect(hot.isArmed()).toBe(false);

		expect(hot.restoreBindCommandContext()).toBe(true);
		expect(ExtensionRunner.prototype.bindCommandContext).toBe(original);
	});
});

describe("runPending — pivot logic", () => {

	test("clears editor when post-pivot text matches expectedInjection", async () => {
		let editorText = ""; // initially empty
		let setEditorCalledWith: string | undefined;

		arm(async () => {
			// Simulate navigateTree auto-filling the editor with the target text
			editorText = "injected-by-tree";
			return { cancelled: false };
		});

		schedulePivot({ expectedInjection: "injected-by-tree", message: "Go!" });

		const runtime: RuntimeContext = {
			sendFollowUp: () => {},
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				setEditorCalledWith = text;
				editorText = text;
			},
		};

		await runPending(undefined, runtime);

		// Editor was cleared back to the previous value ("")
		expect(setEditorCalledWith).toBe("");
	});

	test("does NOT clear editor when user typed during pivot", async () => {
		let editorText = "";
		let setEditorCalled = false;

		arm(async () => {
			// User typed during the async navigateTree call
			editorText = "user typed something else";
			return { cancelled: false };
		});

		schedulePivot({ expectedInjection: "injected-by-tree", message: "Go!" });

		const runtime: RuntimeContext = {
			sendFollowUp: () => {},
			getEditorText: () => editorText,
			setEditorText: () => { setEditorCalled = true; },
		};

		await runPending(undefined, runtime);

		// Editor was NOT cleared because the text differs from expectedInjection
		expect(setEditorCalled).toBe(false);
	});

	test("preserves pre-existing draft by restoring it after injection", async () => {
		let editorText = "my precious draft";
		let setEditorCalledWith: string | undefined;

		arm(async () => {
			// navigateTree overwrites the editor with its auto-fill
			editorText = "injected-by-tree";
			return { cancelled: false };
		});

		schedulePivot({ expectedInjection: "injected-by-tree", message: "Go!" });

		const prevText = editorText;
		const runtime: RuntimeContext = {
			sendFollowUp: () => {},
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				setEditorCalledWith = text;
				editorText = text;
			},
		};

		await runPending(undefined, runtime);

		// Draft is restored: setEditorText was called with the previous text
		expect(setEditorCalledWith).toBe(prevText);
		expect(editorText).toBe("my precious draft");
	});

	test("does not clear editor when prevEditor equals expectedInjection", async () => {
		// Edge case: editor already contained the injection text before pivot.
		// The guard `expectedInjection !== prevEditor` prevents clearing so we
		// don't wipe a legitimate user draft that happens to match.
		let editorText = "same-text";
		let setEditorCalled = false;

		arm(async () => {
			editorText = "same-text"; // stays the same
			return { cancelled: false };
		});

		schedulePivot({ expectedInjection: "same-text", message: "Go!" });

		const runtime: RuntimeContext = {
			sendFollowUp: () => {},
			getEditorText: () => editorText,
			setEditorText: () => { setEditorCalled = true; },
		};

		await runPending(undefined, runtime);

		expect(setEditorCalled).toBe(false);
	});

	test("delivers followUp and notification without editor accessors", async () => {
		let followUpMsg: string | undefined;

		arm(async () => ({ cancelled: false }));

		schedulePivot({ message: "Follow this up", label: "my-label" });

		const runtime: RuntimeContext = {
			sendFollowUp: (msg: string) => { followUpMsg = msg; },
			// No getEditorText / setEditorText
		};

		const notifications: Array<{ msg: string; level: string }> = [];
		const notify = (msg: string, level: "info" | "warning" | "error") => {
			notifications.push({ msg, level });
		};

		await runPending(notify, runtime);

		expect(followUpMsg).toBe("Follow this up");
		expect(notifications.length).toBe(1);
		expect(notifications[0]!.level).toBe("info");
		expect(notifications[0]!.msg).toContain("my-label");
	});

	test("notifies on cancelled pivot", async () => {
		arm(async () => ({ cancelled: true }));

		schedulePivot({ message: "Go!" });

		const runtime: RuntimeContext = {
			sendFollowUp: () => {},
		};

		const notifications: Array<{ msg: string; level: string }> = [];
		const notify = (msg: string, level: "info" | "warning" | "error") => {
			notifications.push({ msg, level });
		};

		await runPending(notify, runtime);

		expect(notifications.length).toBe(1);
		expect(notifications[0]!.level).toBe("warning");
		expect(notifications[0]!.msg).toContain("cancelled");
	});

	test("does nothing when module is not armed", async () => {
		// Don't call arm() — _ops stays null
		schedulePivot({ message: "Go!" });

		// scheduleAction will have returned an error content since module
		// isn't armed, so _pending is still null. runPending should be a no-op.
		let followUpCalled = false;
		const runtime: RuntimeContext = {
			sendFollowUp: () => { followUpCalled = true; },
		};

		await runPending(undefined, runtime);
		expect(followUpCalled).toBe(false);
	});

	test("does nothing when no pending action exists", async () => {
		arm(async () => ({ cancelled: false }));
		// Don't schedule anything

		let followUpCalled = false;
		const runtime: RuntimeContext = {
			sendFollowUp: () => { followUpCalled = true; },
		};

		await runPending(undefined, runtime);
		expect(followUpCalled).toBe(false);
	});
});
