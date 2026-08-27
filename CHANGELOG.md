# Changelog

## Unreleased

- anchor-cache: post-anchor rolling cache markers are now clamped to `5m` TTL instead of inheriting the anchor's `1h` — they rewrite every turn, so the doubled 1h write premium is now paid once per anchor rather than per request. Stable-prefix (system/tools) markers keep the anchor TTL. Visible in `PI_ANCHOR_CACHE_DEBUG=1` output as split TTLs.

## 0.11.0

_2026-08-27_

### Added

- Expose Claude OAuth, native search, context management, `/context`, and `/usage`
  as separate package extension resources. Pi's native `pi config` TUI can now
  enable or disable each feature globally or per project.
- Add a separate `status-display.ts` resource that hides persistent context,
  anchor, search, fetch, and Claude OAuth footer text without disabling behavior.
- Load the bundled context-management skill from its owning extension, so the
  skill cannot remain active after the context tool and hooks are disabled.
- Restore auto-context's private `ExtensionRunner` patch on shutdown, so turning
  the feature off and reloading does not leave process-wide behavior behind.
- Refresh Pi to 0.84.3, Bun tooling to 1.4.0, oxlint to 1.80.0, and CI actions
  to their current major versions.

### Upgrade note

- A filter for the former single `index.ts` resource does not match the new
  resource paths. If it was disabled, rerun `pi config` after upgrading.

## 0.10.1

### Fixed

