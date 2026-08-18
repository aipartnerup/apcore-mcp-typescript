# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.18.0] - 2026-08-19

### Security

- **`__apcore_module_preview` no longer discloses module introspection to a
  caller the ACL denied.** The bridge serialises `Executor.validate()`'s
  `PreflightResult` verbatim, and apcore-js `<=0.26.0` gated
  `Module.preflight()` / `Module.preview()` on module lookup alone — pipeline
  Step 3 — while the ACL check is Step 4. A denied caller therefore ran
  module-authored code and received what it returned: for a command-wrapping
  module the resolved binary and its argv, for a writer the target of the side
  effect. Raising the `apcore-js` floor to `>=0.27.0` closes it at the layer
  that owns the gate (PROTOCOL_SPEC §12.8.5.1, spec v1.13.0, apcore#96); no
  bridge code changed. A denied caller still receives the failed `acl` check, so
  it still learns why. Pinned by `tests/server/preflightDisclosure.test.ts`,
  which drives a real `Executor` over a real `Registry` and a real `ACL` and
  asserts a sentinel binary path and argv appear nowhere in the denied envelope.

### Changed

- **Required `apcore-js` floor raised to `>=0.27.0`.** Of the 0.27 breaking
  changes, only the `validate()` disclosure gate above reaches this package: the
  bridge does not construct pipelines from YAML, does not use
  `SchemaValidator`'s coercion knob, does not configure `obs.redaction`, and
  registers no `StepMiddleware`.

## [0.17.2] - 2026-07-14

Patch release. Fixes the MCP elicitation approval flow and bumps the required `apcore-js` floor to `0.26.0`.

### Fixed

- **`ElicitationApprovalHandler` now sends a non-empty elicitation `requestedSchema`.** The approval elicitation was previously sent with an empty schema; minimal SDK clients tolerate this, but clients that render an approval form (Cursor, Codex, ...) ignore or reject an empty schema, so the request returned no response and the gate failed closed. The handler now sends an object schema with a boolean `approve` field and honors an explicit `approve: false` from the form. Mirrors apcore-mcp (Python) 0.17.2.

### Changed

- **Required `apcore-js` floor raised to `>=0.26.0`** to align the ecosystem on the 0.26.0 governance layer.

## [0.17.1] - 2026-07-07
update package dependency version for apcore-toolkit (0.10.0) and increment project patch version


## [0.17.0] - 2026-06-23

Audit-driven hardening of the serve/embed entry points and the Phase B approval
chain, plus the apcore-js 0.25 / apcore-toolkit 0.9.1 dependency uplift.

### Added

- **Low-level `serve()` / `asyncServe()` now accept `approvalStore` /
  `approvalNotify`** and drive the store lifecycle (`start()` before transport,
  `stop()` on shutdown / `close()`), so Phase B async approval is usable without
  the `APCoreMCP` class. This also fixes a latent leak: a manually built store
  passed via `serve()` previously never had its sweep timer started, so records
  grew unbounded.
- **`APCoreMCP` class reaches the full serve surface**: `APCoreMCPOptions` gained
  `strategy`, `redactOutput`, `outputFormat`, and `trace`;
  `APCoreMCPServeOptions` / `AsyncServeOptions` gained `dynamic` (runtime tool
  registration) — all now forwarded.
- Optional `start?()` / `stop?()` on the `ApprovalStore` interface to match the
  duck-typed lifecycle already honored at runtime.

### Fixed

- **`outputFormat` now fails fast**: requesting `csv` / `jsonl` when
  apcore-toolkit is unavailable throws a clear error instead of silently
  returning an empty string to the model (silent data loss).

### Changed

- Documented `outputFormat: "json"` as a native `JSON.stringify` no-op (it does
  not route through apcore-toolkit).
- Raised dependency floors to `apcore-js>=0.25.0` and `apcore-toolkit>=0.9.1`
  (drop-in; no consumed API changed). All 615 tests pass.


## [0.16.1] - 2026-06-18

### Changed
- Removes local CancelToken implementation and re-exports from apcore-js
- Updates trace ID validation and generation to use W3C 32-hex format matching apcore
- Updates JSDoc comments to reflect the new context implementation
- Fixes drift between bridge trace IDs and apcore's enforced W3C format

## [0.16.0] - 2026-06-12

### Added

- **Approval Phase B: async polling via `__apcore_approval_check` meta-tool**.
  apcore-mcp now supports out-of-band human approvals that do not block the MCP connection.

  New public API:
  - `ApprovalStore` (interface) — pluggable persistence; three async methods:
    `savePending`, `getResult`, `resolve`.
  - `InMemoryApprovalStore` — in-process implementation for testing/local dev.
    Bounded memory: per-record TTL via `setTimeout`, background `setInterval` sweep
    (`.unref()`'d to not block process exit), and `maxRecords` hard cap.
    **Not suitable for production.**
  - `StorageBackedApprovalHandler` — writes pending records on `requestApproval()`,
    reads them on `checkApproval()`. Optional `notifyCallback` for Slack/email/webhooks.
  - `ApprovalBridge` — registers `__apcore_approval_check` as an MCP meta-tool,
    symmetric with `AsyncTaskBridge`.

  Usage:
  ```typescript
  import { APCoreMCP, InMemoryApprovalStore } from "apcore-mcp";

  const store = new InMemoryApprovalStore();
  const mcp = new APCoreMCP(registry, { approvalStore: store });

  // External system approves out-of-band:
  await store.resolve(approvalId, { approved: true });
  ```

  Phase A (`ElicitationApprovalHandler`) is unchanged.

Closes [issue #70](https://github.com/aiperceivable/apcore/issues/70): remove bridge-level `userFixable` stamping now that apcore-js 0.24.0 resolves it at construction time.

### Changed

- **Raised apcore-js floor to `>=0.24.0`** (`package.json`). apcore-js 0.24.0 introduced the `userFixable` field on `ModuleError` (resolved by `_USER_FIXABLE_BY_CODE` at construction) for all user-actionable codes.
- **Removed bridge-level `userFixable: true` stamps** from `_matchApcoreErrorInstance` and the duck-typing fallback block in `src/adapters/errors.ts`. The three removed branches covered `DependencyNotFoundError`, `DependencyVersionMismatchError`, `VersionConstraintError` (instanceof path) and `DEPENDENCY_NOT_FOUND | DEPENDENCY_VERSION_MISMATCH`, `VERSION_CONSTRAINT_INVALID | BINDING_SCHEMA_*` (duck-typed path). `userFixable` now flows through the existing `_attachAiGuidance` path. All 582 tests pass.

## [0.15.0] - 2026-05-29

Audit-driven consistency work from `/apcore-skills:audit --scope mcp`. Nine TypeScript-side fixes land here; the docs/spec repo (`apcore-mcp/`) remains at 0.15.0 because no spec contracts changed, so SDK versions also stay at 0.15.0 pending an explicit release decision. The entries below describe changes already committed on `main`.

### Changed

- **Upgraded required runtime to apcore-js 0.22.0 and apcore-toolkit 0.8.0** (`package.json`). Adopts the apcore-js 0.22.0 real-interrupt cancellation contract (D-18): the bridge `CancelToken` is now backed by an `AbortController` and exposes `signal`, and `BridgeContext` exposes a `signal: AbortSignal` (the bound token's signal, or a shared never-aborted fallback) so modules performing Web-API I/O (`fetch`, `setTimeout` via `AbortSignal.timeout`, Web Streams) participate in real abort on inbound MCP `notifications/cancelled` — previously only cooperative `isCancelled` polling worked. No public API change; full suite green (582 passed, incl. 4 new D-18 signal tests).

### Breaking Changes

- **[D11-2] `/usage` removed from `DEFAULT_EXEMPT_PATHS` in `auth/middleware.ts`.** Previously `DEFAULT_EXEMPT_PATHS = {"/health", "/metrics", "/usage"}` — `/usage` was unauthenticated by default in TypeScript, but Python and Rust used `{"/health", "/metrics"}` and would 401 the same request when `require_auth=true`. The `/usage` endpoint now requires authentication by default. Callers who want it exempt must opt-in explicitly via `exemptPaths`.

### Fixed

- **[D11-1] Auth middleware now hydrates identity on exempt paths (best-effort).** Previously `/health`, `/metrics`, and `/usage` early-returned without invoking the authenticator, so `getCurrentIdentity()` returned `null` inside the exempt-route handler even when a valid `Authorization: Bearer …` header was present. Python and Rust have always done best-effort identity extraction on exempt paths. The authenticator is now called inside a try/catch (log + continue on error) and the resolved identity is bound to the per-request `identityStorage` context before `next(req, res)` runs.
- **[D11-3] `tryDenormalize` now accepts underscore-bearing module IDs to match Python and Rust.** The previous inline regex (`^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$`) rejected the underscore class, so input `"my_mod-v2"` returned `null` in TypeScript while Python and Rust returned `"my_mod.v2"`. Now uses the shared `MODULE_ID_PATTERN` (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`) on the dash→dot candidate.
- **[D11-4] `_ensureObjectType` upgrades `type` to `"object"` when `properties` is present.** Previously TypeScript early-returned the schema unchanged whenever `type` was defined, leaving `{type: "string", properties: {...}}` as-is; Python and Rust force `type: "object"` so the strict pass can inject `additionalProperties: false`. TypeScript now matches.
- **[D10-002] `MCPServerFactory.createServer(name)` validates non-empty + max 255 chars per spec.** Throws an `Error` for empty / oversized names. Cross-SDK parity with the matching fix in Python and Rust.
- **[D10-003] `ErrorMapper.toMcpError` for `APPROVAL_PENDING` now only accepts the canonical `approval_id` source key.** Previously TypeScript accepted both `approvalId` and `approval_id`; Python and Rust accepted snake_case only. The `approvalId` branch is dropped — upstream apcore SDKs always emit snake_case, so this is a no-op for production callers.

### Refactored

- **[D9-003] Removed orphan `createAuthMiddleware` factory.** Previously exported from `src/auth/middleware.ts:119` with a 74-LOC body, deliberately not re-exported from `src/index.ts` (per A-D-230). Zero production callers in `src/` or `examples/`; only its own unit tests referenced it. Deleted along with `tests/auth/middleware.test.ts`. The A-D-230 comments in `src/auth/index.ts` now flag the factory as removed pending real `asyncServe` wiring.
- **[D9-005] Deleted `src/explorer/` and `src/inspector/` TODO-only stub directories.** Both were 3-line files (`// TODO: Port from apcore-mcp-python\nexport {};`) with zero importers. Will be re-created when the ports actually begin.
- **[D9-010] Relocated `planning/` to `docs/history/planning/`.** Sixteen plan files plus `state.json` with every feature `"status": "completed"` were sitting at top level — long since shipped. Moved out of the project root so the published package surface is cleaner.

### Known Issues

- **[D10-004]** Audit flagged a defensive-depth divergence: TypeScript rejects whitespace-only hosts via `host.trim().length === 0`, while Python and Rust accept whitespace and fail later at bind. The fix actually belongs in Python and Rust (tighten their validation). Tracked for the next round.


Leverages **apcore-js 0.21.1 + apcore-toolkit 0.7.0**. Cross-SDK byte-
equivalent with `apcore-mcp-python` and `apcore-mcp-rust` 0.15.0.

### Changed

- **Dependency bump**: `apcore-js >= 0.21.1` (was `>= 0.19.0`); `apcore-toolkit >= 0.7.0` (was `>= 0.5.0`, kept as `optionalDependencies`).

### Added

- **Built-in output format support**: Added `--output-format` (`json`, `csv`, `jsonl`) to CLI and `outputFormat` option to `serve()`. Leverages `apcore-toolkit` 0.7 for standard tabular formatting.
- **`__apcore_module_preview` meta-tool** (apcore 0.21 PROTOCOL_SPEC §5.6 / §12.8) — fifth reserved meta-tool alongside the four `__apcore_task_*` ones. New `META_TOOL_NAMES.PREVIEW` constant. The handler drives `executor.validate(moduleId, inputs, context)` and returns a `{valid, requires_approval, predicted_changes, checks}` envelope WITHOUT executing the module. PreflightResult fields are normalized from camelCase (`requiresApproval`, `predictedChanges`) to snake_case to match the cross-SDK wire shape Python and Rust emit. `arguments: null` and missing `arguments` are both preserved as `null` (the calling business decides whether null is acceptable); structurally-wrong shapes (arrays, scalars) throw `__apcore_module_preview requires \`arguments\` to be a JSON object or null`. Returns `{error: "PREVIEW_UNAVAILABLE"}` envelope when the bridge was constructed without an `executor`.
- **`MCPServerFactory({ richDescription: true })` + `MCPServerFactory.prepare()` static method** — when `richDescription` is on, `buildTool` renders `Tool.description` as canonical apcore-toolkit Markdown (`formatModule({ style: "markdown" })`) instead of the plain one-line description. Includes title, description, parameters list, returns list, behavior table (only fields differing from defaults — toolkit 0.6 alignment), tags, and examples. LLMs select tools primarily from this string; Markdown packs more decision signal per token. Display-overlay `mcp.description` overrides still win first. The static `MCPServerFactory.prepare()` async method primes the toolkit cache so subsequent synchronous `buildTool` calls can render Markdown without re-importing the optional dependency. One-shot `console.warn` when `apcore-toolkit` is missing.
- **`OpenAIConverter` `richDescription` option** — same Markdown rendering for OpenAI tool definitions. Accepted on both `convertRegistry({ richDescription: true })` and `convertDescriptor({ richDescription: true })`. Pairs with `await primeMarkdownToolkit()` for sync rendering.
- **`src/markdown.ts` module** — public exports: `isMarkdownAvailable()`, `primeMarkdownToolkit()` (eagerly load apcore-toolkit so `isMarkdownAvailable` returns sync truth), `renderModuleMarkdown(descriptor)` (async — loads toolkit on demand), `renderModuleMarkdownSync(descriptor)` (sync — requires prior priming).
- **`ErrorCodes.CIRCUIT_BREAKER_OPEN` mapping** (apcore 0.20 sync alignment A-001) — `ErrorMapper.toMcpError` dispatches the breaker-open code to a retryable=true envelope with `aiGuidance` mirrored from the apcore error class (or a generic recovery hint when absent).

### Tests

- +9 new tests covering `__apcore_module_preview` (basic predict, camelCase→snake_case normalization, missing executor → PREVIEW_UNAVAILABLE, missing module_id, `arguments: null` preserved, missing arguments preserved, array rejection, isMetaTool recognition), `CIRCUIT_BREAKER_OPEN` mapping (retryable + aiGuidance, custom-guidance preservation), and `richDescription` on factory + converter (Markdown rendering, display-overlay override, plain fallback).
- Total suite: **549 passed** (was 534).

## [0.14.0] - 2026-05-01

### Changed

- **Dependency bump**: `apcore-js >= 0.19.0` (was `>= 0.18.0`). Picks up the expanded 12-field `ModuleAnnotations`, `auto_schema` modes, `spec_version` in binding YAML, and new dependency/binding error classes (see apcore-js 0.19.0 CHANGELOG).
- **New dependency**: `apcore-toolkit >= 0.5.0` — provides `BindingLoader`, `BindingParser`, and `ScannedModule.display` for consumers that load `.binding.yaml` files.
- `BridgeContext` now accepts an optional `traceId` argument so inbound W3C traceparent trace_ids propagate through the call chain.
- `/usage` added to the default authentication exempt-paths list (alongside `/health` and `/metrics`).
- **`ModuleAnnotations.paginationStyle`** widened from `"cursor" | "offset" | "page"` union to `string`, matching apcore-js 0.16.0's relaxed type.

### Added

- **W3C Trace Context bridging (F-042)** — `tools/call` requests carrying
  `_meta.traceparent` now flow through to the apcore `Context.traceId` so the
  downstream trace chain stays linked. Successful tool responses include a
  freshly minted `_meta.traceparent` so clients can continue the W3C trace
  chain across subsequent MCP invocations. New `parseTraceparent()` and
  `buildTraceparent()` helpers live under `src/server/traceContext.ts` and are
  re-exported from the package root. Traceparent parsing delegates to
  apcore-js's `TraceContext.fromTraceparent()` when available for a single
  source of truth on validation.
- **Async Task Bridge (F-043)** — New `AsyncTaskBridge` class in
  `src/server/asyncTaskBridge.ts` routes async-hinted modules
  (`metadata.async === true` OR `annotations.extra["mcp_async"] === "true"`)
  through apcore-js's `AsyncTaskManager.submit()` and returns an immediate
  `{task_id, status: "pending"}` envelope. Four reserved meta-tools
  (`__apcore_task_submit`, `__apcore_task_status`, `__apcore_task_cancel`,
  `__apcore_task_list`) are advertised via `tools/list` and dispatched by the
  execution router. `MCPServerFactory.buildTools()` now rejects any module id
  starting with `__apcore_` to prevent namespace collision. Completed task
  results are redacted via apcore-js's `redactSensitive()` before being inlined
  in `__apcore_task_status`. Enabled by default; disable via
  `serve({ async: false })` or CLI `--no-async`.
- **Observability auto-wiring (F-044)** — `serve()`, `asyncServe()`, and
  `APCoreMCP` now accept `observability: true` (or `metricsCollector: true`)
  to auto-instantiate apcore-js's `MetricsCollector` + `MetricsMiddleware` and
  `UsageCollector` + `UsageMiddleware` via `executor.use()`. A new `/usage`
  HTTP endpoint returns module and caller summaries. CLI flag `--observability`
  enables the full stack. Back-compat: passing a pre-instantiated
  `MetricsExporter` in `metricsCollector` still works unchanged.
- **`instanceof` dispatch for apcore-js error classes** — `ErrorMapper` now
  imports apcore-js's concrete `TaskLimitExceededError`,
  `VersionConstraintError`, `DependencyNotFoundError`, and
  `DependencyVersionMismatchError` classes and dispatches via `instanceof` when
  available, preserving structured fields across the cross-language contract.
  Falls back to the duck-typed `error.code` path when apcore-js is unavailable.
- **8 new error code mappings** in `ErrorCodes` and `ErrorMapper` — `DEPENDENCY_NOT_FOUND`, `DEPENDENCY_VERSION_MISMATCH`, `TASK_LIMIT_EXCEEDED`, `VERSION_CONSTRAINT_INVALID`, `BINDING_SCHEMA_INFERENCE_FAILED`, `BINDING_SCHEMA_MODE_CONFLICT`, `BINDING_STRICT_SCHEMA_INCOMPATIBLE`, `BINDING_POLICY_VIOLATION`. Dependency errors are marked `userFixable: true`; `TASK_LIMIT_EXCEEDED` is marked `retryable: true`; binding/version-constraint errors pass through with `userFixable: true`.
- **Annotation description suffix** — `AnnotationMapper.toDescriptionSuffix()` now emits `cache_ttl`, `cache_key_fields`, and `pagination_style` when present, alongside the existing `cacheable`/`paginated` fields.

### Cross-language sync (deferred-modules round, 2026-04-28)

- **Dependency bump**: `mcp-embedded-ui >= 0.4.0` (was `>= 0.3.2`). The new release ships `POST /tools/{name}/validate` (F7) — read-only schema validation, ungated by `allowExecute` or `authHook`. The route flows automatically through the existing `createNodeHandler` adapter. **Resolves EUI-1.**
- **JWT-1 (BREAKING) — `Authenticator.authenticate` takes `Record<string, string>` instead of `IncomingMessage`.** All three SDKs now use `authenticate(headers: HeaderMap) -> Promise<Identity | null>`. Use the new `extractHeaders(req)` helper (re-exported from the package root) to flatten a Node `IncomingMessage`:
  ```ts
  // Before:
  authenticator.authenticate(req);
  // After:
  import { extractHeaders } from "apcore-mcp";
  authenticator.authenticate(extractHeaders(req));
  ```
- **OC-1 — TS strict-mode walker parity with Python+Rust.** The TS strict-mode pipeline now mirrors apcore's canonical `to_strict_schema`: promotes `x-llm-description` → `description`, strips all `x-*` extension keys after promotion, recurses into `oneOf` / `anyOf` / `allOf` and `$defs` / `definitions`, sorts property names alphabetically, and removes `default` values. Output now matches Python+Rust (which delegate to apcore directly). 6 regression tests.
- **EB-2 — adapter-hook kwargs.** `serve()` and `asyncServe()` accept `schemaConverter`, `annotationMapper`, `errorMapper` options that override the factory's built-in adapters. New `MCPServerFactoryOptions` shape. Useful for downstream extensions that customize JSON-Schema strictness, the annotation wire format, or error formatting.
- **MID-5 — `ModuleIDNormalizer.tryDenormalize`.** New bijection-guarded variant validates the dash→dot-replaced result against `MODULE_ID_PATTERN`, returning `null` for inputs that aren't valid pre-images of `normalize`. Plain `denormalize` stays lenient. 9 regression tests.
- **AM-L1 — F-041 annotation extras parity test.** Added a regression test that pins TypeScript's wire format for `mcp_*` extras (single-newline separator between `[Annotations: …]` and the first extra line). Python and Rust were aligned to this format in 0.14.0; TS already emitted it. 1 regression test.
- TC-011 integration tests added in `tests/explorer/explorer.test.ts` pinning the `/validate` wire-up.

---

## [0.13.0] - 2026-04-06

### Added

- **Pipeline Strategy Selection** (F-036) — `serve({strategy: "minimal"})` and CLI `--strategy` with 5 presets.
- **Tool Output Redaction** (F-038) — `serve({redactOutput: true})` applies `redactSensitive()` before MCP serialization. Default: on.
- **Pipeline Observability** (F-037) — `serve({trace: true})` enables `callWithTrace()` for per-step timing.
- **Tool Preflight Validation** (F-039) — `ExecutionRouter.validateTool()` for dry-run validation.
- **YAML Pipeline Configuration** (F-040) — Config Bus `mcp.pipeline` section via `buildStrategyFromConfig()`.
- **Annotation Metadata Passthrough** (F-041) — `annotations.extra` keys with `mcp_` prefix flow to descriptions.
- **4 new error mappings** — `CONFIG_ENV_MAP_CONFLICT`, `PIPELINE_ABORT`, `STEP_NOT_FOUND`, `VERSION_INCOMPATIBLE`.
- **RegistryListener wired to `serve({dynamic: true})`**.

### Changed

- **Dependency bump**: `apcore-js >= 0.17.1` (was `>= 0.15.1`).

---

## [0.12.0] - 2026-03-31

### Added

- **Config Bus namespace registration** (F-033) — Registers `mcp` namespace with apcore Config Bus (`APCORE_MCP` env prefix). MCP configuration (transport, host, port, auth, explorer) can be managed via unified `apcore.yaml`.
- **Error Formatter Registry integration** (F-034) — `McpErrorFormatter` registered with apcore's `ErrorFormatterRegistry`, formalizing MCP error formatting into the shared protocol.
- **Dot-namespaced event constants** — `APCORE_EVENTS` object with canonical event type names from apcore 0.15.0 (§9.16).
- **6 new error code mappings** — `CONFIG_NAMESPACE_DUPLICATE`, `CONFIG_NAMESPACE_RESERVED`, `CONFIG_ENV_PREFIX_CONFLICT`, `CONFIG_MOUNT_ERROR`, `CONFIG_BIND_ERROR`, `ERROR_FORMATTER_DUPLICATE`.

### Changed

- Dependency bump: requires `apcore-js >= 0.15.1` (was `>= 0.14.0`) for Config Bus (§9.4), Error Formatter Registry (§8.8), and dot-namespaced event types (§9.16).

---

## [0.11.0] - 2026-03-26

### Added
- **Display overlay in `buildTool()`** — MCP tool name, description, and guidance now sourced from `metadata.display.mcp` when present.
  - Tool name: `metadata.display.mcp.alias` (pre-sanitized by `DisplayResolver`, already `[a-zA-Z_][a-zA-Z0-9_-]*` and ≤ 64 chars).
  - Tool description: `metadata.display.mcp.description`, with `guidance` appended as `\n\nGuidance: <text>` when set.
  - Falls back to raw `descriptor.moduleId` / `descriptor.description` when no display overlay is present.
- Added `reportProgress()` and `elicit()` to README API reference.
- Added missing `serve()` options to README: `explorerTitle`, `explorerProjectName`, `explorerProjectUrl`, `requireAuth`, `outputFormatter`.

### Changed
- Dependency recommendation: works best with `apcore-toolkit >= 0.4.0` for `DisplayResolver`.

### Fixed
- Removed reference to nonexistent `examples/` directory in README.

### Tests
- `TestBuildToolDisplayOverlay` (6 tests): MCP alias used as tool name, MCP description used, guidance appended to description, surface-specific override wins over default, fallback to scanner values when no overlay, all fields combined.

## [0.10.2] - 2026-03-22

### Changed
- Rebrand: aipartnerup → aiperceivable

## [0.10.1] - 2026-03-21

### Changed

- **ESM-native JSON import**: Replaced `createRequire` workaround with `import ... with { type: "json" }` for loading `package.json`, removing the `node:module` dependency.

## [0.10.0] - 2026-03-14

### Changed

- **Dependency bump**: Requires `apcore-js>=0.13.0` (was `>=0.9.0`). Picks up new annotation fields (`cacheable`, `paginated`, `cacheTtl`, `cacheKeyFields`, `paginationStyle`).
- **`ModuleAnnotations` interface**: Added optional `cacheable`, `cacheTtl`, `cacheKeyFields`, `paginated`, and `paginationStyle` fields to match apcore 0.13.0.
- **Annotation description suffix**: `AnnotationMapper.toDescriptionSuffix()` now includes `cacheable` and `paginated` when set to non-default values.

## [0.9.0] - 2026-03-06

### Added

- **`asyncServe()` public API** — New function that builds an embeddable Node.js HTTP request handler `(req, res) => Promise<void>` for mounting the MCP server into a larger HTTP application. TypeScript equivalent of Python's `async_serve()` context manager. Returns `{ handler, close }` for lifecycle management.
- **`AsyncServeOptions` and `AsyncServeApp` types** — Dedicated options interface (omits transport/host/port/lifecycle hooks) and return type for `asyncServe()`.
- **`TransportManager.buildStreamableHttpApp()`** — New method that creates a composable HTTP request handler without binding to a port. Foundation for `asyncServe()` and custom embedding scenarios.
- **Deep merge for streaming chunks** — `ExecutionRouter` now uses recursive deep merge (depth-limited to 32) instead of shallow merge when accumulating streaming response chunks. Nested objects are properly merged; arrays and scalars are overwritten.
- **`EXECUTION_CANCELLED` error handling** — `ErrorMapper` now detects `ExecutionCancelledError` (by constructor name or error code) and returns a dedicated `EXECUTION_CANCELLED` response with `retryable: true`.
- **New error codes** — Added `VERSION_INCOMPATIBLE`, `ERROR_CODE_COLLISION`, and `EXECUTION_CANCELLED` to the `ErrorCodes` constant, matching the Python reference implementation.
- New tests for `asyncServe()`, deep merge streaming, `ExecutionCancelledError` handling, and new error codes.

## [0.8.0] - 2026-03-02

### Added

- **Approval error codes** — New `APPROVAL_DENIED`, `APPROVAL_TIMEOUT`, `APPROVAL_PENDING` entries in `ErrorCodes` constant for approval-related error handling.
- **Enhanced ErrorMapper with AI guidance** — `McpErrorResponse` now carries optional `retryable`, `aiGuidance`, `userFixable`, and `suggestion` fields. `ErrorMapper.toMcpError()` extracts these from enhanced `ModuleError` instances and attaches them to responses. Approval errors (`APPROVAL_PENDING`, `APPROVAL_TIMEOUT`, `APPROVAL_DENIED`) have dedicated handling branches.
- **AI guidance in router error text** — `ExecutionRouter` now appends AI guidance fields as a structured JSON block to error text via `_buildErrorText()`, giving AI agents richer error context.
- **AI intent metadata in tool descriptions** — `MCPServerFactory.buildTool()` reads `x-when-to-use`, `x-when-not-to-use`, `x-common-mistakes`, and `x-workflow-hints` from `descriptor.metadata` and appends them to the tool description for AI agent visibility.
- **`streaming` in `toDescriptionSuffix()`** — `AnnotationMapper.toDescriptionSuffix()` now includes `streaming=true` in the annotations suffix when the module declares streaming capability.
- **`ElicitationApprovalHandler`** — New `src/adapters/approval.ts` class that bridges MCP elicitation to apcore's approval system. Exports `ElicitationApprovalHandler`, `ApprovalRequest`, and `ApprovalResult` from public API.
- **`approvalHandler` option in `ServeOptions`** — Pass an approval handler to `serve()` for automatic wiring into the Executor. `resolveExecutor()` now accepts an optional `approvalHandler` parameter.
- **`--approval` CLI flag** — New CLI option with modes: `elicit` (uses `ElicitationApprovalHandler`), `auto-approve`, `always-deny`, and `off` (default). The `auto-approve` and `always-deny` modes dynamically import handlers from `apcore-js`.
- New test suites: `tests/adapters/approval.test.ts` for `ElicitationApprovalHandler`; new AI guidance and approval error tests in `tests/adapters/errors.test.ts`; streaming suffix tests in `tests/adapters/annotations.test.ts`; AI intent metadata tests in `tests/server/factory.test.ts`; `_buildErrorText` tests in `tests/server/router.test.ts`; `--approval` CLI flag tests in `tests/cli.test.ts`.

## [0.7.0] - 2026-02-28

### Added

- **JWT Authentication** — New `src/auth/` module with `JWTAuthenticator` class for Bearer token authentication on HTTP transports. Supports configurable algorithms, audience/issuer validation, claim-to-Identity mapping (`ClaimMapping`), required claims, and permissive mode. Exported from public API: `JWTAuthenticator`, `Authenticator`, `ClaimMapping`, `JWTAuthenticatorOptions`.
- **Identity propagation via AsyncLocalStorage** — `identityStorage` (AsyncLocalStorage) and `getCurrentIdentity()` allow any code in the request call chain to access the authenticated identity without explicit parameter passing. Exported from public API.
- **`authenticator` and `exemptPaths` options in `ServeOptions`** — Pass an `Authenticator` instance to `serve()` to enable request authentication. `exemptPaths` customizes which routes bypass auth (default: `["/health", "/metrics"]`).
- **CLI JWT flags** — 7 new CLI arguments: `--jwt-secret`, `--jwt-algorithm`, `--jwt-audience`, `--jwt-issuer`, `--jwt-require-auth`, `--jwt-permissive`, `--exempt-paths`.
- **BridgeContext identity support** — `createBridgeContext()` accepts an optional `Identity` parameter. `BridgeContext.identity` type narrowed from `Record<string, unknown> | null` to `Identity | null`. Identity propagates to child contexts.
- **Explorer Authorization UI** — Swagger-UI-style Authorization input field in the Tool Explorer. Paste a Bearer token to authenticate tool execution requests. Generated cURL commands automatically include the Authorization header.
- **Explorer auth enforcement** — Tool execution via the Explorer returns 401 Unauthorized without a valid Bearer token when authentication is enabled. The Explorer UI displays a clear error message prompting the user to enter a token.
- **MCP Client Configuration** — README now includes configuration examples for Claude Desktop, Claude Code, Cursor, and remote HTTP access.
- New `jsonwebtoken` runtime dependency for JWT verification.
- New test suites: `tests/auth/jwt.test.ts`, `tests/auth/storage.test.ts`, `tests/auth/integration.test.ts`; new identity tests in `tests/server/context.test.ts`; new JWT CLI flag tests in `tests/cli.test.ts`.

### Changed

- **Explorer UI layout** — Redesigned from a bottom-panel layout to a Swagger-UI-style inline accordion. Each tool expands its detail, schema, and "Try it" section directly below the tool name. Only one tool can be expanded at a time. Detail is loaded once on first expand and cached.
- **Explorer title** — Updated from "MCP Tool Explorer" to "APCore MCP Tool Explorer" for consistent branding with the Python project.
- **`ExecutionRouter` creates BridgeContext with identity** — When `getCurrentIdentity()` returns a non-null identity, the router creates a BridgeContext even without MCP callbacks, propagating the identity to executors.
- **Transport auth middleware** — Both `streamable-http` and `sse` transports authenticate non-exempt requests before processing. Authenticated identity is stored in `identityStorage` (AsyncLocalStorage) so `getCurrentIdentity()` works throughout the request lifecycle.
- **CRITICAL added to valid CLI log levels** — `--log-level` now accepts `CRITICAL` in addition to `DEBUG`, `INFO`, `WARNING`, `ERROR`.
- **vitest config simplified** — Removed the `/dev/null` alias hack for `apcore-js` since it is now a proper direct dependency.
- **resolve-executor tests updated** — Tests now verify that `resolveExecutor()` auto-creates an Executor from a bare Registry (since `apcore-js` is a direct dependency), replacing the previous "throws when apcore-js not installed" assertions.

## [0.6.1] - 2026-02-26

### Changed

- **`apcore-js` promoted to direct dependency** — Moved `apcore-js` from optional peer dependency to a direct dependency in `package.json`, matching the Python `apcore-mcp` project where `apcore` is a direct dependency. Users no longer need to separately install `apcore-js` — `npm install apcore-mcp` is all that's needed.
- **Example modules now use `apcore-js` types** — Class-based extension modules (`greeting`, `math_calc`, `text_echo`) updated to import `ModuleAnnotations`, `DEFAULT_ANNOTATIONS`, and `Context` from `apcore-js` instead of using plain duck-typed objects. The `execute()` signature now includes the `context: Context` parameter, consistent with the Python examples.
- **README updated** — Removed outdated "apcore (peer dependency)" requirement, added note that `apcore-js` is included as a direct dependency, and added Examples section linking to `examples/README.md`.

## [0.6.0] - 2026-02-25

### Added

- **Example modules**: `examples/` with 5 runnable demo modules — 3 class-based (`text_echo`, `math_calc`, `greeting`) and 2 programmatic via `module()` factory (`convert_temperature`, `word_count`) — for quick Explorer UI demo out of the box.

### Changed

- **BREAKING: `ExecutionRouter.handleCall()` return type**: Changed from `[content, isError]` to `[content, isError, traceId]`. Callers that unpack the 2-tuple must update to 3-tuple unpacking.
- **BREAKING: Explorer `/call` response format**: Changed from `{"result": ...}` / `{"error": ...}` to MCP-compliant `CallToolResult` format: `{"content": [...], "isError": bool, "_meta": {"_trace_id": ...}}`.

### Fixed

- **MCP protocol compliance**: Router no longer injects `_trace_id` as a content block in tool results. `traceId` is now returned as a separate tuple element and surfaced in Explorer responses via `_meta`. Factory handler throws errors for error results so the MCP SDK correctly sets `isError=true`.
- **Explorer UI default values**: `defaultFromSchema()` now correctly skips `null` defaults and falls through to type-based placeholders, fixing blank form fields for binding.yaml modules.

## [0.5.0] - 2026-02-25

### Added

- **MCP Tool Explorer** — Browser-based UI for inspecting and testing MCP tools, consistent with the Python (`apcore-mcp`) implementation. Mounts at `/explorer` on HTTP transports (`streamable-http`, `sse`); silently ignored for `stdio`.
  - `GET /explorer/` — Self-contained HTML single-page application (no external dependencies) displaying registered tools with annotation badges, input schemas, and a "Try it" section.
  - `GET /explorer/tools` — JSON array of tool summaries (name, description, annotations).
  - `GET /explorer/tools/{name}` — JSON tool detail including `inputSchema`.
  - `POST /explorer/tools/{name}/call` — Execute a tool from the browser UI. Returns 403 when execution is disabled.
- **`ExplorerHandler` class** — New `src/explorer/handler.ts` module handling all explorer HTTP routes. Accepts `ExplorerHandlerOptions` with `allowExecute` (default: `false`) and `prefix` (default: `"/explorer"`). Exported from public API.
- **`explorer`, `explorerPrefix`, `allowExecute` options in `ServeOptions`** — Enable the explorer UI, customize the URL prefix, and control tool execution from the browser.
- **`--explorer`, `--explorer-prefix`, `--allow-execute` CLI flags** — CLI support for all explorer options.
- **`setExplorerHandler()` on `TransportManager`** — Allows mounting the explorer into HTTP transport servers.
- New test suite `tests/explorer/explorer.test.ts` — 20 tests across 8 test groups (TC-001 through TC-008) covering HTML page, disabled-by-default, tool listing, tool detail, tool execution, execute-disabled 403, stdio-ignored, and custom prefix.

### Changed

- **`readBody()` exported from `TransportManager` module** — The shared `readBody()` utility in `src/server/transport.ts` is now exported for reuse by the explorer handler, eliminating code duplication.

## [0.4.0] - 2026-02-23

### Added

- **MCP Resources support** — New `registerResourceHandlers()` on `MCPServerFactory`. Modules with a `documentation` field are exposed as `docs://{moduleId}` MCP resources via `resources/list` and `resources/read`. Server now advertises `resources: {}` capability.
- **`/health` endpoint** — HTTP transports (`streamable-http`, `sse`) now serve a `/health` route returning JSON `{ status, uptime_seconds, module_count }` for readiness probing.
- **`/metrics` Prometheus endpoint** — HTTP transports (`streamable-http`, `sse`) now serve a `/metrics` route returning Prometheus text format when a `metricsCollector` is provided. Returns 404 when no collector is configured.
- **`MetricsExporter` interface** — Duck-typed interface for implementing custom Prometheus metrics exporters. Exported from public API.
- **`metricsCollector` option in `ServeOptions`** — Accepts a `MetricsExporter` instance to enable the `/metrics` endpoint on HTTP transports.
- **`Executor.validate?()` optional method** — New optional `validate(moduleId, inputs)` method on the `Executor` interface for pre-execution input validation.
- **`validateInputs` option in `ExecutionRouterOptions`** — When `true`, `ExecutionRouter` calls `executor.validate?.()` before execution and returns a formatted validation error response on failure. Exported from public API.
- **`tags` and `prefix` filtering in `ServeOptions`** — Pass `tags` and/or `prefix` to `serve()` to restrict which registry modules are exposed as MCP tools.
- **`logLevel` option in `ServeOptions`** — Suppresses `console` output below the specified level (`DEBUG` | `INFO` | `WARNING` | `ERROR`) during `serve()`. All suppressed methods are restored after shutdown.
- **`onStartup` / `onShutdown` lifecycle callbacks in `ServeOptions`** — Async hooks invoked before the transport starts and after it stops (including on error).
- **`--log-level` validation in CLI** — The `apcore-mcp` CLI now validates `--log-level` against the allowed set and passes it to `serve()`.
- **`streaming` field in `ModuleAnnotations`** — New boolean field to declare streaming capability in module metadata.
- New test suite `tests/serve-features.test.ts` — covers `tags`/`prefix` filtering (F1), `logLevel` suppression (F2), and `onStartup`/`onShutdown` lifecycle hooks (F4).
- New test suite `tests/server/metrics-endpoint.test.ts` — covers `/metrics` endpoint for both `streamable-http` and `sse` transports (200, 404, 500, content-type).
- New test suite `tests/server/router-validate.test.ts` — covers input validation in `ExecutionRouter` (F3).
- New test suite `tests/server/transport.test.ts` — covers `/health` endpoint for both transports, including `setModuleCount()` reflection.
- **`resolveRegistry()` and `resolveExecutor()` exported** — Both helper functions are now part of the public API, enabling advanced users to manually resolve Registry/Executor from a `RegistryOrExecutor` union without going through `serve()` or `toOpenaiTools()`.
- **`peerDependencies` declaration for `apcore-js`** — `package.json` now declares `apcore-js >= 0.4.0` as an optional peer dependency, informing users of the runtime requirement for CLI and bare-Registry modes.
- New test suite `tests/resolve-executor.test.ts` — covers `resolveRegistry()` (3 tests), `resolveExecutor()` pass-through and error paths (4 tests), and `serve()` integration (2 tests).
- New test suite `tests/cli.test.ts` — covers CLI argument validation, help output, apcore-js availability, success path with mocked apcore-js, module discovery logging, and log-level validation (13 tests).

### Changed

- **`toDescriptionSuffix` omits default annotation values** — `AnnotationMapper.toDescriptionSuffix()` now only includes fields that differ from their defaults (`readonly=false`, `destructive=false`, `idempotent=false`, `requiresApproval=false`, `openWorld=true`), producing shorter, more informative description suffixes.
- **Tool errors returned as MCP `isError` result** — `MCPServerFactory.registerHandlers()` no longer throws protocol-level errors for tool execution failures; errors are returned as `CallToolResult` with `isError: true` and the error message in `content`.
- **Progress notification index is now 1-based** — `notifications/progress` chunks sent from `ExecutionRouter` use a 1-based `progress` counter (was 0-based).
- **Trace ID appended to tool responses** — When a `BridgeContext` is active, a `{ _trace_id }` entry is appended to the response content array for both streaming and non-streaming paths.
- **`ModuleDescriptor.description` is now optional** — `MCPServerFactory.buildTool()` no longer throws when `description` is `null` or `undefined`.
- **`resolveExecutor()` tries auto-creating from `apcore`** — When a bare `Registry` is passed to `serve()`, it now attempts to dynamically `require('apcore')` and instantiate a default Executor before failing with a descriptive error.
- **`package.json` keywords expanded** — Added `mcp-server`, `tool-bridge`, `agent-tools`, `schema`, `json-schema`, `validation`, `router`, `transport`, `cli` for better npm discoverability.

### Fixed

- **Package name corrected from `"apcore"` to `"apcore-js"`** — `resolveExecutor()` in `src/index.ts` used `require("apcore")` and CLI in `src/cli.ts` used `import("apcore")`, which would fail even when `apcore-js` was installed. Both now reference the correct package name `"apcore-js"`, with updated error messages.

- **Null-safe `call` / `callAsync` selection** — `ExecutionRouter` now uses `typeof` checks instead of truthiness when selecting between `executor.call()` and `executor.callAsync()`, preventing accidental fallthrough on falsy executor methods.
- **`serve()` input validation** — `serve()` now validates `name` (non-empty, ≤ 255 chars), `tags` (no empty strings), and `prefix` (non-empty if provided) before starting, throwing descriptive errors.

## [0.3.0] - 2026-02-22

### Added

- **Streaming execution support** — The MCP bridge layer now supports streaming execution. When an executor implements `stream()` and the client provides a `progressToken`, chunks are forwarded as `notifications/progress` and shallow-merged into the final result. Falls back to `call()` when streaming is not available or not requested.
- **Elicitation and progress reporting** — New `helpers.ts` module with `reportProgress()` and `elicit()` functions for modules to report progress and request user input during execution.
- **BridgeContext** — New duck-typed context object that carries shared data through call chains, with support for MCP callbacks and progress reporting.
- `stream?()` method added to `Executor` interface for streaming support.
- `HandleCallExtra` interface for MCP SDK callbacks (`sendNotification`, `sendRequest`, `_meta`).
- `context?: unknown` parameter added to Executor interface methods (`call`, `stream`, `getDefinition`) for backward-compatible context passing.
- `_meta.streaming` property added to OpenAI tool definitions when module descriptor has `annotations.streaming`.
- Exported `helpers`, `BridgeContext` type, and `createBridgeContext` from public API.
- 7 streaming router tests covering chunks, fallback, and edge cases.

### Changed

- `ExecutionRouter` now builds context with MCP callbacks and passes it to executors.
- `factory.ts` wired to pass MCP SDK extra parameters to router for streaming and elicitation support.

### Fixed

- **BridgeContext.child() callerId alignment** — `callerId` now equals the last element of parent's `callChain` (who called me), matching apcore-typescript Context.child() behavior.
- `redactedInputs` is now nullable (null initial) to match real Context behavior.
- Added `readonly` modifiers to BridgeContext properties to match real Context's immutability contract.

## [0.2.0] - 2026-02-20

### Changed

- **Breaking: All TypeScript interfaces now use camelCase** — Updated all type definitions in `types.ts` to follow TypeScript conventions (e.g., `module_id` → `moduleId`, `input_schema` → `inputSchema`, `get_definition` → `getDefinition`, `call_async` → `callAsync`). MCP hint properties also updated (e.g., `read_only_hint` → `readOnlyHint`).
- All adapters, converters, and server components refactored to use the new camelCase property names.
- All test files updated to match the new interface signatures (113 tests passing across 10 test files).

### Added

- New constants in `types.ts`: `REGISTRY_EVENTS`, `ErrorCodes`, and `MODULE_ID_PATTERN` for standardized error codes and validation.
- New type alias `RegistryOrExecutor` for accepting either Registry or Executor.
- `has?()` method on Registry interface for optional module existence checking.
- Improved JSDoc comments in `types.ts` with section dividers and clearer documentation.

## [0.1.1] - 2026-02-18

### Fixed

- **Circular `$ref` detection in SchemaConverter** — Self-referencing or mutually recursive `$ref` (e.g., TreeNode with children: TreeNode[]) now throws a descriptive `Circular $ref detected` error instead of causing infinite recursion / stack overflow.
- **Request body size limit in HTTP transports** — `readBody()` now enforces a maximum body size (default 4MB) to prevent memory exhaustion DoS. Oversized requests receive HTTP 413; malformed JSON receives HTTP 400.

### Added

- Environment variable `APCORE_MAX_BODY_BYTES` to configure the maximum request body size for HTTP transports (StreamableHTTP and SSE). Defaults to 4,194,304 (4MB).

## [0.1.0] - 2026-02-17

### Added

- Initial project setup with MCP server, schema conversion, transport management, and OpenAI tools bridge.
