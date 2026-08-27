import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATE_KEY = Symbol.for("pi-toolkit.status-display.state.v1");
const STATUS_KEYS = [
	"auto-context",
	"search",
	"claude-oauth-ready",
	"claude-oauth-issue",
] as const;

interface StatusContext {
	ui: {
		setStatus(key: string, value: string | undefined): void;
	};
}

interface StatusDisplayState {
	enabled: boolean;
}

function getState(): StatusDisplayState {
	const globals = globalThis as typeof globalThis & { [STATE_KEY]?: StatusDisplayState };
	return globals[STATE_KEY] ??= { enabled: false };
}

export function setStatusDisplayEnabled(enabled: boolean): void {
	getState().enabled = enabled;
}

export function isStatusDisplayEnabled(): boolean {
	return getState().enabled;
}

export function setOptionalStatus(
	ctx: StatusContext,
	key: string,
	value: string | undefined,
): void {
	ctx.ui.setStatus(key, isStatusDisplayEnabled() ? value : undefined);
}

function clearStatuses(ctx: StatusContext): void {
	for (const key of STATUS_KEYS) ctx.ui.setStatus(key, undefined);
}

export default function statusDisplayExtension(pi: ExtensionAPI): void {
	setStatusDisplayEnabled(true);
	pi.on("session_shutdown", (_event, ctx) => {
		clearStatuses(ctx);
		setStatusDisplayEnabled(false);
	});
}
