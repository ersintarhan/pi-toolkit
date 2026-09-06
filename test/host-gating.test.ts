import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { __setHostOverride } from "../src/host.js";
import claudeOauth from "../extensions/claude-oauth.ts";
import contextReport from "../extensions/context-report.ts";
import providerUsage from "../extensions/provider-usage.ts";
import statusDisplay from "../extensions/status-display.ts";
import nativeSearch from "../extensions/native-search.ts";

/** Records every host-API touch so a no-op wrapper proves itself. */
function recordingPi() {
  const touches: string[] = [];
  const pi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "__touches") return touches;
        return (...args: unknown[]) => {
          touches.push(prop);
          return undefined;
        };
      },
    },
  ) as unknown as Record<string, unknown> & { __touches: string[] };
  return { pi, touches };
}

describe("pi-only extension gating on omp", () => {
  beforeEach(() => __setHostOverride(true));
  afterAll(() => __setHostOverride(undefined));

  const wrappers: Array<[string, (pi: unknown) => void]> = [
    ["claude-oauth", claudeOauth],
    ["context-report", contextReport],
    ["provider-usage", providerUsage],
    ["status-display", statusDisplay],
    ["native-search", nativeSearch],
  ];

  for (const [name, wrapper] of wrappers) {
    test(`${name} registers nothing on omp`, () => {
      const { pi, touches } = recordingPi();
      wrapper(pi);
      expect(touches).toEqual([]);
    });
  }
});
