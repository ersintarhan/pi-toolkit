/**
 * /usage slash command — show provider quota / token plan usage in an overlay.
 *
 * Dispatches by ctx.model.provider:
 *   - kimi-coding  → https://api.kimi.com/coding/v1/usages (KIMI_API_KEY or OAuth)
 *   - minimax      → https://api.minimax.io/v1/token_plan/remains (MINIMAX_API_KEY)
 *   - xiaomi / Xiaomi regional IDs / legacy xiaomi-mimo
 *                  → https://platform.xiaomimimo.com/api/v1/tokenPlan/usage
 *                    (XIAOMI_MIMO_SESSION_COOKIE — browser SSO cookie; the
 *                    tp-... API key is rejected by this endpoint)
 *   - crofai       → https://crof.ai/usage_api/ (CROFAI_API_KEY)
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Hard cap on every outbound usage fetch so a slow/dead provider endpoint can
// never hang the /usage command indefinitely. Mirrors codex-search's pattern.
const USAGE_FETCH_TIMEOUT_MS = 15_000;

/** fetch() wrapper that aborts after USAGE_FETCH_TIMEOUT_MS. */
async function fetchUsage(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), USAGE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// -----------------------------------------------------------------------------
// Panel data model
// -----------------------------------------------------------------------------

type UsageRow =
  | { type: "bar"; label: string; used: number; limit: number; suffix?: string }
  | { type: "kv"; key: string; value: string }
  | { type: "text"; text: string; dim?: boolean }
  | { type: "blank" };

interface UsagePanelData {
  title: string;
  rows: UsageRow[];
}

// -----------------------------------------------------------------------------
// Auth helpers
// -----------------------------------------------------------------------------

function getKimiKey(): string {
  const envKey = process.env.KIMI_API_KEY?.trim();
  if (envKey) return envKey;

  const cred = readStoredCredential("kimi-coding");
  if (cred && cred.type === "oauth" && cred.access) return cred.access;

  throw new Error(
    "Kimi auth missing: set KIMI_API_KEY or run /login kimi-coding first.",
  );
}

function getMinimaxKey(): string {
  const key = process.env.MINIMAX_API_KEY?.trim();
  if (!key) throw new Error("MINIMAX_API_KEY not set.");
  return key;
}

function getMimoCookie(): string {
  const cookie = process.env.XIAOMI_MIMO_SESSION_COOKIE?.trim();
  if (!cookie) {
    throw new Error(
      "XIAOMI_MIMO_SESSION_COOKIE not set. The MiMo plan-usage endpoint is " +
        "behind Xiaomi SSO and rejects the tp-... API key. To populate it: " +
        "open https://platform.xiaomimimo.com in your browser, DevTools → " +
        "Application → Cookies → copy the entire cookie string for that " +
        "host, then `export XIAOMI_MIMO_SESSION_COOKIE='<paste>'`.",
    );
  }
  return cookie;
}

// -----------------------------------------------------------------------------
// Fetchers
// -----------------------------------------------------------------------------

interface KimiQuotaDetail {
  limit?: string | number;
  used?: string | number;
  remaining?: string | number;
  resetTime?: string;
  name?: string;
  title?: string;
}

interface KimiLimitWindow {
  duration?: number;
  timeUnit?: string;
}

interface KimiLimitEntry {
  window?: KimiLimitWindow;
  detail?: KimiQuotaDetail;
  name?: string;
  title?: string;
  scope?: string;
}

interface KimiUsageResponse {
  user?: { membership?: { level?: string } };
  usage?: KimiQuotaDetail;
  limits?: KimiLimitEntry[];
  parallel?: { limit?: string | number };
}

// Mirrors kimi-cli's _limit_label: prefer name/title/scope, else build from
// window.duration + window.timeUnit (e.g. duration=300, MINUTE → "5h limit").
function kimiLimitLabel(entry: KimiLimitEntry, idx: number): string {
  const named = entry.name ?? entry.title ?? entry.scope ?? entry.detail?.name ?? entry.detail?.title;
  if (named) return String(named);

  const w = entry.window ?? {};
  const duration = Number(w.duration ?? 0);
  const unit = String(w.timeUnit ?? "");
  if (duration > 0) {
    if (unit.includes("MINUTE")) {
      if (duration >= 60 && duration % 60 === 0) return `${duration / 60}h limit`;
      return `${duration}m limit`;
    }
    if (unit.includes("HOUR")) return `${duration}h limit`;
    if (unit.includes("DAY")) return `${duration}d limit`;
    return `${duration}s limit`;
  }
  return `Limit #${idx + 1}`;
}

