import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import searchExtension, {
  doSearch,
  finalizeFetchedText,
  normalizeConfig,
  readBoundedBody,
  resolveProvider,
  resolveSearchApiKey,
  resolveSearchModel,
} from "../src/native-search";

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalAllowPrivateHosts = process.env.PI_SEARCH_ALLOW_PRIVATE_HOSTS;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  if (originalAllowPrivateHosts === undefined)
    delete process.env.PI_SEARCH_ALLOW_PRIVATE_HOSTS;
  else process.env.PI_SEARCH_ALLOW_PRIVATE_HOSTS = originalAllowPrivateHosts;
});

const model = (provider: string, id: string, baseUrl: string) =>
  ({ provider, id, baseUrl }) as any;

test("config does not persist an environment-derived private-host setting", () => {
  process.env.PI_SEARCH_ALLOW_PRIVATE_HOSTS = "1";
  expect(normalizeConfig({}).allowPrivateHosts).toBeUndefined();
  expect(normalizeConfig({ allowPrivateHosts: false }).allowPrivateHosts).toBe(false);
});

test("stored API-key secret refs resolve through Pi instead of being sent literally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-search-auth-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.OPENAI_API_KEY;
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "!op://vault/openai/key" } }),
  );
  let requestedProvider: string | undefined;

  try {
    const key = await resolveSearchApiKey("openai", {
      modelRegistry: {
        async getApiKeyForProvider(provider: string) {
          requestedProvider = provider;
          return "resolved-secret";
        },
      },
    } as any);
    expect(key).toBe("resolved-secret");
    expect(requestedProvider).toBe("openai");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("native search routing", () => {
  test("maps openai-codex to the Codex backend", () => {
    expect(resolveProvider("openai-codex")).toBe("codex");
  });

  test("routes an Anthropic override away from the active OpenAI URL", () => {
    const active = model("openai", "gpt-5", "https://evil.invalid");
    const target = model(
      "anthropic",
      "claude-sonnet-4-5",
      "https://api.anthropic.com",
    );
    const resolved = resolveSearchModel(
      { model: active, modelRegistry: { getAvailable: () => [target] } } as any,
      "anthropic",
    );
    expect(resolved).toBe(target);
    expect(resolved?.baseUrl).toBe("https://api.anthropic.com");
    expect(resolved?.baseUrl).not.toBe(active.baseUrl);
  });

  test("reports a missing override model and uses DDG", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(url.toString());
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const result = await doSearch("query", "anthropic");
    expect(result.method).toBe("ddg");
    expect(result.nativeError).toContain("No available anthropic model");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("duckduckgo.com");
  });

  test("does not fall back to DDG when native search is already aborted", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const controller = new AbortController();
    controller.abort();

    await expect(
      doSearch(
        "query",
        "openai",
        model("openai", "gpt-5", "https://api.openai.com"),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });
});

test("bounded body stops at the byte limit and cancels the stream", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("€xy"));
    },
    cancel() {
      cancelled = true;
    },
  });

  const result = await readBoundedBody(new Response(stream), 4);
  expect(result).toEqual({ text: "€x", truncated: true });
  expect(cancelled).toBe(true);
});

test("formatted fetch output stays bounded and keeps its truncation notice", () => {
  const output = finalizeFetchedText("x".repeat(DEFAULT_MAX_BYTES + 100), true);
  expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(
    DEFAULT_MAX_BYTES,
  );
  expect(output.endsWith("\n\n[Truncated]")).toBe(true);
});

test("private fetch URL is rejected before the Claude bridge runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-search-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(
    join(dir, "search-config.json"),
    JSON.stringify({
      enabled: true,
      searchEnabled: true,
      fetchEnabled: true,
      searchProvider: "claude-bridge",
      providerOverrides: {},
      allowPrivateHosts: false,
    }),
  );
  let fetchTool: any;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error("backend must not run");
  }) as typeof fetch;
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(tool: any) {
      if (tool.name === "web_fetch") fetchTool = tool;
    },
    getActiveTools: () => [],
    setActiveTools() {},
  } as any;

  try {
    searchExtension(pi);
    const result = await fetchTool.execute(
      "id",
      { url: "http://127.0.0.1/private" },
      undefined,
      undefined,
      { modelRegistry: { getAvailable: () => [] } },
    );
    expect(result.details.error).toContain("private/loopback");
    expect(networkCalls).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
