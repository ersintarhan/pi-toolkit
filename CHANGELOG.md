# Changelog

## Unreleased

### Changed

- **Remove all bundled providers.** Pi 0.84 ships native MiniMax and Xiaomi catalogs and streams, so the toolkit no longer registers `minimax` or `xiaomi-mimo`. Migrate `xiaomi-mimo` selections to `xiaomi` or a regional `xiaomi-token-plan-*` provider.
- Map native Xiaomi provider IDs to the existing `/usage` fetcher.
- Remove the 875-line custom Anthropic stream and direct `@anthropic-ai/sdk` dependency. The Claude OAuth adapter remains enabled and unchanged.

### Fixed

- Keep `recall` scoped by the session's recorded cwd rather than the active session directory, so sessions written under an older cwd-encoding scheme stay visible. A bounded header probe keeps the wider scan cheap.
- Correct native search fallback/provider selection and hot-reload-safe context command state.
- Clamp `/usage` rendering to narrow terminals and correct `/context` skill/source accounting.
- Bound context-tool text inputs and honor `PI_CODING_AGENT_DIR` for toolkit logs.
- Align anchor-cache TTLs with native Pi payload markers and canonical retention settings.
- Pin Bun 1.3.14 with a fresh lockfile, frozen CI installs, and publish-time checks.

## 0.8.1

### Fixed

- Run pending auto-context pivots after Pi's `agent_settled` event instead of `agent_end`, ensuring retries, auto-compaction, follow-up messages, and continuation loops finish first.
- Retain the deferred `setTimeout(0)` execution so the private `navigateTree` operation runs outside extension event dispatch.

## 0.8.0

### Changed

- Update Pi peer dependencies (`pi-ai`, `pi-coding-agent`, `pi-tui`) from `^0.80.2` to `^0.84.0`.
- Update `@anthropic-ai/sdk` to `^0.115.0`, `@sinclair/typebox` to `^0.34.52`, and TypeScript to `^7.0.2`.
- Add the missing `oxlint` dev dependency used by the lint script.

### Fixed

- Replace the removed Pi 0.84 `AuthStorage` export with `readStoredCredential` in the usage command.

## 0.7.2

### Changed

- **Remove bundled providers**: `kimi-coding` and `crofai` providers have been removed from `@ersintarhan/pi-toolkit`. The package now only registers `minimax` and `xiaomi-mimo` providers.
- **README updated** to document the removal and point users to the dedicated [`pi-provider-kimi-code`](https://github.com/Leechael/pi-provider-kimi-code) package for Kimi.

### Notes

- The Claude OAuth adapter, native search, context management (`/context`, anchors), and usage slash command remain unchanged.
- `src/providers/` directory is removed.

## 0.7.1

### Fixed

- `src/providers/kimi.ts`: the `streamSimple` import from the `@earendil-works/pi-ai/api/openai-completions` subpath broke pi's extension loader, which mis-resolves static `pkg/subpath` imports into a bogus `dist/compat.js/api/...` path and failed to load the extension at startup. Switched to a lazy dynamic `import()` resolved by Node's native ESM resolver, which bypasses the loader bug. (The openai-completions path is only reached when `KIMI_CODE_PROTOCOL=openai`; the default remains anthropic-messages.)

## 0.7.0

### Changed

- Update dependencies: `@anthropic-ai/sdk` 0.104.1 -> 0.106.0, peer deps pinned to `@earendil-works/pi-ai`/`pi-coding-agent`/`pi-tui` `^0.80.2` (required for the api subpath imports) and `@sinclair/typebox` `^0.34.49`.

### Fixed

- `src/providers/kimi.ts`: replace the removed top-level `streamSimpleOpenAICompletions` import with the modern `streamSimple` from `@earendil-works/pi-ai/api/openai-completions`, fixing the CI typecheck failure (`TS2305: no exported member`) on pi-ai 0.80.x.

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
