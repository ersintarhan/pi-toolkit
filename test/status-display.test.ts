import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import statusDisplayExtension, {
	isStatusDisplayEnabled,
	setOptionalStatus,
	setStatusDisplayEnabled,
} from "../src/status-display";

beforeEach(() => setStatusDisplayEnabled(false));
afterEach(() => setStatusDisplayEnabled(false));

describe("optional status display", () => {
	test("hides status values until its package resource is enabled", () => {
		const statuses = new Map<string, string | undefined>();
		const ctx = { ui: { setStatus: (key: string, value: string | undefined) => statuses.set(key, value) } };

		setOptionalStatus(ctx, "auto-context", "ctx 42% · anchor:done");

		expect(statuses.get("auto-context")).toBeUndefined();
	});

	test("shares visibility across reloads and clears all values on shutdown", async () => {
		const statuses = new Map<string, string | undefined>();
		const ctx = { ui: { setStatus: (key: string, value: string | undefined) => statuses.set(key, value) } };
		const handlers: Record<string, (event: unknown, context: typeof ctx) => void> = {};
		statusDisplayExtension({
			on(event: string, handler: (event: unknown, context: typeof ctx) => void) {
				handlers[event] = handler;
			},
		} as never);
		const hot = await import(`../src/status-display.ts?hot=${Date.now()}`);

		setOptionalStatus(ctx, "auto-context", "ctx 42% · anchor:done");
		for (const key of ["search", "claude-oauth-ready", "claude-oauth-issue"]) {
			setOptionalStatus(ctx, key, key);
		}
		expect(isStatusDisplayEnabled()).toBe(true);
		expect(hot.isStatusDisplayEnabled()).toBe(true);
		expect(statuses.get("auto-context")).toBe("ctx 42% · anchor:done");

		handlers.session_shutdown?.({}, ctx);
		expect(isStatusDisplayEnabled()).toBe(false);
		expect(hot.isStatusDisplayEnabled()).toBe(false);
		expect([...statuses.values()].every((value) => value === undefined)).toBe(true);
	});
});
