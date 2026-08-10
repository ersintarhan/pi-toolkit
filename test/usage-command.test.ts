import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { UsagePanelComponent } from "../src/usage-command";

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

describe("UsagePanelComponent", () => {
  test("clamps every rendered line to the terminal width", () => {
    const panel = new UsagePanelComponent(theme, () => {}, {
      title: "Provider usage with a deliberately long title",
      rows: [
        { type: "bar", label: "A long quota label", used: 25, limit: 100, suffix: "tokens" },
        { type: "kv", key: "Reset", value: "a deliberately long value" },
      ],
    });

    for (const width of [16, 32, 64]) {
      const lines = panel.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(visibleWidth(lines[0]!)).toBe(width);
      expect(visibleWidth(lines.at(-1)!)).toBe(width);
    }
  });
});
