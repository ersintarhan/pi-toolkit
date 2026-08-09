import { describe, expect, test } from "bun:test";
import {
  countMarkersRaw,
  normalizeCacheMarkerTTLs,
  resolveAnchorCacheTTL,
  type AnthropicPayload,
} from "../src/auto-context/anchor-cache/anthropic-payload";

function payload(ttls: Array<"5m" | "1h" | undefined>): AnthropicPayload {
  return {
    system: ttls.map((ttl) => ({ type: "text", text: "x", cache_control: { type: "ephemeral", ...(ttl ? { ttl } : {}) } })),
    messages: [],
  };
}

describe("anchor cache TTL", () => {
  test("skips payloads without markers and retention=none", () => {
    expect(resolveAnchorCacheTTL({ system: [{ type: "text", text: "x" }], messages: [] }, {})).toBeNull();
    expect(resolveAnchorCacheTTL(payload(["1h"]), { PI_CACHE_RETENTION: "none" })).toBeNull();
  });

  test("uses canonical retention overrides or the payload marker TTL", () => {
    expect(resolveAnchorCacheTTL(payload(["1h", "5m"]), {})).toBe("1h");
    expect(resolveAnchorCacheTTL(payload(["1h"]), { PI_CACHE_RETENTION: "short" })).toBe("5m");
    expect(resolveAnchorCacheTTL(payload(["5m"]), { PI_CACHE_RETENTION: "long" })).toBe("1h");
    expect(resolveAnchorCacheTTL(payload(["5m"]), { PI_ANCHOR_CACHE_TTL: "1h" })).toBe("1h");
  });

  test("normalizes and counts real top-level and nested content markers", () => {
    const value = payload(["5m", "1h"]);
    (value.messages as unknown[])!.push({ role: "user", content: [{ type: "tool_result", content: [{ cache_control: { type: "ephemeral", ttl: "5m" } }] }] });

    expect(countMarkersRaw(value)).toBe(3);
    normalizeCacheMarkerTTLs(value, "1h");
    expect(JSON.stringify(value).match(/\"ttl\":\"1h\"/g)?.length).toBe(3);
    expect(JSON.stringify(value)).not.toContain('"ttl":"5m"');
  });

  test("ignores cache_control inside tool input", () => {
    const value = {
      system: [{ type: "text", text: "system" }],
      messages: [{
        role: "assistant" as const,
        content: [{ type: "tool_use", input: { cache_control: { type: "user-value", ttl: "custom" } } }],
      }],
    };
    const before = JSON.stringify(value);

    expect(resolveAnchorCacheTTL(value, {})).toBeNull();
    expect(countMarkersRaw(value)).toBe(0);
    normalizeCacheMarkerTTLs(value, "1h");
    expect(JSON.stringify(value)).toBe(before);
  });
});
