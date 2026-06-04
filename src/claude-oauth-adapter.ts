import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

const DOCS_MARKER =
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
const IDENTITY_BLOCK =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const CUSTOM_TYPE = "claude-oauth-docs-context";
const READY_STATUS_KEY = "claude-oauth-ready";
const ISSUE_STATUS_KEY = "claude-oauth-issue";
const END_MARKERS = [
  "\n\n# Project Context",
  "\n\n<available_skills>",
  "Current date:",
] as const;
const PI_TOPIC_REGEX =
  /\b(pi|@mariozechner\/pi-|pi-mono|coding agent harness|pi sdk|pi extension|pi theme|pi skill|pi tui|pi package|prompt templates?|keybindings?|custom providers?|adding models?)\b/i;
const DEFAULT_CLAUDE_CODE_VERSION = "2.1.96";
const BILLING_SALT = "59cf53e54c78";
const DEFAULT_ENTRYPOINT = "pi";

type ReinjectionMode =
  | "none"
  | "prepend-custom-message"
  | "append-custom-message"
  | "user-reminder";
type ReinjectionScope = "never" | "always" | "pi-only";
type DocsSource = "system" | "fallback" | "missing";
type BillingHeaderState = "unknown" | "present" | "injected";
type AdapterPhase = "inactive" | "ready" | "active" | "issue";

interface ActiveTurnState {
  docsSection: string;
  shouldInject: boolean;
  mode: ReinjectionMode;
  prompt: string;
  timestamp: number;
}

interface AdapterStatusState {
  phase: AdapterPhase;
  applies: boolean;
  suppressWarning: boolean;
  docsSource: DocsSource;
  billingHeader: BillingHeaderState;
  reason: string;
}

type TextContentPart = TextContent;
type ImageContentPart = ImageContent;
type MessageContentPart = TextContentPart | ImageContentPart;
type CustomLikeMessage = {
  role: "custom";
  customType: string;
  content: string | MessageContentPart[];
  display: boolean;
  details?: unknown;
  timestamp: number;
};

type UserLikeMessage = Extract<Message, { role: "user" }>;

type TextBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "1h" };
};

interface PayloadLike {
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
}

interface ResolvedDocsSection {
  extracted: { docsSection: string; strippedPrompt: string } | null;
  docsSection: string | null;
  docsSource: DocsSource;
}

let activeTurn: ActiveTurnState | null = null;
let adapterStatus: AdapterStatusState = {
  phase: "inactive",
  applies: false,
  suppressWarning: false,
  docsSource: "missing",
  billingHeader: "unknown",
  reason: "Not using Anthropic OAuth",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPayloadLike(value: unknown): value is PayloadLike {
  return isObject(value);
}

function isTextBlock(value: unknown): value is TextBlock {
  return (
    isObject(value) && value.type === "text" && typeof value.text === "string"
  );
}

function isUserMessage(message: AgentMessage): message is UserLikeMessage {
  return (message as Message).role === "user";
}

function isCustomLikeMessage(message: unknown): message is CustomLikeMessage {
  return (
    isObject(message) &&
    message.role === "custom" &&
    typeof message.customType === "string" &&
    (typeof message.content === "string" || Array.isArray(message.content))
  );
}

function getEnvMode(): ReinjectionMode {
  const value = process.env.PI_CLAUDE_OAUTH_REINJECT_MODE;
  if (
    value === "none" ||
    value === "prepend-custom-message" ||
    value === "append-custom-message" ||
    value === "user-reminder"
  ) {
    return value;
  }
  return "prepend-custom-message";
}

function getEnvScope(): ReinjectionScope {
  const value = process.env.PI_CLAUDE_OAUTH_REINJECT_SCOPE;
  if (value === "never" || value === "always" || value === "pi-only") {
    return value;
  }
  return "never"; // docs re-injection disabled by default
}

function getClaudeCodeVersion(): string {
  return (
    process.env.PI_CLAUDE_CODE_VERSION ??
    process.env.CLAUDE_CODE_VERSION ??
    DEFAULT_CLAUDE_CODE_VERSION
  );
}

function getEntrypoint(): string {
  return (
    process.env.PI_CLAUDE_CODE_ENTRYPOINT ??
    process.env.CLAUDE_CODE_ENTRYPOINT ??
    DEFAULT_ENTRYPOINT
  );
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getBillingMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is Record<string, unknown> =>
        isObject(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => String(block.text))
    .join("\n");
}

function buildBillingHeader(
  messages: unknown,
  entrypoint: string = getEntrypoint(),
): string {
  const list = Array.isArray(messages) ? messages : [];
  const firstUserMessage = list.find(
    (message) => isObject(message) && message.role === "user",
  ) as Record<string, unknown> | undefined;
  const messageText = firstUserMessage
    ? getBillingMessageText(firstUserMessage.content)
    : "";
  const version = getClaudeCodeVersion();
  const sampledChars = [4, 7, 20]
    .map((index) => messageText[index] ?? "0")
    .join("");
  const versionHash = sha256Hex(
    `${BILLING_SALT}${sampledChars}${version}`,
  ).slice(0, 3);
  const cch = sha256Hex(messageText).slice(0, 5);
  return `x-anthropic-billing-header: cc_version=${version}.${versionHash}; cc_entrypoint=${entrypoint}; cch=${cch};`;
}

function getLogFile(): string | null {
  const path = process.env.PI_CLAUDE_OAUTH_LOG_FILE;
  return path ? resolve(path) : null;
}

function log(event: string, details: Record<string, unknown>): void {
  const logFile = getLogFile();
  if (!logFile) return;

  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(
      logFile,
      `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`,
      "utf8",
    );
  } catch {
    // Never let optional debug logging break the session.
  }
}

