import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ContextParametersSchema } from "../src/auto-context/context/router";
import { getToolkitLogPath } from "../src/logger";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

describe("context schema", () => {
  test("bounds model-provided text fields", () => {
    const properties = ContextParametersSchema.properties;
    expect(properties.name.maxLength).toBe(120);
    expect(properties.summary.maxLength).toBe(12_000);
    expect(properties.carryover.maxLength).toBe(16_000);
    expect(properties.message.maxLength).toBe(16_000);
  });
});

describe("logger agent directory", () => {
  test("honors PI_CODING_AGENT_DIR without writing files", () => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-toolkit-agent-test";
    expect(getToolkitLogPath("example")).toBe(join("/tmp/pi-toolkit-agent-test", "logs", "example.log"));
  });
});
