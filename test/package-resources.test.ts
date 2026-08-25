import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import contextManagementExtension from "../extensions/context-management";
import { restoreBindCommandContext } from "../src/auto-context/command-actions";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const extensions = [
  "./extensions/status-display.ts",
  "./extensions/provider-usage.ts",
  "./extensions/context-report.ts",
  "./extensions/claude-oauth.ts",
  "./extensions/native-search.ts",
  "./extensions/context-management.ts",
];

afterEach(restoreBindCommandContext);

describe("package resources", () => {
  test("exposes each feature and the optional status display separately", () => {
    expect(manifest.pi.extensions).toEqual(extensions);
    for (const extension of extensions) {
      expect(existsSync(join(root, extension))).toBe(true);
    }
  });

  test("loads the context skill only through its owning extension", () => {
    const resourceHandlers: Array<() => { skillPaths: string[] }> = [];
    contextManagementExtension({
      registerTool() {},
      on(event: string, handler: () => { skillPaths: string[] }) {
        if (event === "resources_discover") resourceHandlers.push(handler);
      },
    } as never);

    expect(manifest.pi.skills).toBeUndefined();
    expect(resourceHandlers).toHaveLength(1);
    expect(resourceHandlers[0]!().skillPaths).toEqual([
      join(root, "skills/context-management/SKILL.md"),
    ]);
  });
});
