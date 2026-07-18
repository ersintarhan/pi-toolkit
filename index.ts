/**
 * @ersintarhan/pi-toolkit — entry point / wiring layer.
 *
 * Registers providers (MiniMax, Xiaomi MiMo) and composes the
 * bundled extensions: cached Anthropic stream, Claude OAuth adapter, native
 * web search, usage/context slash commands, and auto-context anchors.
 *
 * Provider implementations live in ./src/providers/* so this file stays a
 * thin composition root. Each provider module exports its own
 * registerXProvider(pi) and any session hooks it needs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamSimpleAnthropicCached } from "./src/cached-anthropic-stream.js";
import { registerUsageCommand } from "./src/usage-command.js";
import { registerContextCommand } from "./src/context-command.js";
import claudeOauthAdapter from "./src/claude-oauth-adapter.js";
import nativeSearchExtension from "./src/native-search.js";
import autoContextExtension from "./src/auto-context/index.js";

export default function (pi: ExtensionAPI) {
  // ── Providers ──────────────────────────────────────────────────────────

  // MiniMax — Anthropic-compatible, uses the cached stream directly.
  pi.registerProvider("minimax", {
    baseUrl: "https://api.minimax.io/anthropic",
    apiKey: "$MINIMAX_API_KEY",
    api: "anthropic-messages",
    streamSimple: streamSimpleAnthropicCached,
    models: [
      {
        id: "MiniMax-M3",
        name: "MiniMax-M3",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
        contextWindow: 1000000,
        maxTokens: 131072,
      },
      {
        id: "MiniMax-M2.7",
        name: "MiniMax-M2.7",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
        contextWindow: 204800,
        maxTokens: 131072,
      },
    ],
  });

  // Xiaomi MiMo — Anthropic-compatible.
  pi.registerProvider("xiaomi-mimo", {
    baseUrl: process.env.XIAOMI_MIMO_BASE_URL || "https://token-plan-sgp.xiaomimimo.com/anthropic",
    apiKey: "$XIAOMI_TOKEN_PLAN_API_KEY",
    api: "anthropic-messages",
    streamSimple: streamSimpleAnthropicCached,
    models: [
      {
        id: "mimo-v2.5",
        name: "MiMo-V2.5",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.4, output: 2, cacheRead: 0.08, cacheWrite: 0.5 },
        contextWindow: 1048576,
        maxTokens: 131072,
      },
      {
        id: "mimo-v2.5-pro",
        name: "MiMo-V2.5-Pro",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 1.25 },
        contextWindow: 1048576,
        maxTokens: 131072,
      },
      {
        id: "mimo-v2-pro",
        name: "MiMo-V2-Pro",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 1.25 },
        contextWindow: 1048576,
        maxTokens: 131072,
      },
      {
        id: "mimo-v2-omni",
        name: "MiMo-V2-Omni",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.4, output: 2, cacheRead: 0.08, cacheWrite: 0.5 },
        contextWindow: 262144,
        maxTokens: 131072,
      },
    ],
  });

  // ── Extensions ─────────────────────────────────────────────────────────
  registerUsageCommand(pi);
  registerContextCommand(pi);
  claudeOauthAdapter(pi);
  nativeSearchExtension(pi);
  autoContextExtension(pi);
}
