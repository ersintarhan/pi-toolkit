# Changelog

## 0.6.1

### Fixed

- Remove the `[pi-auto-context]` model-facing status note that was appended to the last user message on every turn. It distracted the agent (spurious compaction urges, anchor confusion). The TUI footer status and tool-result truncation are unchanged (human-facing only, never sent to the model).

## 0.6.0

### Changed

- Enable TypeScript strict mode across the codebase; `streamSimpleKimi` now accepts `Model<Api>` and the dead `tools` parameter was dropped from `convertMessages`.
- Bump `@anthropic-ai/sdk` from 0.100.1 to 0.104.1.
- Split the `index.ts` monolith (1175 -> 117 lines) into focused modules: `src/providers/kimi.ts` and `src/providers/crofai.ts`.
- Replace 21 `console.*` call sites with a best-effort `src/logger.ts` that only writes to the log file and optionally mirrors to stderr under `PI_DEBUG`.

### Fixed

- `claude-oauth-adapter`: docs re-injection moved from the `context` event to the `before_provider_request` payload level, fixing a leak where `{role:custom, display:false}` messages surfaced in the input editor (removes ~190 lines of custom-message helpers).
- `fetchUsage` now uses a bounded timeout instead of hanging indefinitely.
- `resolveCacheTTL` is hoisted so it runs once instead of being recomputed 3x per turn.
- CrofAI provider registration is now guarded against re-registration.

### Performance

- `_anchorCache` is bounded with a 256-session LRU to cap memory growth.

## 0.5.12

### Fixed

- Convert thinking blocks from a different provider into plain text when targeting Anthropic, fixing `400 Invalid signature` errors on mid-session provider switches (e.g. Kimi -> Anthropic Opus).

## 0.5.11

### Changed

- Update provider `apiKey` env-var references to the new `$ENV_VAR` format required by pi v0.78.1, removing startup deprecation warnings for Kimi, MiniMax, Xiaomi MiMo, and CrofAI registrations.

## 0.5.10

### Added

- Add `minimax/MiniMax-M3` to the built-in MiniMax provider catalog with 1M context-window metadata.

### Changed

- Harden native web fetch against SSRF and unsafe redirect targets.
- Improve auto-context pivot/input-editor restore behavior and add test/CI coverage around the toolkit flows.

## 0.5.9

### Changed

- Always enforce the Anthropic cache-control marker budget even when the latest anchor is not present in the payload.
- Lower the default anchor-cache marker budget to 3 so one slot remains available for downstream/final request mutations.

## 0.5.8


### Changed

- Stop copying `cache_control` markers onto the synthetic Claude OAuth prompt block to avoid Anthropic's 4-block cache limit.
- Strip foreign Anthropic thinking signatures when forwarding prior reasoning to Kimi/MiMo across provider switches.

## 0.5.7


### Changed

- Guard Kimi stream bootstrap with an outer catch to avoid unhandled async IIFE failures.
- Restrict native web fetch URLs to `http` and `https` protocols.

## 0.5.6


### Changed

- Show `toolShare=` in the auto-context status line only when tool-output share exceeds 50%.

## 0.5.5


### Added

- Add `/context` command for visual context-window usage reporting.
- Exclude `/context` reports from future LLM context to avoid prompt bloat.
- Show compaction summaries separately in the context breakdown.

## 0.5.4

### Added

- Initial public release of `@ersintarhan/pi-toolkit`.
- Provider registrations for `kimi-coding`, `minimax`, `xiaomi-mimo`, and `crofai`.
- Cache optimization for Anthropic-compatible providers.
- Claude OAuth adapter support.
- Native web search with multiple backends and provider override.
- Context management tools: `anchor`, `view`, `pivot`, `recall`.
- `/usage` command for provider usage summaries.
