import { describe, expect, test } from "bun:test";
import {
  clampPostAnchorMarkerTTLs,
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

  test("post-anchor rolling markers clamp to 5m while stable prefix keeps anchor TTL", () => {
    const value = payload(["1h"]); // system marker
    (value.messages as unknown[])!.push(
      { role: "user", content: [{ type: "tool_result", content: [], cache_control: { type: "ephemeral", ttl: "1h" } }] },
      { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } }] },
    );
    clampPostAnchorMarkerTTLs(value, 0); // anchor sits in messages[0]
    const system = (value.system![0] as { cache_control: { ttl: string } }).cache_control.ttl;
    const msgs = value.messages as Array<{ content: Array<{ cache_control?: { ttl: string } }> }>;
    expect(system).toBe("1h");
    expect(msgs[0].content[0].cache_control!.ttl).toBe("1h"); // anchor block
    expect(msgs[1].content[0].cache_control!.ttl).toBe("5m"); // rolling marker
  });

  test("clamp must not mutate cache_control objects shared with system/tools markers (pi-ai aliases them)", () => {
    // pi-ai assigns the SAME cache_control object to system, last tool, and the
    // trailing message marker. In-place mutation flipped system/tools to 5m and
    // tripped Anthropic's "no 1h after 5m" ordering rule (400).
    const shared: { type: "ephemeral"; ttl: "1h" } = { type: "ephemeral", ttl: "1h" };
    const value = payload(["1h"]);
    (value.system![0] as { cache_control: unknown }).cache_control = shared;
    (value.messages as unknown[])!.push(
      { role: "user", content: [{ type: "text", text: "anchor", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      { role: "user", content: [{ type: "text", text: "trailing", cache_control: shared }] },
    );
    clampPostAnchorMarkerTTLs(value, 0); // anchor at messages[0]
    const system = (value.system![0] as { cache_control: { ttl: string } }).cache_control.ttl;
    const msgs = value.messages as Array<{ content: Array<{ cache_control?: { ttl: string } }> }>;
    expect(system).toBe("1h"); // shared object untouched
    expect(msgs[1].content[0].cache_control!.ttl).toBe("5m");
    expect(msgs[1].content[0].cache_control).not.toBe(shared); // de-aliased
    expect(shared.ttl).toBe("1h"); // original object never mutated
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
