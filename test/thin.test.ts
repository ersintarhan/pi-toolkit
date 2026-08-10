import { describe, expect, test } from "bun:test";
import { thinBeforeLastAnchor } from "../src/auto-context/context/thin";

const anchor = (name = "phase-done") => ({
	role: "toolResult",
	toolName: "context",
	details: { anchor: { name, summary: "done" } },
	content: "anchored",
});
const think = (text = "x".repeat(4000)) => ({ type: "thinking", thinking: text, thinkingSignature: "sig-abc" });
const text = (t = "on it") => ({ type: "text", text: t });
const call = (name = "read") => ({ type: "toolCall", name, id: "tc-1" });
const assistant = (...content: any[]) => ({ role: "assistant", content });
const result = (t = "y".repeat(4000)) => ({ role: "toolResult", toolName: "read", content: t });
const user = (t = "go") => ({ role: "user", content: t });

describe("thinBeforeLastAnchor", () => {
	test("drops thinking and truncates tool results ahead of the anchor", () => {
		const messages: any[] = [
			user(),
			assistant(think(), text(), call()),
			result(),
			anchor(),
			assistant(think(), text()),
		];

		expect(thinBeforeLastAnchor(messages)).toBe(true);

		expect(messages[1].content.map((b: any) => b.type)).toEqual(["text", "toolCall"]);
		expect(messages[2].content).toMatch(/^y{20}…✂4000$/);
	});

	// Anthropic requires a thinking block on the final assistant message, ahead of
	// the lastmost tool_use/tool_result pair. Anything at or after the anchor is
	// part of that live loop.
	test("leaves everything at or after the anchor untouched", () => {
		const live = assistant(think("live reasoning"), call());
		const messages: any[] = [user(), assistant(think()), anchor(), live, result()];

		thinBeforeLastAnchor(messages);

		expect(live.content.map((b: any) => b.type)).toEqual(["thinking", "toolCall"]);
		expect(live.content[0].thinking).toBe("live reasoning");
		expect(messages[4].content).toHaveLength(4000);
	});

	// The signature authenticates the block, so a rewritten thinking block is
	// rejected by the API. Removal is the only safe edit.
	test("removes thinking blocks whole rather than rewriting them", () => {
		const messages: any[] = [user(), assistant(think(), text()), anchor()];

		thinBeforeLastAnchor(messages);

		const survivors = messages[1].content;
		expect(survivors.some((b: any) => b.type === "thinking")).toBe(false);
		expect(survivors.some((b: any) => "thinkingSignature" in b)).toBe(false);
		expect(JSON.stringify(survivors)).not.toContain("✂");
	});

	// A content-less assistant turn is invalid, so a thinking-only message stays.
	test("keeps a thinking-only assistant message intact", () => {
		const lonely = assistant(think());
		const messages: any[] = [user(), lonely, anchor()];

		thinBeforeLastAnchor(messages);

		expect(lonely.content.map((b: any) => b.type)).toEqual(["thinking"]);
	});

	test("preserves the anchor's own tool result", () => {
		const a = anchor("keep-me");
		const messages: any[] = [user(), assistant(think()), a, user(), assistant(think()), anchor("later")];

		thinBeforeLastAnchor(messages);

		expect(a.content).toBe("anchored");
		expect(a.details.anchor.name).toBe("keep-me");
	});

	test("reports no change when there is nothing to thin", () => {
		expect(thinBeforeLastAnchor([])).toBe(false);
		expect(thinBeforeLastAnchor([user(), assistant(think())])).toBe(false); // no anchor
		expect(thinBeforeLastAnchor([anchor(), assistant(think())])).toBe(false); // anchor first
		expect(thinBeforeLastAnchor([user(), assistant(text()), anchor()])).toBe(false); // nothing to drop
	});

	test("handles array-shaped tool result content", () => {
		const arrayResult = { role: "toolResult", toolName: "read", content: [{ type: "text", text: "z".repeat(900) }] };
		const messages: any[] = [user(), arrayResult, anchor()];

		expect(thinBeforeLastAnchor(messages)).toBe(true);
		expect(arrayResult.content[0].text).toMatch(/^z{20}…✂900$/);
	});
});
