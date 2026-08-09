/** @ersintarhan/pi-toolkit — extension composition root. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLegacyXiaomiProvider } from "./src/legacy-xiaomi-provider.js";
import { registerUsageCommand } from "./src/usage-command.js";
import { registerContextCommand } from "./src/context-command.js";
import claudeOauthAdapter from "./src/claude-oauth-adapter.js";
import nativeSearchExtension from "./src/native-search.js";
import autoContextExtension from "./src/auto-context/index.js";

export default function (pi: ExtensionAPI) {
  registerLegacyXiaomiProvider(pi);
  registerUsageCommand(pi);
  registerContextCommand(pi);
  claudeOauthAdapter(pi);
  nativeSearchExtension(pi);
  autoContextExtension(pi);
}
