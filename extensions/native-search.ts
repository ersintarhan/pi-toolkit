import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isOmpHost } from "../src/host.js";
import impl from "../src/native-search.js";

// pi-only: omp ships native search; this /search layer and its tools
// target pi's provider set. Registers nothing on omp.
export default function (pi: ExtensionAPI) {
	if (isOmpHost()) return;
	impl(pi);
}
