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
	delete process.env.PI_CODING_AGENT_DIR;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Create an agent dir, point Pi at it, and return its sessions/ path. */
function agentSessionsDir(): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-recall-"));
	tempDirs.push(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const sessionsDir = join(agentDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	return sessionsDir;
}

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
	const cwd = "/work/project";

	test("returns this cwd's anchors newest-first and invalidates cache on append", async () => {
		const sessionsDir = agentSessionsDir();
		const sessionDir = join(sessionsDir, "--work-project--");
		mkdirSync(join(sessionDir, "nested"), { recursive: true });
		const first = join(sessionDir, "first.jsonl");

		writeFileSync(first,
			entry({ type: "session", id: "session-1", cwd }) +
			entry({ type: "message", message: { role: "user", content: "x".repeat(1024 * 1024) } }) +
			anchor("anchor-old", "deploy-start", "Needle in summary", "2025-01-01T00:00:00Z"),
		);
		writeFileSync(join(sessionDir, "second.jsonl"),
			entry({ type: "session", id: "session-2", cwd }) +
			anchor("anchor-new", "needle-finish", "Done", "2025-02-01T00:00:00Z"),
		);
		// Session directories are scanned one level deep, matching how Pi lays them out.
		writeFileSync(join(sessionDir, "nested", "nested.jsonl"),
			entry({ type: "session", id: "nested", cwd }) + anchor("nested", "needle-nested", "nested", "2026-01-01T00:00:00Z"),
		);

		const initial = await scanAnchors("needle", "cwd", cwd);
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
		const updated = await scanAnchors("needle", "cwd", cwd);
		expect(updated.map(result => result.anchorId)).toEqual(["anchor-appended", "anchor-new", "anchor-old"]);
	});

	test("excludes sessions recorded against a different cwd", async () => {
		const sessionsDir = agentSessionsDir();
		const mine = join(sessionsDir, "--work-project--");
		const theirs = join(sessionsDir, "--work-other--");
		mkdirSync(mine, { recursive: true });
		mkdirSync(theirs, { recursive: true });
		writeFileSync(join(mine, "a.jsonl"),
			entry({ type: "session", id: "mine", cwd }) + anchor("a", "needle-mine", "mine", "2026-01-01T00:00:00Z"));
		writeFileSync(join(theirs, "b.jsonl"),
			entry({ type: "session", id: "theirs", cwd: "/work/other" }) + anchor("b", "needle-theirs", "theirs", "2026-01-01T00:00:00Z"));

		const scoped = await scanAnchors("needle", "cwd", cwd);
		expect(scoped.map(result => result.anchorName)).toEqual(["needle-mine"]);

		const everything = await scanAnchors("needle", "all", cwd);
		expect(everything.map(result => result.anchorName).sort()).toEqual(["needle-mine", "needle-theirs"]);
	});

	// Pi encodes the cwd into the session directory name and that encoding has
	// changed between releases, so one cwd can own several directories. Narrowing
	// the scan to the active directory silently hides the older ones.
	test("finds this cwd's sessions under a differently-encoded directory", async () => {
		const sessionsDir = agentSessionsDir();
		const current = join(sessionsDir, "--work-project--");
		const legacy = join(sessionsDir, "~-work-project");
		mkdirSync(current, { recursive: true });
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(current, "a.jsonl"),
			entry({ type: "session", id: "current", cwd }) + anchor("a", "needle-current", "current", "2026-01-01T00:00:00Z"));
		writeFileSync(join(legacy, "b.jsonl"),
			entry({ type: "session", id: "legacy", cwd }) + anchor("b", "needle-legacy", "legacy", "2025-01-01T00:00:00Z"));

		const found = await scanAnchors("needle", "cwd", cwd);

		expect(found.map(result => result.anchorName)).toEqual(["needle-current", "needle-legacy"]);
	});

	// A header too large for the bounded probe reports an unknown cwd, which must
	// fall through to the full parse rather than dropping the session.
	test("finds sessions whose header exceeds the bounded probe", async () => {
		const sessionsDir = agentSessionsDir();
		const dir = join(sessionsDir, "--work-project--");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "a.jsonl"),
			entry({ type: "session", id: "padded", cwd, pad: "x".repeat(8192) }) +
			anchor("a", "needle-padded", "padded", "2026-01-01T00:00:00Z"));

		const found = await scanAnchors("needle", "cwd", cwd);

		expect(found.map(result => result.anchorName)).toEqual(["needle-padded"]);
	});

	test("throws AbortError for a pre-aborted scan", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(scanAnchors("anything", "cwd", "/work", 10, 0, controller.signal))
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
