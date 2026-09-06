import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isOmpHost } from "../src/host.js";
import { registerContextCommand as impl } from "../src/context-command.js";

// pi-only: omp ships a native context report; this /context UI layer is a
// pi-side equivalent. Registers nothing on omp.
export default function (pi: ExtensionAPI) {
	if (isOmpHost()) return;
	impl(pi);
}
