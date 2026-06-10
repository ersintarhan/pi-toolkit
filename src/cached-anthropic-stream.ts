/**
 * Cached Anthropic stream — port of @mcowger/pi-better-messages-cache for
 * use inside the Kimi Code provider.
 *
 * The exported `streamSimpleAnthropicCached` is a drop-in replacement for
 * pi-ai's `streamSimpleAnthropic` that:
 *
 *   1. Marks the last assistant `tool_use` block with `cache_control` in
 *      addition to the last user block (dual cache breakpoint strategy).
 *   2. Parses streaming SSE events with `parseJsonWithRepair`, which escapes
 *      raw control characters (\t, \n) inside tool-call JSON arguments so the
 *      Anthropic SDK's `JSON.parse` no longer crashes mid-stream and leaves
 *      tool args as `{}`.
 *   3. Enforces Anthropic's 4-block `cache_control` limit per request,
 *      removing the oldest message-level markers first while keeping system
 *      markers intact.
 *
 * Source: https://github.com/mcowger/pi-better-messages-cache (MIT)
 * Original PR proposal: https://github.com/badlogic/pi-mono/pull/1737
 */

import Anthropic from "@anthropic-ai/sdk";
type ContentBlockParam = any;
type MessageCreateParamsStreaming = any;

import {
	calculateCost,
	createAssistantMessageEventStream,
	parseJsonWithRepair,
	parseStreamingJson,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// SSE parsing — mirrors the built-in pi-ai Anthropic provider so that
// parseJsonWithRepair is used instead of the SDK's bare JSON.parse.
// ---------------------------------------------------------------------------

interface SseEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_STREAM_EVENTS = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
	"ping",
]);

/**
 * Iterate chunks from either a Web `ReadableStream<Uint8Array>` (browser /
 * undici fetch) or a Node.js `Readable` (e.g. `PassThrough`). Anthropic SDK
 * 0.32.0 on Node 26 returns a Node `PassThrough` for at least some hosts
 * (observed with Xiaomi MiMo's MiFE proxy, which uses chunked transfer-
 * encoding) instead of a Web stream, so we have to accept both.
 */
async function* iterateBodyChunks(
	body: any,
	signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
	if (body && typeof body.getReader === "function") {
		const reader = body.getReader();
		try {
			while (true) {
				if (signal?.aborted) return;
				const { done, value } = await reader.read();
				if (done) return;
				if (value) yield value as Uint8Array;
			}
		} finally {
			try {
				reader.releaseLock();
			} catch {}
		}
		return;
	}
	// Node Readable: async-iterable since Node 10. Yields Buffer or string.
	if (body && typeof body[Symbol.asyncIterator] === "function") {
		for await (const chunk of body as AsyncIterable<Buffer | string>) {
			if (signal?.aborted) return;
			if (typeof chunk === "string") {
				yield new TextEncoder().encode(chunk);
			} else {
				yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
			}
		}
		return;
	}
	throw new Error(
		`Unsupported response body type: ${body?.constructor?.name ?? typeof body}`,
	);
}

export async function* iterateSseMessages(
	body: ReadableStream<Uint8Array> | any,
	signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	let state: SseDecoderState = { event: null, data: [], raw: [] };

	function flush(): SseEvent | null {
		if (state.data.length === 0) return null;
		return { event: state.event, data: state.data.join("\n"), raw: state.raw };
	}

	for await (const value of iterateBodyChunks(body, signal)) {
		if (signal?.aborted) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			state.raw.push(line);
			if (line === "") {
				const ev = flush();
				if (ev) yield ev;
				state = { event: null, data: [], raw: [] };
			} else if (line.startsWith("event:")) {
				state.event = line.slice(6).trim();
			} else if (line.startsWith("data:")) {
				state.data.push(line.slice(5).trim());
			}
		}
	}
	const trailing = flush();
	if (trailing) yield trailing;
}

export async function* iterateAnthropicSseEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<any> {
	if (!response.ok) {
		// On HTTP error, the body is a JSON error payload, not an SSE stream.
		// Read it as text so we get a useful error message instead of
		// "body.getReader is not a function" when the body is a Node-style
		// Readable rather than a Web ReadableStream.
		let detail = "";
		try {
			detail = await (response as any).text?.();
		} catch {}
		throw new Error(
			`HTTP ${response.status} ${response.statusText || ""}${detail ? `: ${detail}` : ""}`,
		);
	}
	if (!response.body) throw new Error("Anthropic response has no body");
	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") throw new Error(sse.data);
		if (!ANTHROPIC_STREAM_EVENTS.has(sse.event ?? "")) continue;
		try {
			yield parseJsonWithRepair(sse.data);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not parse Anthropic SSE event "${sse.event}": ${msg}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLAUDE_CODE_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];
const ccToolLookup = new Map(CLAUDE_CODE_TOOLS.map((t) => [t.toLowerCase(), t]));

function toClaudeCodeName(name: string): string {
	return ccToolLookup.get(name.toLowerCase()) ?? name;
}

function fromClaudeCodeName(name: string, tools?: Tool[]): string {
	const lower = name.toLowerCase();
	return tools?.find((t) => t.name.toLowerCase() === lower)?.name ?? name;
}

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDFFF]/g, "�");
}

