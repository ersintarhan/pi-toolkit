# pi-toolkit

All-in-one pi extension toolkit.

Includes:
- **Providers**: `kimi-coding`, `minimax`, `xiaomi-mimo`, `crofai`
- **Cache optimization** for Anthropic-compatible providers
- **Claude OAuth adapter** for Anthropic OAuth sessions
- **Native web search** with multiple backends + provider override
- **Context management** (`anchor`, `view`, `pivot`, `recall`)

## Install

```bash
pi install npm:@ersintarhan/pi-toolkit
```

Local development:

```bash
pi -e /Users/ersin/Projects/pi-extensions/pi-toolkit
```

## What this package does

### 1. Provider registration

Registers these providers:

| Provider | API | Notes |
|---|---|---|
| `kimi-coding` | Anthropic-compatible or OpenAI mode | OAuth, API key fallback, image/video upload, Kimi-specific payload mutations |
| `minimax` | Anthropic-compatible | Cache-fixed stream path |
| `xiaomi-mimo` | Anthropic-compatible | Cache-fixed stream path, MiMo quirks handled |
| `crofai` | OpenAI-compatible | Dynamic model list, usage support |

### 2. Cache optimization

For Anthropic-compatible providers (`kimi-coding`, `minimax`, `xiaomi-mimo`), this package uses a custom cached stream implementation derived from the better-messages-cache approach.

It does three things:
- marks the last assistant `tool_use` block
- marks the last user block
- repairs partial/invalid streaming JSON during tool call parsing

This keeps cache loss lower across long agentic turns.

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
- status line (`context=`, `tool=`, `anchor=`)
- tool-result truncation before the last anchor
- anchor-aware cache support in the integrated context flow

## Provider usage

### Kimi

```bash
/model kimi-coding/kimi-for-coding
```

Auth options:
- `KIMI_API_KEY`
- `/login kimi-coding` OAuth

Optional:
- `KIMI_CODE_PROTOCOL=openai`
- `KIMI_CODE_MODEL=<model>`

### MiniMax

```bash
/model minimax/MiniMax-M2
```

Requires:
- `MINIMAX_API_KEY`

### Xiaomi MiMo

```bash
/model xiaomi-mimo/mimo-v2.5
/model xiaomi-mimo/mimo-v2.5-pro
```

Requires:
- `XIAOMI_TOKEN_PLAN_API_KEY`

Optional region override:

```bash
export XIAOMI_MIMO_BASE_URL=https://token-plan-ams.xiaomimimo.com/anthropic
```

### CrofAI

```bash
/model crofai/openai/gpt-4o
```

Requires:
- `CROFAI_API_KEY`

Models are fetched dynamically from:
- `https://crof.ai/v1/models`

## `/usage` command

Shows quota / plan usage for the active provider.

Supported:

| Provider | Endpoint |
|---|---|
| `kimi-coding` | `https://api.kimi.com/coding/v1/usages` |
| `minimax` | `https://api.minimax.io/v1/token_plan/remains` |
| `xiaomi-mimo` | `https://platform.xiaomimimo.com/api/v1/tokenPlan/usage` |
| `crofai` | `https://crof.ai/usage_api/` |

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

Use Kimi for coding, but ZAI for search:

```bash
/model kimi-coding/kimi-for-coding
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
context(anchor, name="crofai-added", summary="CrofAI provider added with dynamic models and usage support.")
```

Pivot back to a clean checkpoint:

```text
context(pivot, target="crofai-added", carryover="Search override added later; CrofAI implementation is stable.")
```

## Environment summary

Common env vars:

```bash
# Kimi
export KIMI_API_KEY=...
export KIMI_CODE_PROTOCOL=anthropic

# MiniMax
export MINIMAX_API_KEY=...

# Xiaomi MiMo
export XIAOMI_TOKEN_PLAN_API_KEY=...
export XIAOMI_MIMO_BASE_URL=...

# CrofAI
export CROFAI_API_KEY=...

# Search backends
export ZAI_API_KEY=...
export GEMINI_API_KEY=...
export OPENAI_API_KEY=...
export XAI_API_KEY=...
export ANTHROPIC_API_KEY=...
```

## Compatibility notes

- Do **not** install older overlapping Kimi provider forks at the same time.
- Local `pi -e ...` development may behave differently from installed npm packages for skill loading.
- Codex search requires `codex login` first.
- Claude OAuth adapter only activates for the `anthropic` provider when OAuth is actually in use.

## Changelog

### 0.5.4
- package renamed to **`@ersintarhan/pi-toolkit`**
- CrofAI provider added
- Claude OAuth adapter merged
- native search merged
- Codex / ChatGPT search backend added
- search provider override added (including TUI selection)
- pi-auto-context integrated
- cache TTL upgraded to `1h`
- status line simplified
- skill metadata added

### 0.5.3
- search provider override
- Codex backend

### 0.5.2
- native search merged

### 0.5.1
- Claude OAuth adapter merged

### 0.5.0
- CrofAI provider added

## License

MIT
