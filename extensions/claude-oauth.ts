import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isOmpHost } from "../src/host.js";
import impl from "../src/claude-oauth-adapter.js";

// pi-only: omp ships native Anthropic OAuth; running this adapter there
// would duplicate credential management. Registers nothing on omp.
export default function (pi: ExtensionAPI) {
	if (isOmpHost()) return;
	impl(pi);
}
