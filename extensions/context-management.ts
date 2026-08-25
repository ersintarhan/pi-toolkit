import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import autoContextExtension from "../src/auto-context/index.js";

const skillPath = fileURLToPath(
  new URL("../skills/context-management/SKILL.md", import.meta.url),
);

export default function contextManagementExtension(pi: ExtensionAPI) {
  autoContextExtension(pi);
  pi.on("resources_discover", () => ({ skillPaths: [skillPath] }));
}
