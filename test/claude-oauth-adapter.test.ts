import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import claudeOauthAdapter from "../src/claude-oauth-adapter";

const DOCS_MARKER =
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SYSTEM_PROMPT = `Base prompt\n\n${DOCS_MARKER}\n- Pi docs\n\n# Project Context\nProject`;

const envNames = [
  "PI_CLAUDE_OAUTH_REINJECT_SCOPE",
  "PI_CLAUDE_OAUTH_LOG_FILE",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
});

afterEach(() => {
  for (const name of envNames) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function setup(oauth: boolean) {
  const handlers: Record<string, (event: any, ctx: any) => any> = {};
  const statuses = new Map<string, string | undefined>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers[name] = handler;
    },
  };
  claudeOauthAdapter(pi as any);

  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: { isUsingOAuth: () => oauth },
    getSystemPrompt: () => SYSTEM_PROMPT,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (key: string, value: string | undefined) =>
        statuses.set(key, value),
    },
  };
  return { handlers, ctx, statuses };
}

describe("Claude OAuth adapter regression", () => {
  test("leaves non-OAuth Anthropic requests untouched", () => {
    const { handlers, ctx } = setup(false);
    const payload = {
      system: [{ type: "text", text: IDENTITY }],
      messages: [{ role: "user", content: "hello" }],
    };

    expect(
      handlers.before_agent_start?.(
        { prompt: "hello", systemPrompt: SYSTEM_PROMPT },
        ctx,
      ),
    ).toBeUndefined();
    expect(
      handlers.before_provider_request?.({ payload }, ctx),
    ).toBeUndefined();
    expect(payload.system[0]?.text).toBe(IDENTITY);
  });

  test("adds one billing header, removes identity, and stays idempotent", () => {
    const { handlers, ctx, statuses } = setup(true);
    const beforeResult = handlers.before_agent_start?.(
      { prompt: "hello", systemPrompt: SYSTEM_PROMPT },
      ctx,
    );
    expect(beforeResult.systemPrompt).toBe("Base prompt\n\n# Project Context\nProject");

    const payload = {
      system: [
        { type: "text", text: IDENTITY },
        { type: "text", text: "Base prompt" },
      ],
      messages: [{ role: "user", content: "hello from OAuth" }],
    };
    const first = handlers.before_provider_request?.({ payload }, ctx);
    const second = handlers.before_provider_request?.({ payload: first }, ctx);
    const system = second.system as Array<{ type: string; text: string }>;

    expect(system.some((block) => block.text === IDENTITY)).toBe(false);
    expect(
      system.filter((block) =>
        block.text.startsWith("x-anthropic-billing-header:"),
      ),
    ).toHaveLength(1);
    expect(system[0]?.text).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.96\.[0-9a-f]{3}; cc_entrypoint=pi; cch=[0-9a-f]{5};$/,
    );

    handlers.after_provider_response?.(
      { status: 200, headers: {} },
      ctx,
    );
    expect(statuses.get("claude-oauth-ready")).toBe("✓ Claude OAuth active");
    handlers.agent_end?.({}, ctx);
  });
});