function convertContentBlocks(
	content: (TextContent | ImageContent)[],
): string | Array<{ type: "text"; text: string } | { type: "image"; source: unknown }> {
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return { type: "text" as const, text: sanitizeSurrogates(block.text) };
		}
		const img = block as ImageContent;
		return {
			type: "image" as const,
			source: { type: "base64" as const, media_type: img.mimeType, data: img.data },
		};
	});
	if (!blocks.some((b) => b.type === "text")) {
		blocks.unshift({ type: "text" as const, text: "(see attached image)" });
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// convertMessages — dual cache-breakpoint strategy
// ---------------------------------------------------------------------------

type CacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

function resolveCacheTTL(): "5m" | "1h" {
	const env = process.env.PI_ANCHOR_CACHE_TTL ?? process.env.PI_CACHE_TTL;
	if (env === "1h") return "1h";
	return "5m";
}

export function convertMessages(
	messages: Message[],
	isOAuth: boolean,
	cacheControl: CacheControl,
	tools?: Tool[],
	options?: { keepThinkingWithoutSignature?: boolean; currentProvider?: string },
): any[] {
	const params: any[] = [];

	// Work on a local expanded copy so synthetic tool results do not mutate the
	// caller's message array and index math stays deterministic while iterating.
	const normalizedMessages: Message[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]!;
		normalizedMessages.push(msg);

		// Inject synthetic tool_results for orphaned tool_use blocks so the API
		// never sees an unmatched tool_use (aborted turn, steering injection, etc.).
		if (msg.role === "assistant") {
			const toolCalls = (msg.content as any[]).filter((b) => b.type === "toolCall");
			if (toolCalls.length > 0) {
				const next = messages[i + 1];
				const nextIsToolResults =
					next?.role === "toolResult" ||
					(next?.role === "user" && Array.isArray(next.content) &&
						(next.content as any[]).every((b) => b.type === "tool_result"));
				if (!nextIsToolResults) {
					const synthetics: Message[] = toolCalls.map((tc) => ({
						role: "toolResult" as const,
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result: tool call was interrupted" }],
						isError: true,
						timestamp: Date.now(),
					}));
					normalizedMessages.push(...synthetics);
				}
			}
		}
	}

	for (let i = 0; i < normalizedMessages.length; i++) {
		const msg = normalizedMessages[i]!;
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
				}
			} else {
				const blocks: ContentBlockParam[] = (msg.content as any[]).flatMap((item) => {
					if ((item as any).type === "tool_result") return [item];
					if (item.type === "text") {
						const text = sanitizeSurrogates(item.text);
						return text.trim().length > 0 ? [{ type: "text" as const, text }] : [];
					}
					const img = item as ImageContent;
					return [{ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType as any, data: img.data } }];
				});
				if (blocks.length > 0) {
					params.push({ role: "user", content: blocks });
				}
			}

		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			const content = msg.content as any[];
			// Dual-cache change (1 of 2): last toolCall gets cache_control
			const lastToolCallIndex = content.map((b) => b.type).lastIndexOf("toolCall");

			for (const [idx, block] of content.entries()) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });

				} else if (block.type === "thinking") {
					const messageProvider = (msg as any).provider as string | undefined;
					const isForeignProvider =
						options?.currentProvider &&
						messageProvider &&
						messageProvider !== options.currentProvider;

					// Anthropic API validates signatures on thinking blocks. Foreign
					// signatures (e.g. from Kimi, MiMo) are always rejected with 400
					// on provider switches (e.g. Kimi -> Anthropic). Convert to plain
					// text to preserve the reasoning content.
					if (isForeignProvider && options?.currentProvider === "anthropic") {
						if (block.redacted || block.thinking.trim().length === 0) continue;
						blocks.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
						continue;
					}

					if (options?.keepThinkingWithoutSignature) {
						// Kimi, MiMo, and similar Anthropic-compatible providers can reuse
						// prior thinking text but reject foreign Anthropic signatures on
						// provider switches (e.g. Opus -> Kimi). Preserve plain thinking,
						// drop provider-bound signatures/redacted blocks, and emit
						// `reasoning_content` for validators that expect DeepSeek-style
						// carry-forward fields.
						if (block.redacted || block.thinking.trim().length === 0) continue;
						const sanitized = sanitizeSurrogates(block.thinking);
						blocks.push({
							type: "thinking" as any,
							thinking: sanitized,
							reasoning_content: sanitized,
						} as any);
						continue;
					}
					if (block.redacted) {
						blocks.push({ type: "redacted_thinking" as any, data: block.thinkingSignature });
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						blocks.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
					} else {
						blocks.push({
							type: "thinking" as any,
							thinking: sanitizeSurrogates(block.thinking),
							signature: block.thinkingSignature,
						});
					}

				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuth ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
						...(idx === lastToolCallIndex ? { cache_control: cacheControl } : {}),
					});
				}
			}

			if (blocks.length > 0) {
				const assistantMsg: any = { role: "assistant", content: blocks };
				// MiMo: emit top-level reasoning_content (DeepSeek-style) in addition
				// to the per-block field, since some validators check only one or the
				// other. Harmless on native Anthropic (the field is ignored).
				if (options?.keepThinkingWithoutSignature) {
					const thinkingTexts = blocks
						.filter((b: any) => b.type === "thinking" && typeof b.thinking === "string")
						.map((b: any) => b.thinking)
						.join("\n");
					if (thinkingTexts.length > 0) {
						assistantMsg.reasoning_content = thinkingTexts;
					}
				}
				params.push(assistantMsg);
			}

		} else if (msg.role === "toolResult") {
			const toolResults: any[] = [];

			toolResults.push({
				type: "tool_result",
				tool_use_id: (msg as ToolResultMessage).toolCallId,
				content: convertContentBlocks((msg as ToolResultMessage).content),
				is_error: (msg as ToolResultMessage).isError,
			});

			let j = i + 1;
			while (j < normalizedMessages.length && normalizedMessages[j]!.role === "toolResult") {
				const next = normalizedMessages[j] as ToolResultMessage;
				toolResults.push({
					type: "tool_result",
					tool_use_id: next.toolCallId,
					content: convertContentBlocks(next.content),
					is_error: next.isError,
				});
				j++;
			}

			i = j - 1;
			params.push({ role: "user", content: toolResults });
		}
	}

	// Dual-cache change (2 of 2): mark the last block of the last user message
	if (params.length > 0) {
		const last = params[params.length - 1];
		if (last.role === "user") {
			if (Array.isArray(last.content)) {
				const lastBlock = last.content[last.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" ||
						lastBlock.type === "image" ||
						lastBlock.type === "tool_result")
				) {
					lastBlock.cache_control = cacheControl;
				}
			} else if (typeof last.content === "string") {
				last.content = [
					{ type: "text", text: last.content, cache_control: cacheControl },
				];
			}
		}
	}

	// Merge consecutive user-role params (handles steering, synthetic results, etc.)
	const merged: any[] = [];
	for (const param of params) {
		const prev = merged[merged.length - 1];
		if (prev && prev.role === "user" && param.role === "user") {
			const prevBlocks: any[] = Array.isArray(prev.content)
				? prev.content
				: [{ type: "text", text: prev.content }];
			const nextBlocks: any[] = Array.isArray(param.content)
				? param.content
				: [{ type: "text", text: param.content }];
			prev.content = [...prevBlocks, ...nextBlocks];
		} else {
			merged.push(param);
		}
	}

	return merged;
}

