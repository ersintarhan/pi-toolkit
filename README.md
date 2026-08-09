# pi-toolkit

All-in-one pi extension toolkit.

Includes:
- **Claude OAuth adapter** for Anthropic OAuth sessions
- **One-release compatibility alias**: deprecated `xiaomi-mimo`
- **Native web search** with multiple backends + provider override
- **Context management** (`anchor`, `view`, `pivot`, `recall`)

> **Note:** The `kimi-coding` and `crofai` providers have been moved out of this package. For Kimi, install the dedicated provider such as [`pi-provider-kimi-code`](https://github.com/Leechael/pi-provider-kimi-code). CrofAI can be installed from its own package when needed.

## Install

```bash
pi install npm:@ersintarhan/pi-toolkit
```

Local development:

```bash
pi install .
```

## What this package does

### 1. Provider migration

Pi 0.84 supplies the current native MiniMax and Xiaomi catalogs and streams. This package no longer overrides `minimax`; use Pi's native provider so models such as `MiniMax-M2.7-highspeed` remain visible.

Native Xiaomi providers are recommended: `xiaomi`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-ams`, or `xiaomi-token-plan-sgp`. The package registers only `xiaomi-mimo` as a deprecated, one-release compatibility alias. It uses Pi's native `anthropic-messages` stream and exposes only `mimo-v2.5` and `mimo-v2.5-pro`.

For Kimi, use an external Kimi provider package (e.g. [`pi-provider-kimi-code`](https://github.com/Leechael/pi-provider-kimi-code)).

### 2. Streaming and cache behavior

MiniMax, native Xiaomi, and the compatibility alias use Pi 0.84's maintained provider streams. The former custom Anthropic SDK stream and its cache overrides have been removed. Anchor caching follows native payload markers and `PI_CACHE_RETENTION`; it does not add caching when Pi supplies no marker or retention is `none`.

### 3. Claude OAuth adapter

When using `/model anthropic/...` with **Anthropic OAuth**:
- strips the Claude Code identity block
- injects the billing header Claude Code expects
- shows footer status like `✓ Claude OAuth ready/active`
- docs re-injection is disabled by default

### 4. Native search

Adds:
- `web_search`
- `web_fetch`
- `/search`

Supported native search backends:

| Backend | Search | Fetch | Auth |
|---|---|---|---|
| ZAI (GLM) | ✅ | ✅ | `ZAI_API_KEY` |
| Google Gemini | ✅ | ❌ | `GEMINI_API_KEY` |
| OpenAI | ✅ | ❌ | `OPENAI_API_KEY` |
| xAI | ✅ | ❌ | `XAI_API_KEY` |
| Anthropic | ✅ | ❌ | `ANTHROPIC_API_KEY` |
| Claude Code bridge | ✅ | ✅ | Claude CLI auth |
| Codex / ChatGPT | ✅ | ❌ | `codex login` / `~/.codex/auth.json` |
| Fallback | DuckDuckGo | HTTP fetch | none |

You can pin search to a provider independently from the active model.

Examples:

```bash
/search provider zai
/search provider openai
/search provider codex
/search provider auto
```

Or choose it from the TUI settings panel with `/search`.

### 5. Context management

Adds the `context` tool with:
- `view`
- `recall`
- `anchor`
- `pivot`

Also includes:
- a human-only TUI footer (`ctx … · anchor:…`) that is never sent to the model
- tool-result truncation before the last anchor
- anchor-aware cache support in the integrated context flow

## Provider usage

### MiniMax (Pi native)

```bash
/model minimax/MiniMax-M2.7
/model minimax/MiniMax-M2.7-highspeed
```

Requires `MINIMAX_API_KEY`.

### Xiaomi MiMo (Pi native, recommended)

Use `xiaomi` with `XIAOMI_API_KEY`, or a regional token-plan provider:

- `xiaomi-token-plan-cn` / `XIAOMI_TOKEN_PLAN_CN_API_KEY`
- `xiaomi-token-plan-ams` / `XIAOMI_TOKEN_PLAN_AMS_API_KEY`
- `xiaomi-token-plan-sgp` / `XIAOMI_TOKEN_PLAN_SGP_API_KEY`

The deprecated `xiaomi-mimo` alias remains for one release:

```bash
/model xiaomi-mimo/mimo-v2.5
/model xiaomi-mimo/mimo-v2.5-pro
```

It preserves `XIAOMI_TOKEN_PLAN_API_KEY`, optional `XIAOMI_MIMO_BASE_URL`, and the Singapore Anthropic-compatible default endpoint. Migrate to a native provider above; old V2 models are no longer exposed.

### Kimi

The `kimi-coding` provider is no longer bundled. Install a dedicated Kimi provider package, for example:

```bash
pi install npm:pi-provider-kimi-code
# or via local path
pi -e /path/to/pi-provider-kimi-code
```

Then select Kimi as usual:

```bash
/model kimi-for-coding
```

> The upstream [`pi-provider-kimi-code`](https://github.com/Leechael/pi-provider-kimi-code) package is actively maintained and supports Kimi model discovery, OAuth, file uploads, and Kimi-specific payload mutations.

## `/usage` command

Shows quota / plan usage for the active provider.

Supported:

| Provider | Endpoint |
|---|---|
| `minimax` | `https://api.minimax.io/v1/token_plan/remains` |
| `xiaomi`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-sgp`, `xiaomi-mimo` | `https://platform.xiaomimimo.com/api/v1/tokenPlan/usage` |

Examples:

```bash
/usage
```

## `/context` command

Shows current context-window usage without adding the generated report to future LLM context.

It includes:

- total context usage and model window
- estimated category breakdown
- active tools and slash commands
- extension allocation by source/package
- cache read/write and cost stats

Example:

```bash
/context
```

## Search override examples

Use MiniMax for coding, but ZAI for search:

```bash
/model minimax/MiniMax-M2.7-highspeed
/search provider zai
```

Use any model, but force Codex web search:

```bash
/search provider codex
```

Return to auto-detect:

```bash
/search provider auto
```

## Context workflow examples

Anchor after a completed phase:

```text
context(anchor, name="search-setup", summary="Search override configured to use ZAI.")
```

Pivot back to a clean checkpoint:

```text
context(pivot, target="search-setup", carryover="Search override is stable; Claude OAuth adapter handles Anthropic billing header.")
```

## Environment summary

Common env vars:

```bash
# MiniMax
export MINIMAX_API_KEY=...

# Xiaomi MiMo (native providers recommended)
export XIAOMI_API_KEY=...
export XIAOMI_TOKEN_PLAN_CN_API_KEY=...
export XIAOMI_TOKEN_PLAN_AMS_API_KEY=...
export XIAOMI_TOKEN_PLAN_SGP_API_KEY=...

# Deprecated xiaomi-mimo compatibility alias (one release)
export XIAOMI_TOKEN_PLAN_API_KEY=...
export XIAOMI_MIMO_BASE_URL=...

# Search backends
export ZAI_API_KEY=...
export GEMINI_API_KEY=...
export OPENAI_API_KEY=...
export XAI_API_KEY=...
export ANTHROPIC_API_KEY=...

# Pi prompt-cache retention (anchor cache follows native payload markers)
export PI_CACHE_RETENTION=long # long, short, or none
# Legacy explicit override, retained for compatibility
export PI_ANCHOR_CACHE_TTL=1h # 1h or 5m
```

## Compatibility notes

- Migrate `xiaomi-mimo` selections and credentials to a Pi-native Xiaomi provider; the alias is deprecated and retained for one release only.
- Do **not** install older overlapping Kimi provider forks at the same time as a dedicated Kimi provider package.
- Local `pi -e ...` development may behave differently from installed npm packages for skill loading.
- Codex search requires `codex login` first.
- Claude OAuth adapter only activates for the `anthropic` provider when OAuth is actually in use.
- The `kimi-coding` and `crofai` providers were removed in v0.7.2. Use dedicated provider packages for them.

## Changelog

- **0.5.9** — Enforce Anthropic cache-control marker budget; lower default anchor-cache budget to 3.
- **0.5.8** — Stop copying `cache_control` onto synthetic Claude OAuth prompt block; strip foreign thinking signatures on provider switch.
- **0.5.7** — Guard Kimi stream bootstrap; restrict native web fetch to `http`/`https`.
- **0.5.6** — Show `toolShare=` only when tool-output share exceeds 50%.
- **0.5.5** — Add `/context` command for context-window usage reporting.
- **0.5.4** — Initial public release of `@ersintarhan/pi-toolkit`.

Full details: [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
