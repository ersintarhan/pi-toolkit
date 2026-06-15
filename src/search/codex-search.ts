import { getCodexAuth } from "./codex-auth.js";

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_MAX_SOURCES = 5;
const MAX_ALLOWED_SOURCES = 10;
const SEARCH_TIMEOUT_MS = 120_000;

export interface CodexSearchInput {
  query: string;
  maxSources?: number;
  freshness?: "cached" | "live";
}

export interface CodexSearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface CodexSearchDetails {
  query: string;
  freshness: "cached" | "live";
  sourceCount: number;
  sources: CodexSearchSource[];
  summary: string;
  truncated: boolean;
}

const SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          snippet: { type: "string" },
        },
        required: ["title", "url", "snippet"],
      },
    },
  },
  required: ["summary", "sources"],
};

function buildSearchPrompt(query: string, maxSources: number, freshness: string): string {
  return [
    "You are performing web research for a coding agent.",
    "Search the public web and answer the user's query using current online sources.",
    freshness === "live"
      ? "Prioritize the most recent and up-to-date information available."
      : "Cached results are fine; prioritize accuracy over recency.",
    "Return ONLY a JSON object matching this schema:",
    JSON.stringify(SEARCH_OUTPUT_SCHEMA),
    "Do not wrap the JSON in markdown fences or add any extra commentary.",
    `Keep the summary concise and useful. Limit sources to at most ${maxSources} items.`,
    "Prefer primary or official sources when available.",
    "Each source snippet should be short and directly relevant.",
    "",
    `User query: ${query}`,
  ].join("\n");
}

interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

function parseSSEBlock(block: string): SSEEvent | null {
  let event: string | null = null;
  const dataLines: string[] = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    // SSE spec: field value is everything after the colon, optionally stripping
    // one leading space. `data:{...}` (no space) is valid; tolerate both.
    if (line.startsWith("event:")) {
      event = line.slice(6).replace(/^ /, "") || null;
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }

  // Per SSE spec, an event without an `event:` field defaults to type "message".
  // Only require data; an empty data block is meaningless.
  const effectiveEvent = event ?? "message";
  if (dataLines.length === 0) return null;
  const dataText = dataLines.join("\n");
  if (dataText === "[DONE]") return null;

  try {
    return { type: effectiveEvent, data: JSON.parse(dataText) };
  } catch {
    return null;
  }
}

async function* iterateSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, separatorIndex);
        const match = buffer.slice(separatorIndex).match(/^\r?\n\r?\n/);
        buffer = buffer.slice(separatorIndex + (match?.[0].length ?? 2));
        const event = parseSSEBlock(block);
        if (event) yield event;
      }
    }

    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing) {
      const event = parseSSEBlock(trailing);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function executeCodexSearch(
  input: CodexSearchInput,
  options?: {
    signal?: AbortSignal;
    onUpdate?: (update: {
      content: { type: "text"; text: string }[];
      details: unknown;
    }) => void;
  },
) {
  const query = input.query.trim();
  if (!query) throw new Error("web_search requires a non-empty query.");

  const maxSources = Math.min(
    Math.max(Math.trunc(input.maxSources ?? DEFAULT_MAX_SOURCES), 1),
    MAX_ALLOWED_SOURCES,
  );
  const freshness = input.freshness ?? "cached";
  const auth = await getCodexAuth();

  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(new Error(`Codex search timed out after ${SEARCH_TIMEOUT_MS / 1000}s`)),
    SEARCH_TIMEOUT_MS,
  );
  const parentSignal = options?.signal;
  const onParentAbort = () => abortController.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    const response = await fetch(CODEX_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.accessToken}`,
        "ChatGPT-Account-ID": auth.accountId,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        instructions: buildSearchPrompt(query, maxSources, freshness),
        input: [{ role: "user", content: `Search the web for: ${query}` }],
        tools: [{ type: "web_search" }],
        store: false,
        stream: true,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const error = await response.text().catch(() => "Unknown error");
      if (response.status === 401) throw new Error("Authentication failed. Run `codex login`.");
      if (response.status === 429) throw new Error("Rate limited. Try again in a moment.");
      throw new Error(`API error (${response.status}): ${error}`);
    }

    if (!response.body) throw new Error("Streaming response body is not available.");

    let rawOutput = "";
    for await (const event of iterateSSE(response.body)) {
      // Surface terminal failure events with their real cause instead of
      // masking them as "Empty response" or a JSON parse error later.
      if (
        event.type === "response.failed" ||
        event.type === "response.error" ||
        event.type === "response.incomplete"
      ) {
        const data = (event.data as any) ?? {};
        const msg = data?.error?.message ?? data?.reason ?? event.type;
        throw new Error(`Codex response failed: ${msg}`);
      }
      if (event.type === "response.output_text.delta") {
        const delta = (event.data.delta as string) ?? "";
        rawOutput += delta;
        if (delta) {
          options?.onUpdate?.({
            content: [{ type: "text", text: `Searching with Codex… ${rawOutput.length} chars` }],
            details: { query, receivedChars: rawOutput.length },
          });
        }
      }
    }

    if (!rawOutput) throw new Error("Empty response from API.");

    // Models sometimes wrap JSON in markdown fences or add prose preamble,
    // which would make JSON.parse throw a cryptic SyntaxError. Strip fences
    // and surface a helpful message on failure.
    const cleaned = rawOutput.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let parsed: { summary?: string; sources?: CodexSearchSource[] };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`Codex returned non-JSON output (first 200 chars): ${cleaned.slice(0, 200)}`);
    }
    if (!parsed.sources || !Array.isArray(parsed.sources)) {
      throw new Error(`Invalid API response: ${rawOutput.slice(0, 200)}`);
    }
    const sources = parsed.sources.slice(0, maxSources);
    const summary = parsed.summary?.trim() ?? "";
    if (!summary) throw new Error("Empty summary in response.");

    const lines = [summary];
    if (sources.length > 0) {
      lines.push("", "Sources:");
      sources.forEach((s, i) => {
        lines.push(`${i + 1}. ${s.title}`, `   ${s.url}`);
        if (s.snippet) lines.push(`   ${s.snippet}`);
      });
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      details: { query, freshness, sourceCount: sources.length, sources, summary, truncated: false } as CodexSearchDetails,
    };
  } finally {
    clearTimeout(timeoutId);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