function shouldApply(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  return (
    !!model &&
    model.provider === "anthropic" &&
    ctx.modelRegistry.isUsingOAuth(model)
  );
}

function clearAdapterStatuses(ctx: ExtensionContext): void {
  ctx.ui.setStatus(READY_STATUS_KEY, undefined);
  ctx.ui.setStatus(ISSUE_STATUS_KEY, undefined);
}

function renderAdapterStatus(ctx: ExtensionContext): void {
  clearAdapterStatuses(ctx);

  if (!adapterStatus.applies) return;

  const theme = ctx.ui.theme;
  if (adapterStatus.phase === "ready") {
    ctx.ui.setStatus(
      READY_STATUS_KEY,
      theme.fg("success", "✓ Claude OAuth ready"),
    );
    return;
  }

  if (adapterStatus.phase === "active") {
    ctx.ui.setStatus(
      READY_STATUS_KEY,
      theme.fg("success", "✓ Claude OAuth active"),
    );
    return;
  }

  if (adapterStatus.phase === "issue") {
    ctx.ui.setStatus(
      ISSUE_STATUS_KEY,
      theme.fg("warning", "⚠ Claude OAuth setup"),
    );
  }
}

function setAdapterStatus(
  ctx: ExtensionContext,
  nextStatus: AdapterStatusState,
): void {
  adapterStatus = nextStatus;
  renderAdapterStatus(ctx);
}

function shouldInjectDocs(prompt: string): boolean {
  const scope = getEnvScope();
  if (scope === "never") return false;
  if (scope === "always") return true;
  return PI_TOPIC_REGEX.test(prompt);
}

function extractDocsSection(
  systemPrompt: string,
): { docsSection: string; strippedPrompt: string } | null {
  const start = systemPrompt.indexOf(DOCS_MARKER);
  if (start < 0) return null;

  let end = systemPrompt.length;
  for (const marker of END_MARKERS) {
    const index = systemPrompt.indexOf(marker, start);
    if (index >= 0 && index < end) end = index;
  }

  const docsSection = systemPrompt.slice(start, end).trim();
  const before = systemPrompt.slice(0, start).trimEnd();
  const after = systemPrompt.slice(end).trimStart();
  const strippedPrompt = [before, after]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
  return { docsSection, strippedPrompt };
}

function getPiPackageRoot(): string | null {
  const cliPath = process.argv[1];
  if (!cliPath) return null;

  try {
    const resolvedCliPath = realpathSync(cliPath);
    return dirname(dirname(resolvedCliPath));
  } catch {
    return null;
  }
}

function buildDynamicFallbackDocsSection(): string | null {
  const piRoot = getPiPackageRoot();
  if (!piRoot) return null;

  const readmePath = join(piRoot, "README.md");
  const docsPath = join(piRoot, "docs");
  const examplesPath = join(piRoot, "examples");
  return [
    DOCS_MARKER,
    `- Main documentation: ${readmePath}`,
    `- Additional docs: ${docsPath}`,
    `- Examples: ${examplesPath} (extensions, custom tools, SDK)`,
    "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
    "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
    "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
  ].join("\n");
}

