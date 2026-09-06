import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isOmpHost } from "../src/host.js";
import { registerUsageCommand as impl } from "../src/usage-command.js";

// pi-only: omp ships native provider usage reporting; this /usage command
// reads pi-side credential storage. Registers nothing on omp.
export default function (pi: ExtensionAPI) {
	if (isOmpHost()) return;
	impl(pi);
}