- **`recall` now finds sessions synced from another machine.** Scope matching
  compared the recorded cwd literally, so a session written on macOS
  (`/Users/me/proj`) was invisible from the same project on Linux
  (`/home/me/proj`) — the default `cwd` scope returned nothing, and only
  `scope="all"` reached it. Comparison is now home-relative.

  Only the current username's home is reconciled, so two accounts on one machine
  stay separate, and paths outside home are still matched literally.

  This is the session-content half of cross-machine sync; tools like
  [`pi-sync`](https://github.com/ersintarhan/pi-sync) already normalize the
  session *directory* name, but the `cwd` recorded inside the session file
  necessarily keeps the origin machine's path.

## 0.10.0

### Changed

- **Anchor truncation now drops reasoning from finished turns**, not just tool
  results. Old thinking is the noisiest thing left in the window: it is high
  volume, it is in the model's own voice, and it carries the dead ends the model
  already abandoned — which is exactly the residue that survived tool-result
  truncation. Measured over 33 real sessions, this roughly doubles what an
  anchor reclaims on `anthropic-messages` providers (−23.5% → −45.0% of
  conversation payload; Kimi and GLM land in the same range).

  Only entries ahead of the last anchor are touched, so the live tool-use loop
  is untouched. Anthropic requires a thinking block on the *final* assistant
  message, ahead of the lastmost `tool_use`/`tool_result` pair; blocks from
  earlier turns are recommended, not required. Blocks are removed whole rather
  than truncated, because the signature authenticates the content — a rewritten
  block is rejected, an absent one is not. A thinking-only assistant message is
  left alone, since emptying it would make the turn invalid.

  The point is attention rather than cost: a window half-filled with the model's
  own discarded reasoning reaches the compaction threshold twice as fast, and
  compaction is the lossy lever.

  **How much this matters depends on your model.** Claude Opus 4.5 changed the
  default so that thinking blocks from previous assistant turns are *preserved*
  in model context; earlier models have them stripped server-side. On a model
  that preserves them this removes reasoning the model was genuinely reading —
  measured at ~195K tokens in one long session. On a model that strips them it
  only saves wire traffic, and is harmless either way.

  **What this costs:** anchors stop being an index into intact history and
  become the record itself. Anthropic made preservation the default for a
  reason — seeing its own prior reasoning helps a model stay consistent across a
  long task — and that is what is being traded away. A summary that captures
  outcomes rather than topics is now load-bearing, not just good style.

## 0.9.1

Documentation only — no code changes. Published so the corrected README reaches
npm, where the package page renders from the released tarball.

### Documentation

- **The documented Xiaomi credentials for `/usage` were wrong.** The README
  listed `XIAOMI_API_KEY` and three `XIAOMI_TOKEN_PLAN_*_API_KEY` variables that
  nothing in this package reads, and omitted `XIAOMI_MIMO_SESSION_COOKIE`, which
  is what `/usage` actually requires — the plan-usage endpoint sits behind Xiaomi
  SSO and rejects the `tp-...` key. Following the old README could not work.
- The `/usage` table was missing `kimi-coding` and `crofai`, both still
  supported even though neither provider is registered here.
- The search table credited ZAI with native fetch. `claude-bridge` is the only
  backend with a native fetch path; everything else uses plain HTTP.
- `claude-bridge` resolves `@anthropic-ai/claude-agent-sdk` from a global
  `pi-claude-bridge` install rather than bundling it. That requirement was
  undocumented.
- Document the rest of the environment surface: `PI_SEARCH_ALLOW_PRIVATE_HOSTS`,
  the four `PI_CLAUDE_OAUTH_*` knobs, `PI_ANCHOR_CACHE_DEBUG`,
  `PI_ANCHOR_CACHE_MARKER_BUDGET`, and `PI_DEBUG` / `PI_TOOLKIT_DEBUG`.
- State the context-management tradeoff plainly: truncation is one-way for the
  running session, so an anchor's summary is the only surviving record of the
  work before it.
- Drop the "Provider usage" section and two duplicate copies of the migration
  note. It documented other packages' providers and model IDs that go stale.

## 0.9.0

The toolkit stops being a provider package. Pi 0.84 ships native MiniMax and
Xiaomi catalogs, so everything provider-shaped is gone and what remains is the
four things this package is actually for: the Claude OAuth adapter, native web
search, context management, and the `/usage` + `/context` commands.

### Removed

- **BREAKING — all bundled provider registrations.** `minimax` and `xiaomi-mimo`
  are no longer registered. Pi 0.84's native catalogs supersede both, and
  overriding `minimax` was actively hiding current models such as
  `MiniMax-M2.7-highspeed`.

  Migrate as follows:

  | Was | Use instead | Credential |
  | --- | --- | --- |
  | `minimax/*` | `minimax/*` (Pi native) | `MINIMAX_API_KEY` |
  | `xiaomi-mimo/mimo-v2.5` | `xiaomi/*` | `XIAOMI_API_KEY` |
  | `xiaomi-mimo/*` (regional) | `xiaomi-token-plan-{cn,ams,sgp}/*` | `XIAOMI_TOKEN_PLAN_{CN,AMS,SGP}_API_KEY` |

  `XIAOMI_TOKEN_PLAN_API_KEY` and `XIAOMI_MIMO_BASE_URL` are no longer read.
  For Kimi, install a dedicated package such as
  [`pi-provider-kimi-code`](https://github.com/Leechael/pi-provider-kimi-code).

- **The 875-line custom Anthropic stream fork** (`src/cached-anthropic-stream.ts`)
  and the direct `@anthropic-ai/sdk` dependency. All requests now go through
  Pi's maintained provider streams. **The package ships zero runtime
  dependencies.** The Claude OAuth adapter is unaffected — its protocol
  behavior is unchanged.

### Added

- Test coverage for the previously untested surfaces: native search routing and
  key resolution, the Claude OAuth adapter (billing header, identity cleanup,
  idempotency, non-OAuth no-op), anchor-cache TTL selection, `recall` scanning,
  `/context` accounting, and `/usage` rendering.
- Length bounds on `context` tool string parameters, so a runaway `summary` or
  `carryover` cannot balloon the request.
- `bun run check` (typecheck + lint + test) as the single entry point used by
  both CI and the publish workflow.
- A tracked `bun.lock`, with Bun pinned to 1.3.14 and `--frozen-lockfile`
  installs in CI and at publish time.

### Changed

- Toolkit logs honor Pi's public `PI_CODING_AGENT_DIR` instead of the
  undocumented `PI_HOME`.
- `assertPublicUrl` takes an explicit `allowPrivateHosts` argument rather than
  reading the environment internally, so the SSRF guard is testable without
  mutating process state. `PI_SEARCH_ALLOW_PRIVATE_HOSTS=1` still works as the
  default.
- After scheduling a pivot, the tool result and prompt guidance now tell the
  model to end the turn instead of chaining more tool calls into a branch that
  is about to be replaced.
- `oxlint` moved to 1.78.0. The old `^1.77.0` range already admitted it, so CI's
  frozen install and a plain `bun install` were resolving different linters.

### Fixed

- **`recall` no longer loses sessions written by older Pi releases.** Scoping by
  cwd used the active session directory, but Pi derives that directory name by
  encoding the cwd and the encoding has changed between releases — so one cwd
  can own several directories. Scanning stayed narrowed to the current one,
  hiding 35% of anchors on a real archive. Scope is now decided by each
  session's recorded header cwd again.
- Native search picked the wrong provider and model in several fallback paths,
  and resolved API keys inconsistently across backends. Responses are now read
  with an explicit size bound and aborts are honored mid-read.
- Deferred pivot state lived in module scope, so a hot reload produced parallel
  copies and could double-patch `ExtensionRunner`. State is now keyed on
  `globalThis` and the patch is marked idempotently.
- Anchor-cache TTLs are derived from Pi's payload markers and canonical
  retention setting instead of a hardcoded 5m with its own env override. This
  removes the mixed-TTL payloads Anthropic rejects, rather than working around
  them. Payloads with no marker, or `PI_CACHE_RETENTION=none`, are left alone.
- `/usage` no longer overflows narrow terminals.
- `/context` mis-attributed skills and sources: the `<available_skills>` block
  is now split out of the system prompt total, scoped packages report as
  `@scope/name` instead of `@scope`, and token estimates use Pi's own
  `estimateTokens` rather than a local approximation.

### Performance

- `recall` streams session files line by line instead of reading each one whole
  (peak RSS was ~1.86 GB on a large archive), and rejects sessions from other
  projects with a bounded read of the header line instead of parsing them.
  Measured on a 708 MB / 392-file archive: **1325 ms → 61 ms cold, 8 ms warm.**
- The anchor cache no longer carries a 256-entry cap. A full scan visits more
  files than that in a fixed order, so the cap evicted exactly the entries the
  next scan read first and every run missed. Entries removed from disk are
  pruned after each scan.

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
