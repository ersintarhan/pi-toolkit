import { describe, expect, test } from "bun:test";
import { estimateStringTokens, sourceAllocationName, splitAvailableSkillsTokens } from "../src/context-command";

describe("context accounting helpers", () => {
  test("moves the exact available_skills block out of system without double counting", () => {
    const prompt = "before\n<available_skills>\n<skill>one</skill>\n</available_skills>\nafter";
    const split = splitAvailableSkillsTokens(prompt);

    expect(split.skills).toBe(estimateStringTokens("<available_skills>\n<skill>one</skill>\n</available_skills>"));
    expect(split.system + split.skills).toBe(estimateStringTokens(prompt));
  });

  test("leaves prompts without a skills block in system", () => {
    expect(splitAvailableSkillsTokens("plain system prompt")).toEqual({
      system: estimateStringTokens("plain system prompt"),
      skills: 0,
    });
  });

  test("keeps both segments of scoped node_modules package names", () => {
    expect(sourceAllocationName({ sourceInfo: { path: "/tmp/node_modules/@scope/package/index.ts" } })).toBe("@scope/package");
    expect(sourceAllocationName({ sourceInfo: { path: "/tmp/node_modules/plain-package/index.ts" } })).toBe("plain-package");
  });
});
