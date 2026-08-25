/** @ersintarhan/pi-toolkit — extension composition root. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import statusDisplayExtension from "./extensions/status-display.js";
import registerUsageCommand from "./extensions/provider-usage.js";
import registerContextCommand from "./extensions/context-report.js";
import claudeOauthAdapter from "./extensions/claude-oauth.js";
import nativeSearchExtension from "./extensions/native-search.js";
import autoContextExtension from "./extensions/context-management.js";

export default function (pi: ExtensionAPI) {
  statusDisplayExtension(pi);
  registerUsageCommand(pi);
  registerContextCommand(pi);
  claudeOauthAdapter(pi);
  nativeSearchExtension(pi);
  autoContextExtension(pi);
}
