import { test, expect, describe } from "bun:test";
import { getEditorInjectionFor, anchorNameOf } from "../src/auto-context/context/anchors";

// ── getEditorInjectionFor ────────────────────────────────────

describe("getEditorInjectionFor", () => {
	test("extracts text from a user message entry with string content", () => {
		const sm = {
			getEntry(id: string): unknown {
				if (id === "u1") {
					return {
						type: "message",
						message: { role: "user", content: "Hello world" },
					};
				}
				return null;
			},
		};
		expect(getEditorInjectionFor(sm, "u1")).toBe("Hello world");
	});

	test("extracts text from a user message entry with array content", () => {
		const sm = {
			getEntry(id: string): unknown {
				if (id === "u2") {
					return {
						type: "message",
						message: {
							role: "user",
							content: [
								{ type: "text", text: "Part one " },
								{ type: "text", text: "Part two" },
							],
						},
					};
				}
				return null;
			},
		};
		expect(getEditorInjectionFor(sm, "u2")).toBe("Part one Part two");
	});

	test("extracts text from a custom_message entry", () => {
		const sm = {
			getEntry(id: string): unknown {
				if (id === "cm1") {
					return {
						type: "custom_message",
						content: "Custom text here",
					};
				}
				return null;
			},
		};
		expect(getEditorInjectionFor(sm, "cm1")).toBe("Custom text here");
	});

	test("extracts text from a custom_message entry with array content", () => {
		const sm = {
			getEntry(id: string): unknown {
				if (id === "cm2") {
					return {
						type: "custom_message",
						content: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
					};
				}
				return null;
			},
		};
		expect(getEditorInjectionFor(sm, "cm2")).toBe("AB");
	});

	test("returns empty string for an anchor toolResult entry", () => {
		const sm = {
			getEntry(id: string): unknown {
				if (id === "ar1") {
					return {
						type: "message",
						message: {
							role: "toolResult",
							toolName: "context",
							details: { anchor: { name: "my-anchor", targetId: "t1", summary: "..." } },
						},
					};
				}
				return null;
			},
		};
		expect(getEditorInjectionFor(sm, "ar1")).toBe("");
	});

	test("returns empty string for missing entry", () => {
		const sm = { getEntry: (_id: string): unknown => null };
		expect(getEditorInjectionFor(sm, "nonexistent")).toBe("");
	});

	test("returns empty string for assistant message", () => {
		const sm = {
			getEntry(_id: string): unknown {
				return {
					type: "message",
					message: { role: "assistant", content: "I am a bot" },
				};
			},
		};
		expect(getEditorInjectionFor(sm, "any")).toBe("");
	});

	test("skips non-text blocks in array content", () => {
		const sm = {
			getEntry(_id: string): unknown {
				return {
					type: "message",
					message: {
						role: "user",
						content: [
							{ type: "image", url: "http://example.com/img.png" },
							{ type: "text", text: "hello" },
						],
					},
				};
			},
		};
		expect(getEditorInjectionFor(sm, "any")).toBe("hello");
	});
});

// ── anchorNameOf ─────────────────────────────────────────────

describe("anchorNameOf", () => {
	test("returns anchor name from a well-formed anchor entry", () => {
		const entry = {
			type: "message",
			message: {
				role: "toolResult",
				toolName: "context",
				details: {
					anchor: { name: "my-anchor", targetId: "t1", summary: "some summary" },
				},
			},
		};
		expect(anchorNameOf(entry)).toBe("my-anchor");
	});

	test("returns undefined for non-anchor entry (user message)", () => {
		const entry = {
			type: "message",
			message: { role: "user", content: "Hello" },
		};
		expect(anchorNameOf(entry)).toBeUndefined();
	});

	test("returns undefined for entry with no details", () => {
		const entry = {
			type: "message",
			message: { role: "toolResult", toolName: "context" },
		};
		expect(anchorNameOf(entry)).toBeUndefined();
	});

	test("returns undefined for entry with details but no anchor", () => {
		const entry = {
			type: "message",
			message: {
				role: "toolResult",
				toolName: "context",
				details: { somethingElse: true },
			},
		};
		expect(anchorNameOf(entry)).toBeUndefined();
	});

	test("returns undefined for entry with anchor but non-string name", () => {
		const entry = {
			type: "message",
			message: {
				role: "toolResult",
				toolName: "context",
				details: { anchor: { name: 42 } },
			},
		};
		expect(anchorNameOf(entry)).toBeUndefined();
	});

	test("returns undefined for null input", () => {
		expect(anchorNameOf(null)).toBeUndefined();
	});

	test("returns undefined for undefined input", () => {
		expect(anchorNameOf(undefined)).toBeUndefined();
	});

	test("returns undefined for primitive input", () => {
		expect(anchorNameOf("string")).toBeUndefined();
		expect(anchorNameOf(42)).toBeUndefined();
	});
});