function kimiUsedLimit(detail: KimiQuotaDetail | undefined): { used: number; limit: number } {
  const d = detail ?? {};
  const limit = Number(d.limit ?? 0);
  let used = d.used !== undefined ? Number(d.used) : NaN;
  if (!Number.isFinite(used)) {
    const remaining = d.remaining !== undefined ? Number(d.remaining) : NaN;
    used = Number.isFinite(remaining) ? Math.max(0, limit - remaining) : 0;
  }
  return { used, limit };
}

async function fetchKimiUsage(): Promise<UsagePanelData> {
  const key = getKimiKey();
  const res = await fetchUsage("https://api.kimi.com/coding/v1/usages", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new Error(`Kimi usage HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as KimiUsageResponse;

  const rows: UsageRow[] = [];

  // Top-level `usage` is the weekly summary (default label per kimi-cli).
  // No suffix: Kimi's API doesn't document what "100" counts (requests?
  // prompts? tool-call rounds?), so labeling it is misleading.
  if (body.usage) {
    const { used, limit } = kimiUsedLimit(body.usage);
    rows.push({ type: "bar", label: "Weekly limit", used, limit });
    rows.push({ type: "kv", key: "Resets in", value: formatTimeUntilIso(body.usage.resetTime) });
  }

  // `limits[]` entries are rolling windows (e.g. 5h limit).
  const limitEntries = body.limits ?? [];
  for (let i = 0; i < limitEntries.length; i++) {
    const entry = limitEntries[i]!;
    const label = kimiLimitLabel(entry, i);
    const { used, limit } = kimiUsedLimit(entry.detail);
    if (limit === 0 && used === 0) continue;
    rows.push({ type: "blank" });
    rows.push({ type: "bar", label, used, limit });
    rows.push({ type: "kv", key: "Resets in", value: formatTimeUntilIso(entry.detail?.resetTime) });
  }

  rows.push({ type: "blank" });
  rows.push({ type: "kv", key: "Parallel limit", value: String(body.parallel?.limit ?? "?") });
  const tier = (body.user?.membership?.level ?? "").replace(/^LEVEL_/, "") || "?";
  rows.push({ type: "kv", key: "Tier", value: tier });

  return { title: "Kimi for Coding — API Usage", rows };
}

interface MinimaxRemain {
  model_name: string;
  current_interval_total_count: number;
  current_interval_usage_count: number;
  remains_time?: number;
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  weekly_remains_time?: number;
}

interface MinimaxRemainsResponse {
  model_remains?: MinimaxRemain[];
  base_resp?: { status_code?: number; status_msg?: string };
}

async function fetchMinimaxUsage(): Promise<UsagePanelData> {
  const key = getMinimaxKey();
  const res = await fetchUsage("https://api.minimax.io/v1/token_plan/remains", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new Error(`MiniMax usage HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as MinimaxRemainsResponse;
  if (body.base_resp && body.base_resp.status_code !== 0) {
    throw new Error(
      `MiniMax usage: ${body.base_resp.status_msg ?? "unknown error"} (code ${body.base_resp.status_code})`,
    );
  }

  // MiniMax-M* / MiniMax-M2.7 / etc. are the LLM coding-plan rows. The
  // `coding-plan-vlm` and `coding-plan-search` entries share the same 5-hour
  // bucket as MiniMax-M*, so showing them separately is duplicate noise.
  const coding = (body.model_remains ?? []).filter(
    (m) => typeof m.model_name === "string" && m.model_name.startsWith("MiniMax-M"),
  );
  if (coding.length === 0) {
    return {
      title: "MiniMax Token Plan",
      rows: [{ type: "text", text: "No MiniMax-M* rows in response.", dim: true }],
    };
  }

  const rows: UsageRow[] = [];
  for (let i = 0; i < coding.length; i++) {
    const m = coding[i]!;
    rows.push({
      type: "bar",
      label: `${m.model_name} (5-hour window)`,
      used: m.current_interval_usage_count ?? 0,
      limit: m.current_interval_total_count ?? 0,
      suffix: "calls",
    });
    rows.push({
      type: "kv",
      key: "Resets in",
      value: formatTimeUntilMs(m.remains_time ?? 0),
    });
    if (i < coding.length - 1) rows.push({ type: "blank" });
  }

  return { title: "MiniMax Token Plan", rows };
}

interface MimoUsageItem {
  name: string;
  used: number;
  limit: number;
  percent: number;
}

interface MimoUsageResponse {
  code: number;
  message?: string;
  data?: {
    monthUsage?: { items?: MimoUsageItem[]; percent?: number };
    usage?: { items?: MimoUsageItem[]; percent?: number };
  };
}

async function fetchMimoUsage(): Promise<UsagePanelData> {
  const cookie = getMimoCookie();
  const res = await fetchUsage("https://platform.xiaomimimo.com/api/v1/tokenPlan/usage", {
    headers: { Cookie: cookie },
  });
  if (!res.ok) {
    throw new Error(`MiMo usage HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as MimoUsageResponse;
  if (body.code !== 0) {
    throw new Error(`MiMo usage: code=${body.code} ${body.message ?? ""}`);
  }

  const data = body.data ?? {};
  const planItems = data.usage?.items ?? [];
  const monthlyItems = data.monthUsage?.items ?? [];

  const plan = planItems.find((i) => i.name === "plan_total_token");
  const compensation = planItems.find((i) => i.name === "compensation_total_token");
  const monthly = monthlyItems.find((i) => i.name === "month_total_token");

  const rows: UsageRow[] = [];
  if (plan) {
    rows.push({
      type: "bar",
      label: "Plan usage",
      used: plan.used,
      limit: plan.limit,
      suffix: "tokens",
    });
  }
  if (compensation && compensation.limit > 0) {
    rows.push({ type: "blank" });
    rows.push({
      type: "bar",
      label: "Compensation",
      used: compensation.used,
      limit: compensation.limit,
      suffix: "tokens",
    });
  }
  if (monthly) {
    rows.push({ type: "blank" });
    rows.push({
      type: "bar",
      label: "Monthly total",
      used: monthly.used,
      limit: monthly.limit,
      suffix: "tokens",
    });
  }
  if (rows.length === 0) {
    rows.push({ type: "text", text: "No usage rows returned.", dim: true });
  }

  return { title: "Xiaomi MiMo — Token Plan", rows };
}

interface CrofaiUsageResponse {
  credits?: number;
  requests_plan?: number;
  usable_requests?: number;
}

async function fetchCrofaiUsage(): Promise<UsagePanelData> {
  const apiKey = process.env.CROFAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("CROFAI_API_KEY not set.");
  }
  const res = await fetchUsage("https://crof.ai/usage_api/", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`CrofAI usage HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as CrofaiUsageResponse;

  const rows: UsageRow[] = [];

  // Subscription plan → daily request quota
  if (body.usable_requests != null && body.requests_plan != null) {
    rows.push({
      type: "kv",
      key: "Remaining requests",
      value: `${formatNumber(body.usable_requests)} / ${formatNumber(body.requests_plan)}`,
    });
  }

  // Pay-as-you-go → credit balance (shown even on subscription as a secondary line)
  if (body.credits != null) {
    const credits = Number(body.credits);
    rows.push({
      type: "kv",
      key: "Credits",
      value: Number.isFinite(credits) ? `$${credits.toFixed(4)}` : "—",
    });
  }

  if (rows.length === 0) {
    rows.push({ type: "text", text: "No usage data returned.", dim: true });
  }

  return { title: "CrofAI Usage", rows };
}

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "?";
  return n.toLocaleString("en-US");
}

function formatTimeUntilMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return "<1m";
}

function formatTimeUntilIso(iso: string | undefined): string {
  if (!iso) return "?";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  return formatTimeUntilMs(t - Date.now());
}

// -----------------------------------------------------------------------------
// Overlay component
// -----------------------------------------------------------------------------

const BAR_WIDTH = 30;

function renderBar(percent: number, width = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(1, percent));
  const filled = Math.round(width * clamped);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

export class UsagePanelComponent implements Focusable {
  readonly width = 64;
  focused = false;

  constructor(
    private theme: Theme,
    private done: (result: undefined) => void,
    private data: UsagePanelData,
  ) {}

  handleInput(data: string): void {
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "return") ||
      matchesKey(data, "q")
    ) {
      this.done(undefined);
    }
  }

  render(w: number): string[] {
    const th = this.theme;
    const panelW = Math.max(2, Math.min(this.width, w));
    const innerW = panelW - 2;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      if (vis > len) return truncateToWidth(s, len);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
    lines.push(row(` ${th.fg("accent", this.data.title)}`));
    lines.push(row(""));

    for (const r of this.data.rows) {
      if (r.type === "blank") {
        lines.push(row(""));
      } else if (r.type === "text") {
        lines.push(row(` ${r.dim ? th.fg("dim", r.text) : th.fg("text", r.text)}`));
      } else if (r.type === "kv") {
        lines.push(row(` ${th.fg("dim", `${r.key}:`)} ${th.fg("text", r.value)}`));
      } else if (r.type === "bar") {
        const pct = r.limit > 0 ? r.used / r.limit : 0;
        const pctText = `${(pct * 100).toFixed(1)}%`;
        const bar = renderBar(pct, Math.max(0, Math.min(BAR_WIDTH, innerW - visibleWidth(pctText) - 3)));
        const detail = `${formatNumber(r.used)} / ${formatNumber(r.limit)}${
          r.suffix ? ` ${r.suffix}` : ""
        }`;
        lines.push(row(` ${th.fg("text", r.label)}`));
        lines.push(row(` ${th.fg("accent", bar)}  ${th.fg("text", pctText)}`));
        lines.push(row(` ${th.fg("dim", detail)}`));
      }
    }

    lines.push(row(""));
    lines.push(row(` ${th.fg("dim", "Esc / Enter / q to close")}`));
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}

// -----------------------------------------------------------------------------
// Plain-text fallback (print / RPC mode)
// -----------------------------------------------------------------------------

function renderUsagePlain(data: UsagePanelData): string {
  const lines: string[] = [data.title, "─".repeat(data.title.length)];
  for (const r of data.rows) {
    if (r.type === "blank") {
      lines.push("");
    } else if (r.type === "text") {
      lines.push(r.text);
    } else if (r.type === "kv") {
      lines.push(`${r.key}: ${r.value}`);
    } else if (r.type === "bar") {
      const pct = r.limit > 0 ? r.used / r.limit : 0;
      lines.push(`${r.label}`);
      lines.push(
        `  ${renderBar(pct)}  ${(pct * 100).toFixed(1)}%   ${formatNumber(r.used)} / ${formatNumber(r.limit)}${
          r.suffix ? ` ${r.suffix}` : ""
        }`,
      );
    }
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

const FETCHERS: Record<string, () => Promise<UsagePanelData>> = {
  "kimi-coding": fetchKimiUsage,
  crofai: fetchCrofaiUsage,
  minimax: fetchMinimaxUsage,
  xiaomi: fetchMimoUsage,
  "xiaomi-token-plan-cn": fetchMimoUsage,
  "xiaomi-token-plan-ams": fetchMimoUsage,
  "xiaomi-token-plan-sgp": fetchMimoUsage,
  "xiaomi-mimo": fetchMimoUsage,
};

const SUPPORTED = Object.keys(FETCHERS).sort();

export function registerUsageCommand(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "Show provider quota / token plan usage for the active model",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const provider = ctx.model?.provider;
      if (!provider) {
        ctx.ui.notify("/usage: no active model", "warning");
        return;
      }

      const fetcher = FETCHERS[provider];
      if (!fetcher) {
        ctx.ui.notify(
          `/usage: provider "${provider}" not supported (supported: ${SUPPORTED.join(", ")})`,
          "warning",
        );
        return;
      }

      let data: UsagePanelData;
      try {
        data = await fetcher();
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = err instanceof Error && err.name === "AbortError"
          ? `usage request timed out after ${USAGE_FETCH_TIMEOUT_MS / 1000}s`
          : raw;
        ctx.ui.notify(`/usage: ${msg}`, "error");
        return;
      }

      // Intentional stdout: in RPC/headless mode there is no TUI to render to,
      // so plain text on stdout is the documented output channel.
      if (!ctx.hasUI) {
        console.log(renderUsagePlain(data));
        return;
      }

      await ctx.ui.custom<undefined>(
        (_tui, theme, _kb, done) => new UsagePanelComponent(theme, done, data),
        { overlay: true },
      );
    },
  });
}
