import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isOmpHost } from "../src/host.js";
import impl from "../src/status-display.js";

// pi-only: omp renders its own native status line; this display layer
// targets pi's status internals. Registers nothing on omp.
export default function (pi: ExtensionAPI) {
	if (isOmpHost()) return;
	impl(pi);
}
