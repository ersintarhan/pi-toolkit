import { describe, expect, test } from "bun:test";
import { registerLegacyXiaomiProvider } from "../src/legacy-xiaomi-provider";

describe("legacy Xiaomi provider", () => {
  test("registers only the deprecated V2.5 alias on Pi's native Anthropic stream", () => {
    const originalBaseUrl = process.env.XIAOMI_MIMO_BASE_URL;
    delete process.env.XIAOMI_MIMO_BASE_URL;
    let provider = "";
    let config: any;
    try {
      registerLegacyXiaomiProvider({
        registerProvider(name: string, value: unknown) {
          provider = name;
          config = value;
        },
      } as any);
    } finally {
      if (originalBaseUrl === undefined) delete process.env.XIAOMI_MIMO_BASE_URL;
      else process.env.XIAOMI_MIMO_BASE_URL = originalBaseUrl;
    }

    expect(provider).toBe("xiaomi-mimo");
    expect(config.name).toContain("deprecated");
    expect(config.api).toBe("anthropic-messages");
    expect(config.apiKey).toBe("$XIAOMI_TOKEN_PLAN_API_KEY");
    expect(config.baseUrl).toBe(
      "https://token-plan-sgp.xiaomimimo.com/anthropic",
    );
    expect(config).not.toHaveProperty("streamSimple");

    expect(config.models).toEqual([
      expect.objectContaining({
        id: "mimo-v2.5",
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
      }),
      expect.objectContaining({
        id: "mimo-v2.5-pro",
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
      }),
    ]);
  });
});
