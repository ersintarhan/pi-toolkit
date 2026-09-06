import * as PiAgentModule from "@earendil-works/pi-coding-agent";

/**
 * True when running under omp, a fork of pi-mono.
 *
 * Detection marker: `StatusLineComponent` is exported by the omp build's
 * pi-coding-agent shim and does not exist in upstream pi. The check is a
 * plain property lookup on the module namespace, so it stays safe on both
 * hosts regardless of type declarations.
 *
 * omp differences that matter here:
 * - Extension tools are dispatched through the write tool's xd:// device
 *   layer, so persisted tool results are xdev-wrapped (see
 *   `anchorPayloadOf`).
 * - Host internals (ExtensionRunner) differ from pi's, and omp ships its
 *   own Anthropic OAuth + prompt-cache marker management.
 */
let cached: boolean | undefined;

export function isOmpHost(): boolean {
	if (cached === undefined) {
		cached =
			"StatusLineComponent" in
			(PiAgentModule as unknown as Record<string, unknown>);
	}
	return cached;
}
