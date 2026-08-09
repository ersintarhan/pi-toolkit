import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { clearCommandContext, patchBindCommandContext } from "../src/auto-context/command-actions";
import { registerContextRouter } from "../src/auto-context/context/router";
import { scanAnchors } from "../src/auto-context/utils";

const tempDirs: string[] = [];
afterEach(() => {
	clearCommandContext();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function entry(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function anchor(id: string, name: string, summary: string, timestamp: string): string {
	return entry({
		type: "message",
		id,
		timestamp,
		message: {
			role: "toolResult",
			toolName: "context",
			details: { anchor: { name, summary } },
		},
	});
}

describe("scanAnchors", () => {
	test("scans only the supplied cwd session directory and invalidates cache on append", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-recall-"));
		tempDirs.push(root);
		const sessionDir = join(root, "active");
		const siblingDir = join(root, "other");
		mkdirSync(sessionDir);
		mkdirSync(siblingDir);
		mkdirSync(join(sessionDir, "nested"));
		const cwd = "/work/project";
		const first = join(sessionDir, "first.jsonl");
		const second = join(sessionDir, "second.jsonl");

		writeFileSync(first,
			entry({ type: "session", id: "session-1", cwd }) +
			entry({ type: "message", message: { role: "user", content: "x".repeat(1024 * 1024) } }) +
			anchor("anchor-old", "deploy-start", "Needle in summary", "2025-01-01T00:00:00Z"),
		);
		writeFileSync(second,
			entry({ type: "session", id: "session-2", cwd }) +
			anchor("anchor-new", "needle-finish", "Done", "2025-02-01T00:00:00Z"),
		);
		writeFileSync(join(siblingDir, "outside.jsonl"),
			entry({ type: "session", id: "outside", cwd }) + anchor("outside", "needle-outside", "outside", "2026-01-01T00:00:00Z"),
		);
		writeFileSync(join(sessionDir, "nested", "nested.jsonl"),
			entry({ type: "session", id: "nested", cwd }) + anchor("nested", "needle-nested", "nested", "2026-01-01T00:00:00Z"),
		);

		const initial = await scanAnchors("needle", "cwd", cwd, 10, 0, undefined, sessionDir);
		expect(initial.map(result => result.anchorId)).toEqual(["anchor-new", "anchor-old"]);
		expect(initial[0]).toMatchObject({
			sessionId: "session-2",
			sessionCwd: cwd,
			anchorName: "needle-finish",
			summary: "Done",
		});

		appendFileSync(first, anchor("anchor-appended", "needle-latest", "Appended", "2025-03-01T00:00:00Z"));
		const future = new Date(Date.now() + 2_000);
		utimesSync(first, future, future);
		const updated = await scanAnchors("needle", "cwd", cwd, 10, 0, undefined, sessionDir);
		expect(updated.map(result => result.anchorId)).toEqual(["anchor-appended", "anchor-new", "anchor-old"]);
	});

	test("throws AbortError for a pre-aborted scan", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(scanAnchors("anything", "cwd", "/work", 10, 0, controller.signal, tmpdir()))
			.rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("pivot model instructions", () => {
	test("tell the model to stop the current turn after scheduling", async () => {
		let tool: any;
		registerContextRouter({ registerTool(value: unknown) { tool = value; } } as never);
		expect(tool.promptGuidelines.join(" ")).toContain("call no more tools and end the current turn immediately");

		patchBindCommandContext();
		try {
			ExtensionRunner.prototype.bindCommandContext.call({} as never, {
				navigateTree: async () => ({ cancelled: false }),
				fork: () => {}, newSession: () => {}, switchSession: () => {}, reload: () => {}, waitForIdle: () => {},
			});
		} catch { /* command ops are captured before the stub runner fails */ }

		const sessionManager = {
			getEntries: () => [{ id: "target-entry" }],
			getLabel: (id: string) => id === "target-entry" ? "checkpoint" : undefined,
			getLeafId: () => "current-leaf",
			getEntry: () => null,
		};
		const result = await tool.execute("call", {
			action: "pivot",
			target: "checkpoint",
			carryover: "Keep this",
		}, new AbortController().signal, () => {}, { sessionManager });
		expect(result.content[0].text).toContain("Call no more tools; end the current turn immediately.");
	});
});
