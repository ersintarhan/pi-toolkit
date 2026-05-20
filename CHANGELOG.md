# Changelog

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
