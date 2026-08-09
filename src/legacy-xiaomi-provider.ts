import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One-release compatibility alias. Prefer Pi's native Xiaomi providers. */
export function registerLegacyXiaomiProvider(pi: ExtensionAPI): void {
  pi.registerProvider("xiaomi-mimo", {
    name: "Xiaomi MiMo (deprecated compatibility alias)",
    baseUrl:
      process.env.XIAOMI_MIMO_BASE_URL ||
      "https://token-plan-sgp.xiaomimimo.com/anthropic",
    apiKey: "$XIAOMI_TOKEN_PLAN_API_KEY",
    api: "anthropic-messages",
    models: [
      {
        id: "mimo-v2.5",
        name: "MiMo V2.5 (deprecated xiaomi-mimo alias)",
        reasoning: true,
        input: ["text", "image"],
        cost: {
          input: 0.14,
          output: 0.28,
          cacheRead: 0.0028,
          cacheWrite: 0.14,
        },
        contextWindow: 1_048_576,
        maxTokens: 262_144,
      },
      {
        id: "mimo-v2.5-pro",
        name: "MiMo V2.5 Pro (deprecated xiaomi-mimo alias)",
        reasoning: true,
        input: ["text"],
        cost: {
          input: 0.435,
          output: 0.87,
          cacheRead: 0.0036,
          cacheWrite: 0.435,
        },
        contextWindow: 1_048_576,
        maxTokens: 262_144,
      },
    ],
  });
}