function convertTools(tools: Tool[], isOAuth: boolean): any[] {
	return tools.map((tool) => ({
		name: isOAuth ? toClaudeCodeName(tool.name) : tool.name,
		description: tool.description,
		input_schema: {
			type: "object",
			properties: (tool.parameters as any).properties ?? {},
			required: (tool.parameters as any).required ?? [],
		},
	}));
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
		case "pause_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "error";
	}
}

/**
 * Anthropic allows at most 4 cache_control blocks per request. Preserve the
 * newest message-level breakpoints and trim older ones first; keep system
 * markers intact.
 */
function enforceCacheControlLimit(
	params: Pick<MessageCreateParamsStreaming, "messages" | "system">,
	maxBreakpoints = 4,
): void {
	const systemBlocks = Array.isArray(params.system) ? params.system : [];
	const systemMarkerCount = systemBlocks.reduce(
		(count, block: any) => count + (block?.cache_control ? 1 : 0),
		0,
	);

	const messageMarkers: any[] = [];
	for (const message of params.messages ?? []) {
		if (!Array.isArray((message as any).content)) continue;
		for (const block of (message as any).content) {
			if (block?.cache_control) {
				messageMarkers.push(block);
			}
		}
	}

	const totalMarkers = systemMarkerCount + messageMarkers.length;
	if (totalMarkers <= maxBreakpoints) return;

	const markersToRemove = totalMarkers - maxBreakpoints;
	for (const block of messageMarkers.slice(0, markersToRemove)) {
		delete block.cache_control;
	}
}

