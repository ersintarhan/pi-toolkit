# pi-toolkit

Five independently toggleable Pi features plus an optional status display. **No providers, no runtime dependencies.**

| Feature | `pi config` resource |
|---|---|
| **Claude OAuth adapter** — makes `/model anthropic/...` work on an Anthropic OAuth session | `claude-oauth.ts` |
| **Native web search** — `web_search`, `web_fetch`, `/search`; seven backends plus DuckDuckGo fallback | `native-search.ts` |
| **Context management** — `context` tool (`anchor`, `view`, `pivot`, `recall`) plus its bundled skill | `context-management.ts` |
| **Context-window report** — `/context` | `context-report.ts` |
| **Provider quota** — `/usage` | `provider-usage.ts` |
| **Status display** — persistent context/anchor, search/fetch, and Claude OAuth footer text | `status-display.ts` |

> **Providers:** this package registers none. Pi 0.84 ships native MiniMax and Xiaomi catalogs — use those directly. For Kimi, install a dedicated package such as [`pi-provider-kimi-code`](https://github.com/Leechael/pi-provider-kimi-code); CrofAI likewise has its own. `/usage` still reports quota for all of them. See [Compatibility notes](#compatibility-notes) if you are coming from `xiaomi-mimo`.

## Install

```bash
pi install npm:@ersintarhan/pi-toolkit
```

Local development:

```bash
pi install .
```

## Feature toggles

Pi already ships the settings TUI this package needs:

```bash
pi config
```

Find `@ersintarhan/pi-toolkit`, then press Space to enable or disable an individual feature. Press Tab to switch between global and project-local settings, or start directly in project mode with `pi config -l`. Run `/reload` in an active Pi session after changing resources.

All features and the status display remain enabled by default. Disable `status-display.ts` to hide the footer text without disabling any tools, hooks, commands, dialogs, or notifications. The `context-management` skill is loaded by `context-management.ts`, so disabling that one resource disables both the tool hooks and its model instructions together.

> Upgrading from the old single `index.ts` resource? If you had disabled it in `pi config`, open the TUI once after upgrading and select the new resources; filters are path-based. The root `index.ts` remains a legacy all-in-one entry for direct loading—do not load it alongside the installed package.

| Another package already handles… | Disable |
|---|---|
| persistent toolkit footer text, or you prefer a clean footer | `status-display.ts` |
| `web_search`, `web_fetch`, or web-search routing | `native-search.ts` |
| anchors, context thinning, tree pivots, or Anthropic anchor caching | `context-management.ts` |
| Anthropic OAuth request/billing adaptation | `claude-oauth.ts` |
| `/context` reporting | `context-report.ts` |
| `/usage` reporting | `provider-usage.ts` |

## What this package does

### Claude OAuth adapter

When using `/model anthropic/...` with **Anthropic OAuth**:
- strips the Claude Code identity block
- injects the billing header Claude Code expects
- shows footer status like `✓ Claude OAuth ready/active` when `status-display.ts` is enabled
- docs re-injection is disabled by default (see `PI_CLAUDE_OAUTH_REINJECT_SCOPE`)

It only activates for the `anthropic` provider when OAuth is actually in use, and is otherwise a no-op.

### Native search

Adds:
- `web_search`
- `web_fetch`
- `/search`

Backends with native search:

| Backend | `/search provider` | Search | Fetch | Auth |
|---|---|:---:|:---:|---|
| ZAI (GLM) | `zai` | ✅ | — | `ZAI_API_KEY` |
| Google Gemini | `google` | ✅ | — | `GEMINI_API_KEY` |
| OpenAI | `openai` | ✅ | — | `OPENAI_API_KEY` |
| xAI (Grok) | `xai` | ✅ | — | `XAI_API_KEY` |
| Anthropic | `anthropic` | ✅ | — | `ANTHROPIC_API_KEY` |
| Claude Code (subscription) | `claude-bridge` | ✅ | ✅ | Claude CLI auth, via a global `pi-claude-bridge` install |
| Codex (ChatGPT) | `codex` | ✅ | — | `codex login` / `~/.codex/auth.json` |

Anything else — OpenRouter, DeepSeek, Groq, Kimi, MiniMax, Bedrock, Copilot and the rest — is recognized but has no native search, so it falls back to **DuckDuckGo**. A native backend that errors mid-request also falls back rather than failing the tool.

**`web_fetch` is plain HTTP for every backend except `claude-bridge`,** which is the only one with a native fetch path (and it falls back to HTTP if the bridge errors).

You can pin search to a provider independently from the active model.

Examples:

```bash
/search provider zai
/search provider openai
/search provider codex
/search provider auto
```

Or choose it from the TUI settings panel with `/search`.

> `claude-bridge` loads `@anthropic-ai/claude-agent-sdk` from a global `pi-claude-bridge` install (or Pi's `extensions/` directory) rather than bundling it. Without that package the backend reports `Could not locate @anthropic-ai/claude-agent-sdk`.

Outbound fetches are checked against private address ranges to block SSRF; set `PI_SEARCH_ALLOW_PRIVATE_HOSTS=1` only if you deliberately need to reach a local host.

### Context management

Adds the `context` tool with `view`, `recall`, `anchor`, and `pivot`, plus a bundled `context-management` skill that teaches the agent when to use each.

- **Anchors** are retrospective checkpoints, stored as ordinary session entries — no side database, so they survive resume and branch navigation.
- **Tool results before the last anchor are truncated out of the request.** The session file on disk keeps everything, but the running agent cannot pull that text back — there is no expand-back tool. An anchor's summary is the only surviving record of the work before it, which is why the skill insists summaries capture outcomes rather than topics.
- **`recall`** searches anchors across past sessions, scoped to the current cwd by default.
- **Anchor-aware prompt caching:** on Anthropic, the rolling cache marker is shifted onto the last anchor's block instead of a new marker being added, so truncation stops invalidating the prefix every turn. It follows Pi's own payload markers and `PI_CACHE_RETENTION`, and adds nothing when Pi supplies no marker or retention is `none`.
- An optional human-only TUI footer (`ctx … · anchor:…`) that is never sent to the model; disable `status-display.ts` to hide it.

### `/usage`

Shows quota / plan usage for the active provider. Works for providers this package does not register — install the provider you want, `/usage` still reports it.

| Provider | Credential | Endpoint |
|---|---|---|
| `kimi-coding` | `KIMI_API_KEY`, or Pi's stored OAuth credential | `api.kimi.com/coding/v1/usages` |
| `minimax` | `MINIMAX_API_KEY` | `api.minimax.io/v1/token_plan/remains` |
| `xiaomi`, `xiaomi-token-plan-{cn,ams,sgp}` | `XIAOMI_MIMO_SESSION_COOKIE` | `platform.xiaomimimo.com/api/v1/tokenPlan/usage` |
| `crofai` | `CROFAI_API_KEY` | `crof.ai/usage_api/` |

> The Xiaomi plan-usage endpoint sits behind Xiaomi SSO and rejects the `tp-...` API key, so it needs a browser session cookie rather than a key. To get it: open <https://platform.xiaomimimo.com>, DevTools → Network → copy the `Cookie` request header, then `export XIAOMI_MIMO_SESSION_COOKIE='<paste>'`.

```bash
/usage
```

### `/context`

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

Search is independent of the active model — code with one provider, search with another:

```bash
/model anthropic/claude-sonnet-4-6
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

Everything this package reads. Provider API keys are Pi's business, not this package's — the only credentials here are the ones `/usage` needs.

```bash
# Search backends (pick the ones you use)
export ZAI_API_KEY=...
export GEMINI_API_KEY=...
export OPENAI_API_KEY=...
export XAI_API_KEY=...
export ANTHROPIC_API_KEY=...
# claude-bridge uses the Claude CLI's own auth; codex uses `codex login`.

# /usage credentials
export KIMI_API_KEY=...                  # or rely on Pi's stored OAuth credential
export MINIMAX_API_KEY=...
export XIAOMI_MIMO_SESSION_COOKIE=...    # browser SSO cookie, not the tp-... key
export CROFAI_API_KEY=...

# Prompt-cache retention (the anchor cache follows Pi's payload markers)
export PI_CACHE_RETENTION=long           # long | short | none
export PI_ANCHOR_CACHE_TTL=1h            # explicit override: 1h | 5m
```

<details>
<summary>Claude OAuth adapter tuning</summary>

```bash
# Docs re-injection. Disabled by default: the docs block is stripped from the
# system prompt every turn, saving tokens and a cache breakpoint.
export PI_CLAUDE_OAUTH_REINJECT_SCOPE=never   # never | always | pi-only
export PI_CLAUDE_OAUTH_REINJECT_MODE=prepend-custom-message
                                              # none | prepend-custom-message
                                              # append-custom-message | user-reminder
export PI_CLAUDE_OAUTH_DOCS_FILE=/path/to/docs.md   # fallback docs source
export PI_CLAUDE_OAUTH_LOG_FILE=/path/to/adapter.log

# Identity the adapter reports upstream (falls back to CLAUDE_CODE_* if unset).
export PI_CLAUDE_CODE_ENTRYPOINT=...
export PI_CLAUDE_CODE_VERSION=...
```

</details>

<details>
<summary>Debugging and escape hatches</summary>

```bash
export PI_DEBUG=1                        # mirror toolkit logs to stderr
export PI_TOOLKIT_DEBUG=1                # same, toolkit-scoped
export PI_ANCHOR_CACHE_DEBUG=1           # log cache-marker layout per request
export PI_ANCHOR_CACHE_MARKER_BUDGET=4   # 1-4; Anthropic hard-fails at 5 markers
export PI_SEARCH_ALLOW_PRIVATE_HOSTS=1   # disable the SSRF guard on web_fetch
```

Logs are written per namespace to `<agent-dir>/logs/<namespace>.log`, honoring Pi's `PI_CODING_AGENT_DIR`.

</details>

## Compatibility notes

- **Coming from `xiaomi-mimo` or the bundled `minimax`?** Both registrations were removed in v0.9.0. Switch to Pi's native providers:

  | Was | Use instead |
  | --- | --- |
  | `minimax/*` | `minimax/*` (Pi native) |
  | `xiaomi-mimo/mimo-v2.5` | `xiaomi/*` |
  | `xiaomi-mimo/*` (regional) | `xiaomi-token-plan-{cn,ams,sgp}/*` |

  `XIAOMI_TOKEN_PLAN_API_KEY` and `XIAOMI_MIMO_BASE_URL` are no longer read.
- `kimi-coding` and `crofai` were removed in v0.7.2. Install dedicated provider packages; `/usage` still reports both.
- Do **not** install older overlapping Kimi provider forks alongside a dedicated Kimi provider package.
- Local `pi -e ...` development may behave differently from installed npm packages for skill loading.
- Codex search requires `codex login` first.
- Requires Pi 0.84+ (`pi-ai`, `pi-coding-agent`, `pi-tui`).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