function readFallbackDocsSection(): string | null {
  const override = process.env.PI_CLAUDE_OAUTH_DOCS_FILE;
  if (override) {
    const path = resolve(override);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8").trim();
      if (content.length > 0) return content;
    }
  }

  return buildDynamicFallbackDocsSection();
}

function resolveDocsSection(systemPrompt: string): ResolvedDocsSection {
  const extracted = extractDocsSection(systemPrompt);
  if (extracted) {
    return {
      extracted,
      docsSection: extracted.docsSection,
      docsSource: "system",
    };
  }

  const fallbackDocs = readFallbackDocsSection();
  if (fallbackDocs) {
    return {
      extracted: null,
      docsSection: fallbackDocs,
      docsSource: "fallback",
    };
  }

  return { extracted: null, docsSection: null, docsSource: "missing" };
}

function syncSetupStatus(
  ctx: ExtensionContext,
  systemPrompt: string,
): ResolvedDocsSection {
  if (!shouldApply(ctx)) {
    setAdapterStatus(ctx, {
      phase: "inactive",
      applies: false,
      suppressWarning: false,
      docsSource: "missing",
      billingHeader: "unknown",
      reason: "Not using Anthropic OAuth",
    });
    return { extracted: null, docsSection: null, docsSource: "missing" };
  }

  const resolved = resolveDocsSection(systemPrompt);
  if (!resolved.docsSection) {
    setAdapterStatus(ctx, {
      phase: "issue",
      applies: true,
      suppressWarning: false,
      docsSource: resolved.docsSource,
      billingHeader: "unknown",
      reason:
        "No Pi docs context available to rehydrate Anthropic OAuth requests",
    });
    return resolved;
  }

  const nextPhase: AdapterPhase =
    adapterStatus.phase === "active" ? "active" : "ready";
  const nextReason =
    resolved.docsSource === "system"
      ? "Using system prompt docs context"
      : "Using fallback docs context";

  setAdapterStatus(ctx, {
    phase: nextPhase,
    applies: true,
    suppressWarning: true,
    docsSource: resolved.docsSource,
    billingHeader: adapterStatus.billingHeader,
    reason: nextReason,
  });

  return resolved;
}

function wrapDocsContext(docsSection: string): string {
  return `<pi-docs-context>\n${docsSection}\n</pi-docs-context>`;
}