// ---------------------------------------------------------------------------
// Streaming implementation
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for pi-ai's `streamSimpleAnthropic` that applies the
 * dual cache-breakpoint strategy and parses SSE events with
 * `parseJsonWithRepair`.
 *
 * Compatibility:
 *   - Honors `options.onPayload` (called with the final, marker-stamped params).
 *     Return value is ignored to match pi-ai's behaviour. Callers that mutate
 *     the payload in place (e.g. pi-provider-kimi-code's image upload pipeline)
 *     continue to work.
 *   - Honors `options.signal`, `options.maxTokens`, `options.reasoning`, and
 *     `options.thinkingBudgets`.
 */
export function streamSimpleAnthropicCached(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey ?? "";
			const isOAuth = isOAuthToken(apiKey);
			const cacheControl: CacheControl = { type: "ephemeral", ttl: resolveCacheTTL() };

			const betaFeatures = [
				"fine-grained-tool-streaming-2025-05-14",
				"interleaved-thinking-2025-05-14",
			];

			const clientOptions: any = {
				baseURL: model.baseUrl,
				dangerouslyAllowBrowser: true,
			};

			if (isOAuth) {
				clientOptions.apiKey = null;
				clientOptions.authToken = apiKey;
				const oauthBetaFeatures = [
					"claude-code-20250219",
					"oauth-2025-04-20",
					...betaFeatures,
				];
				if (resolveCacheTTL() === "1h") {
					oauthBetaFeatures.push("prompt-caching-2024-07-31");
				}
				clientOptions.defaultHeaders = {
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": oauthBetaFeatures.join(","),
					"user-agent": "claude-cli/2.1.2 (external, cli)",
					"x-app": "cli",
					...(model.headers ?? {}),
				};
			} else {
				clientOptions.apiKey = apiKey;
				const apiBetaFeatures = [...betaFeatures];
				if (resolveCacheTTL() === "1h") {
					apiBetaFeatures.push("prompt-caching-2024-07-31");
				}
				clientOptions.defaultHeaders = {
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": apiBetaFeatures.join(","),
					...(model.headers ?? {}),
				};
			}

			const client = new Anthropic(clientOptions);

			const keepThinkingWithoutSignature =
				model.provider === "xiaomi-mimo" || model.provider === "kimi-coding";

			const params = {
				model: model.id,
				messages: convertMessages(context.messages, isOAuth, cacheControl, context.tools, {
					keepThinkingWithoutSignature,
					currentProvider: model.provider,
				}),
				max_tokens: options?.maxTokens ?? Math.floor(model.maxTokens / 3),
				stream: true,
			} as MessageCreateParamsStreaming & Record<string, any>;

			if (isOAuth) {
				params.system = [
					{
						type: "text",
						text: "You are Claude Code, Anthropic's official CLI for Claude.",
						cache_control: cacheControl,
					},
				];
				if (context.systemPrompt) {
					params.system.push({
						type: "text",
						text: sanitizeSurrogates(context.systemPrompt),
						cache_control: cacheControl,
					});
				}
			} else if (context.systemPrompt) {
				params.system = [
					{
						type: "text",
						text: sanitizeSurrogates(context.systemPrompt),
						cache_control: cacheControl,
					},
				];
			}

			if (context.tools && context.tools.length > 0) {
				params.tools = convertTools(context.tools, isOAuth);
			}

			enforceCacheControlLimit(params);

			if (options?.reasoning && model.reasoning) {
				const defaultBudgets: Record<string, number> = {
					minimal: 1024,
					low: 4096,
					medium: 10240,
					high: 20480,
					xhigh: 32000,
				};
				const budget =
					options.thinkingBudgets?.[options.reasoning as keyof typeof options.thinkingBudgets] ??
					defaultBudgets[options.reasoning] ??
					10240;
				(params as any).thinking = { type: "enabled", budget_tokens: budget };
			}

			// Fire onPayload AFTER cache markers + thinking are applied so callers
			// (e.g. Kimi's applyKimiPayloadMutations) see the final payload and can
			// mutate it in place (image upload, prompt_cache_key injection, etc.).
			// Return value is intentionally ignored to match pi-ai's behaviour.
			await options?.onPayload?.(params as any, model as any);

			// Raw HTTP + custom SSE parser instead of SDK stream().
			const httpResponse = await (client.messages.create as any)(
				params,
				{ signal: options?.signal },
			).asResponse();

			stream.push({ type: "start", partial: output });

			type BlockWithIndex = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & {
				index: number;
			};
			const blocks = output.content as BlockWithIndex[];

			for await (const event of iterateAnthropicSseEvents(httpResponse, options?.signal)) {
				if (event.type === "message_start") {
					output.usage.input = event.message.usage.input_tokens ?? 0;
					output.usage.output = event.message.usage.output_tokens ?? 0;
					output.usage.cacheRead = (event.message.usage as any).cache_read_input_tokens ?? 0;
					output.usage.cacheWrite =
						(event.message.usage as any).cache_creation_input_tokens ?? 0;
					output.usage.totalTokens =
						output.usage.input +
						output.usage.output +
						output.usage.cacheRead +
						output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						output.content.push({ type: "text", text: "", index: event.index } as any);
						stream.push({
							type: "text_start",
							contentIndex: output.content.length - 1,
							partial: output,
						});
					} else if (event.content_block.type === "thinking") {
						output.content.push({
							type: "thinking",
							thinking: "",
							thinkingSignature: "",
							index: event.index,
						} as any);
						stream.push({
							type: "thinking_start",
							contentIndex: output.content.length - 1,
							partial: output,
						});
					} else if (event.content_block.type === "tool_use") {
						output.content.push({
							type: "toolCall",
							id: event.content_block.id,
							name: isOAuth
								? fromClaudeCodeName(event.content_block.name, context.tools)
								: event.content_block.name,
							arguments: {},
							partialJson: "",
							index: event.index,
						} as any);
						stream.push({
							type: "toolcall_start",
							contentIndex: output.content.length - 1,
							partial: output,
						});
					}
				} else if (event.type === "content_block_delta") {
					const pos = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[pos];
					if (!block) continue;

					if (event.delta.type === "text_delta" && block.type === "text") {
						block.text += event.delta.text;
						stream.push({
							type: "text_delta",
							contentIndex: pos,
							delta: event.delta.text,
							partial: output,
						});
					} else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
						block.thinking += event.delta.thinking;
						stream.push({
							type: "thinking_delta",
							contentIndex: pos,
							delta: event.delta.thinking,
							partial: output,
						});
					} else if (
						event.delta.type === "input_json_delta" &&
						block.type === "toolCall"
					) {
						(block as any).partialJson += event.delta.partial_json;
						block.arguments = parseStreamingJson((block as any).partialJson);
						stream.push({
							type: "toolcall_delta",
							contentIndex: pos,
							delta: event.delta.partial_json,
							partial: output,
						});
					} else if (
						event.delta.type === "signature_delta" &&
						block.type === "thinking"
					) {
						block.thinkingSignature =
							(block.thinkingSignature ?? "") + (event.delta as any).signature;
					}
				} else if (event.type === "content_block_stop") {
					const pos = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[pos];
					if (!block) continue;

					delete (block as any).index;

					if (block.type === "text") {
						stream.push({
							type: "text_end",
							contentIndex: pos,
							content: block.text,
							partial: output,
						});
					} else if (block.type === "thinking") {
						stream.push({
							type: "thinking_end",
							contentIndex: pos,
							content: block.thinking,
							partial: output,
						});
					} else if (block.type === "toolCall") {
						block.arguments = parseStreamingJson((block as any).partialJson);
						delete (block as any).partialJson;
						stream.push({
							type: "toolcall_end",
							contentIndex: pos,
							toolCall: block,
							partial: output,
						});
					}
				} else if (event.type === "message_delta") {
					if ((event.delta as any).stop_reason) {
						output.stopReason = mapStopReason((event.delta as any).stop_reason);
					}
					output.usage.input = (event.usage as any).input_tokens ?? output.usage.input;
					output.usage.output = (event.usage as any).output_tokens ?? output.usage.output;
					output.usage.cacheRead =
						(event.usage as any).cache_read_input_tokens ?? output.usage.cacheRead;
					output.usage.cacheWrite =
						(event.usage as any).cache_creation_input_tokens ?? output.usage.cacheWrite;
					output.usage.totalTokens =
						output.usage.input +
						output.usage.output +
						output.usage.cacheRead +
						output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as any).index;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage =
				error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}