function summarizeMessages(
  messages: AgentMessage[],
): Array<Record<string, unknown>> {
  return messages.slice(-4).map((message) => {
    if (
      isObject(message) &&
      "role" in message &&
      ((message as Message).role === "user" ||
        (message as Message).role === "assistant" ||
        (message as Message).role === "toolResult") &&
      "content" in message
    ) {
      const rawContent = (message as Message).content;
      const content = Array.isArray(rawContent)
        ? rawContent
            .filter(
              (part): part is TextContentPart =>
                isObject(part) &&
                part.type === "text" &&
                typeof part.text === "string",
            )
            .map((part) => part.text)
            .join("\n")
        : String(rawContent);
      return { role: (message as Message).role, text: content.slice(0, 140) };
    }

    const customMessage = isCustomLikeMessage(message) ? message : null;
    if (customMessage) {
      const content =
        typeof customMessage.content === "string"
          ? customMessage.content
          : customMessage.content
              .filter((part): part is TextContentPart => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      return {
        role: customMessage.role,
        customType: customMessage.customType,
        text: content.slice(0, 140),
      };
    }

    return { role: (message as Message).role ?? "unknown" };
  });
}

function prependCustomMessage(
  messages: AgentMessage[],
  docsSection: string,
  timestamp: number,
): AgentMessage[] {
  const customMessage: CustomLikeMessage = {
    role: "custom",
    customType: CUSTOM_TYPE,
    content: wrapDocsContext(docsSection),
    display: false,
    timestamp,
  };

  const latestUserIndex = [...messages].findLastIndex((message) =>
    isUserMessage(message),
  );
  if (latestUserIndex < 0) return [...messages, customMessage as unknown as AgentMessage];

  const nextMessages = [...messages];
  nextMessages.splice(latestUserIndex, 0, customMessage as unknown as AgentMessage);
  return nextMessages;
}

function appendCustomMessage(
  messages: AgentMessage[],
  docsSection: string,
  timestamp: number,
): AgentMessage[] {
  const customMessage: CustomLikeMessage = {
    role: "custom",
    customType: CUSTOM_TYPE,
    content: wrapDocsContext(docsSection),
    display: false,
    timestamp,
  };

  const latestUserIndex = [...messages].findLastIndex((message) =>
    isUserMessage(message),
  );
  if (latestUserIndex < 0) return [...messages, customMessage as unknown as AgentMessage];

  const nextMessages = [...messages];
  nextMessages.splice(latestUserIndex + 1, 0, customMessage as unknown as AgentMessage);
  return nextMessages;
}

function prependReminderToLatestUser(
  messages: AgentMessage[],
  docsSection: string,
): AgentMessage[] {
  const latestUserIndex = [...messages].findLastIndex((message) =>
    isUserMessage(message),
  );
  if (latestUserIndex < 0) return messages;

  const reminder = `<system-reminder>\n${docsSection}\n</system-reminder>\n\n`;
  const nextMessages = structuredClone(messages);
  const latestUser = nextMessages[latestUserIndex];
  if (!isUserMessage(latestUser)) return messages;

  if (typeof latestUser.content === "string") {
    if (!latestUser.content.startsWith("<system-reminder>")) {
      latestUser.content = `${reminder}${latestUser.content}`;
    }
    return nextMessages;
  }

  const firstTextIndex = latestUser.content.findIndex(
    (part) => part.type === "text",
  );
  if (firstTextIndex < 0) {
    latestUser.content.unshift({
      type: "text",
      text: reminder,
    } as TextContentPart);
    return nextMessages;
  }

  const firstText = latestUser.content[firstTextIndex];
  if (
    firstText.type === "text" &&
    !firstText.text.startsWith("<system-reminder>")
  ) {
    latestUser.content[firstTextIndex] = {
      ...firstText,
      text: `${reminder}${firstText.text}`,
    };
  }
  return nextMessages;
}

function injectDocs(messages: AgentMessage[], state: ActiveTurnState): AgentMessage[] {
  if (!state.shouldInject || state.mode === "none") return messages;

  switch (state.mode) {
    case "prepend-custom-message":
      return prependCustomMessage(messages, state.docsSection, state.timestamp);
    case "append-custom-message":
      return appendCustomMessage(messages, state.docsSection, state.timestamp);
    case "user-reminder":
      return prependReminderToLatestUser(messages, state.docsSection);
  }
}

function cloneBlock(block: TextBlock): TextBlock {
  return block.cache_control
    ? { ...block, cache_control: { ...block.cache_control } }
    : { ...block };
}

function ensurePromptBlock(
  blocks: TextBlock[],
  ctx: ExtensionContext,
): TextBlock[] {
  if (
    blocks.some(
      (block) => !block.text.startsWith("x-anthropic-billing-header:"),
    )
  ) {
    return blocks;
  }

  const systemPrompt = ctx.getSystemPrompt();
  const extracted = extractDocsSection(systemPrompt);
  const text = extracted?.strippedPrompt ?? systemPrompt;
  if (!text.trim()) return blocks;

  // Do not copy cache markers onto the synthetic prompt block. Anthropic
  // allows at most 4 cache_control blocks per request, and propagating an
  // existing marker here can push OAuth requests over that limit.
  return [...blocks, { type: "text", text }];
}

function normalizeSystemBlocks(
  blocks: TextBlock[],
  ctx: ExtensionContext,
  messages: unknown,
): { blocks: TextBlock[]; billingAdded: boolean } {
  let billingAdded = false;
  const nextBlocks: TextBlock[] = [];

  for (const block of blocks) {
    if (block.text === IDENTITY_BLOCK) {
      continue;
    }

    if (block.text.startsWith("x-anthropic-billing-header:")) {
      nextBlocks.push(cloneBlock(block));
      continue;
    }

    if (!block.text.includes(DOCS_MARKER)) {
      nextBlocks.push(cloneBlock(block));
      continue;
    }

    const extracted = extractDocsSection(block.text);
    if (!extracted || extracted.strippedPrompt.length === 0) {
      continue;
    }
    nextBlocks.push({ ...cloneBlock(block), text: extracted.strippedPrompt });
  }

  if (
    !nextBlocks.some((block) =>
      block.text.startsWith("x-anthropic-billing-header:"),
    )
  ) {
    nextBlocks.unshift({ type: "text", text: buildBillingHeader(messages) });
    billingAdded = true;
  }

  return { blocks: ensurePromptBlock(nextBlocks, ctx), billingAdded };
}

export default function claudeOauthAdapter(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    syncSetupStatus(ctx, ctx.getSystemPrompt());
  });

  pi.on("model_select", (_event, ctx) => {
    syncSetupStatus(ctx, ctx.getSystemPrompt());
  });

  pi.on("before_agent_start", (event, ctx) => {
    const resolved = syncSetupStatus(ctx, event.systemPrompt);
    if (!shouldApply(ctx)) {
      activeTurn = null;
      return;
    }

    if (!resolved.docsSection) {
      activeTurn = null;
      return;
    }

    activeTurn = {
      docsSection: resolved.docsSection,
      shouldInject: shouldInjectDocs(event.prompt),
      mode: getEnvMode(),
      prompt: event.prompt,
      timestamp: Date.now(),
    };

    log("before_agent_start", {
      prompt: event.prompt,
      shouldInject: activeTurn.shouldInject,
      mode: activeTurn.mode,
      scope: getEnvScope(),
      docsLength: resolved.docsSection.length,
      docsSource: resolved.docsSource,
      strippedFromSystem: !!resolved.extracted,
      suppressWarning: adapterStatus.suppressWarning,
    });

    if (resolved.extracted) {
      return { systemPrompt: resolved.extracted.strippedPrompt };
    }

    return;
  });

  pi.on("context", (event, ctx) => {
    if (!shouldApply(ctx) || !activeTurn) return;
    const nextMessages = injectDocs(event.messages, activeTurn);
    log("context", {
      mode: activeTurn.mode,
      shouldInject: activeTurn.shouldInject,
      messagesBefore: summarizeMessages(event.messages),
      messagesAfter: summarizeMessages(nextMessages),
    });
    return { messages: nextMessages };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!shouldApply(ctx) || !isPayloadLike(event.payload)) return;

    const currentBlocks = Array.isArray(event.payload.system)
      ? event.payload.system.filter(isTextBlock)
      : [];
    const hadBillingHeader = currentBlocks.some((block) =>
      block.text.startsWith("x-anthropic-billing-header:"),
    );
    const normalized = normalizeSystemBlocks(
      currentBlocks,
      ctx,
      event.payload.messages,
    );
    const changed =
      normalized.billingAdded ||
      normalized.blocks.length !== currentBlocks.length ||
      normalized.blocks.some(
        (block, index) => currentBlocks[index]?.text !== block.text,
      );

    const nextPayload = changed
      ? { ...event.payload, system: normalized.blocks }
      : event.payload;

    setAdapterStatus(ctx, {
      phase: "active",
      applies: true,
      suppressWarning: true,
      docsSource:
        adapterStatus.docsSource === "missing"
          ? "fallback"
          : adapterStatus.docsSource,
      billingHeader: normalized.billingAdded
        ? "injected"
        : hadBillingHeader
          ? "present"
          : "unknown",
      reason: normalized.billingAdded
        ? "Injected Claude billing header into Anthropic OAuth request"
        : hadBillingHeader
          ? "Anthropic OAuth request already includes Claude billing header"
          : "Normalized Anthropic OAuth request",
    });

    log("before_provider_request", {
      changed,
      billingAdded: normalized.billingAdded,
      docsSource: adapterStatus.docsSource,
      suppressWarning: adapterStatus.suppressWarning,
      systemBefore: currentBlocks.map(
        (block, index) => `${index}: ${block.text.slice(0, 140)}`,
      ),
      systemAfter: normalized.blocks.map(
        (block, index) => `${index}: ${block.text.slice(0, 140)}`,
      ),
      messageCount: Array.isArray(nextPayload.messages)
        ? nextPayload.messages.length
        : undefined,
      toolCount: Array.isArray(nextPayload.tools)
        ? nextPayload.tools.length
        : undefined,
    });

    return nextPayload;
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (!shouldApply(ctx)) return;
    if (event.status >= 400) {
      setAdapterStatus(ctx, {
        phase: "issue",
        applies: true,
        suppressWarning: false,
        docsSource: adapterStatus.docsSource,
        billingHeader: adapterStatus.billingHeader,
        reason: `Anthropic OAuth request failed with HTTP ${event.status}`,
      });
      return;
    }

    if (adapterStatus.phase === "active") {
      setAdapterStatus(ctx, {
        ...adapterStatus,
        phase: "active",
        applies: true,
        suppressWarning: true,
        reason: `Anthropic OAuth request succeeded (${event.status})`,
      });
    }
  });

  pi.on("agent_end", () => {
    activeTurn = null;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    activeTurn = null;
    adapterStatus = {
      phase: "inactive",
      applies: false,
      suppressWarning: false,
      docsSource: "missing",
      billingHeader: "unknown",
      reason: "Session ended",
    };
    clearAdapterStatuses(ctx);
  });
}
