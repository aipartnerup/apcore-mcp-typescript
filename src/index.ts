/**
 * apcore-mcp: Automatic MCP Server & OpenAI Tools Bridge for apcore.
 *
 * Public API:
 * - serve(registryOrExecutor, options?) - Launch an MCP Server
 * - asyncServe(registryOrExecutor, options?) - Build an embeddable HTTP request handler
 * - toOpenaiTools(registryOrExecutor, options?) - Export OpenAI tool definitions
 */

import { createNodeHandler, type Tool as UITool } from "mcp-embedded-ui";
import { OpenAIConverter } from "./converters/openai.js";
import type { ConvertRegistryOptions } from "./converters/openai.js";
import { MCPServerFactory } from "./server/factory.js";
import { ExecutionRouter } from "./server/router.js";
import { RegistryListener } from "./server/listener.js";
import { TransportManager } from "./server/transport.js";
import { registerMcpNamespace } from "./config.js";
import { registerMcpFormatter } from "./adapters/mcp-error-formatter.js";
import type { MetricsExporter } from "./server/transport.js";
import { installObservability, type ObservabilityFlag } from "./server/observability.js";
import { createAsyncTaskBridge, type AsyncTaskBridge } from "./server/async-task-bridge.js";
import { computeManagementSurfaces } from "./server/system-surface.js";
import type {
  RegistryOrExecutor,
  Registry,
  Executor,
  ModuleDescriptor,
  OpenAIToolDef,
} from "./types.js";
import type { Authenticator } from "./auth/types.js";
import { buildExplorerAuthHook } from "./auth/hooks.js";
import type { ApprovalStore } from "./approval-store.js";
import { StorageBackedApprovalHandler } from "./adapters/approval.js";
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

// ─── Type Exports ────────────────────────────────────────────────────────────
export type { Registry, Executor, RegistryOrExecutor, OpenAIToolDef } from "./types.js";
export type {
  ModuleDescriptor,
  ModuleAnnotations,
  JsonSchema,
  ModuleError,
  McpAnnotationsDict,
  McpErrorResponse,
  TextContentDict,
} from "./types.js";
// APCORE_EVENTS: re-exported for cross-SDK parity with Python `apcore_mcp.APCORE_EVENTS`
// and Rust `apcore_mcp::apcore_events`. Has no internal callers in this package; do not delete.
export { REGISTRY_EVENTS, ErrorCodes, MODULE_ID_PATTERN, APCORE_EVENTS } from "./types.js";

// ─── Extension Helpers ───────────────────────────────────────────────────────
export { reportProgress, elicit, MCP_PROGRESS_KEY, MCP_ELICIT_KEY } from "./helpers.js";
export type { ElicitResult } from "./helpers.js";
export { createBridgeContext } from "./server/context.js";
export {
  openapiBackend,
  projectModuleId,
  resolveSpecLocation,
  MODULE_ID_SEGMENT,
  type OpenAPIBackendOptions,
} from "./openapi-backend.js";
export type { BridgeContext } from "./server/context.js";

// ─── Auth Exports ────────────────────────────────────────────────────────────
export { JWTAuthenticator } from "./auth/jwt.js";
export type { ClaimMapping, JWTAuthenticatorOptions } from "./auth/jwt.js";
export type { Authenticator, Identity } from "./auth/types.js";
export { identityStorage, getCurrentIdentity } from "./auth/storage.js";
export { buildExplorerAuthHook } from "./auth/hooks.js";
// [A-D-230 / D9-003] createAuthMiddleware and src/auth/middleware.ts have
// been removed. The factory was orphan code with no production caller, and
// asyncServe never wired it into its HTTP transport. A future PR landing
// the asyncServe wiring should reintroduce a middleware module that
// integrates with the live transport stack.

// ─── Unified Entry Point ─────────────────────────────────────────────────────
export { APCoreMCP } from "./apcore-mcp.js";
export type { APCoreMCPOptions, APCoreMCPServeOptions, APCoreMCPAsyncServeOptions } from "./apcore-mcp.js";

// ─── Building Block Exports ──────────────────────────────────────────────────
export { MCPServerFactory } from "./server/factory.js";
// MCPServer is an alias for MCPServerFactory, matching Python/Rust top-level export parity.
export { MCPServerFactory as MCPServer } from "./server/factory.js";
export { ExecutionRouter } from "./server/router.js";
export type { CallResult, HandleCallExtra, ExecutionRouterOptions } from "./server/router.js";
export { RegistryListener } from "./server/listener.js";
export { TransportManager } from "./server/transport.js";
export type { MetricsExporter, UsageExporter } from "./server/transport.js";
export { AsyncTaskBridge, createAsyncTaskBridge, META_TOOL_NAMES, APCORE_META_TOOL_PREFIX } from "./server/async-task-bridge.js";
export type { AsyncTaskManagerLike } from "./server/async-task-bridge.js";
export { installObservability } from "./server/observability.js";
export type { ObservabilityFlag, ObservabilityStack } from "./server/observability.js";
export { parseTraceparent, buildTraceparent } from "./server/trace-context.js";
export { AnnotationMapper } from "./adapters/annotations.js";
export { SchemaConverter } from "./adapters/schema.js";
export { ErrorMapper, internalErrorResponse } from "./adapters/errors.js";
export { ModuleIDNormalizer } from "./adapters/id-normalizer.js";
export { ElicitationApprovalHandler, StorageBackedApprovalHandler } from "./adapters/approval.js";
export type { ApprovalRequest, ApprovalResult } from "./adapters/approval.js";
export { InMemoryApprovalStore } from "./approval-store.js";
export type { ApprovalStore, ApprovalRecord } from "./approval-store.js";
export { ApprovalBridge, APPROVAL_META_TOOL_NAMES } from "./server/approval-bridge.js";
export type { ApprovalMetaToolName } from "./server/approval-bridge.js";
export { McpErrorFormatter, registerMcpFormatter } from "./adapters/mcp-error-formatter.js";
export { registerMcpNamespace, MCP_NAMESPACE, MCP_ENV_PREFIX, MCP_DEFAULTS } from "./config.js";
export { OpenAIConverter } from "./converters/openai.js";
export type { ConvertOptions, ConvertRegistryOptions } from "./converters/openai.js";
export type { BuildToolsOptions } from "./server/factory.js";

/**
 * Extract Registry from either a Registry or Executor instance.
 *
 * If the argument has a `registry` property (i.e. it's an Executor),
 * returns that property. Otherwise assumes it's a Registry and returns it directly.
 */
export function resolveRegistry(registryOrExecutor: RegistryOrExecutor): Registry {
  if ("registry" in registryOrExecutor) {
    // It's an Executor — get its registry
    return (registryOrExecutor as Executor).registry;
  }
  // Assume it's a Registry
  return registryOrExecutor as Registry;
}

/**
 * Get or create an Executor from either a Registry or Executor instance.
 *
 * If the argument already has `call` or `callAsync`, returns it directly.
 * If a bare Registry is passed, attempts to dynamically import the Executor
 * from apcore-js and create a default instance (matching Python's resolve_executor).
 *
 * @throws {Error} If the argument is a Registry and apcore-js is not installed.
 */
export async function resolveExecutor(
  registryOrExecutor: RegistryOrExecutor,
  options?: {
    approvalHandler?: unknown;
    strategy?: string;
    middleware?: unknown[];
    acl?: unknown;
  },
): Promise<Executor> {
  let executor: Executor | undefined;

  if ("call" in registryOrExecutor || "callAsync" in registryOrExecutor) {
    // Already an Executor
    if (options?.strategy) {
      console.warn(
        `strategy='${options.strategy}' ignored: input is already an Executor instance.`,
      );
    }
    executor = registryOrExecutor as Executor;
  } else {
    // It's a bare Registry — create a default Executor
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const apcore = (await import("apcore-js")) as any;
      const ExecutorClass = apcore.Executor ?? apcore.default?.Executor;
      if (ExecutorClass) {
        const executorOpts: Record<string, unknown> = {
          registry: registryOrExecutor,
        };
        if (options?.approvalHandler) {
          executorOpts.approvalHandler = options.approvalHandler;
        }
        if (options?.strategy) {
          executorOpts.strategy = options.strategy;
        }
        executor = new ExecutorClass(executorOpts) as Executor;
      }
    } catch {
      // apcore-js not installed — fall through to error
    }
    if (!executor) {
      throw new Error(
        "serve() requires an Executor instance, or apcore-js must be installed to auto-create one from a Registry.",
      );
    }
  }

  // Apply middleware via executor.use() per instance. Mirrors the Python
  // bridge's resolve_executor contract.
  const middleware = options?.middleware ?? [];
  if (middleware.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const useFn = (executor as any).use;
    if (typeof useFn !== "function") {
      throw new Error(
        "Executor does not support .use() — 'middleware' option requires apcore-js>=0.18",
      );
    }
    for (const mw of middleware) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (executor as any).use(mw);
    }
  }

  // Install ACL via executor.setAcl() if provided.
  if (options?.acl !== undefined && options.acl !== null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setAcl = (executor as any).setAcl;
    if (typeof setAcl !== "function") {
      throw new Error(
        "Executor does not support .setAcl() — 'acl' option requires apcore-js>=0.18",
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (executor as any).setAcl(options.acl);
  }

  return executor;
}

/**
 * Build a map of module_id → output_schema from the registry.
 *
 * Only includes modules whose output_schema is a non-empty object.
 */
function buildOutputSchemaMap(registry: Registry): Record<string, Record<string, unknown>> {
  const map: Record<string, Record<string, unknown>> = {};
  for (const moduleId of registry.list()) {
    const def = registry.getDefinition(moduleId);
    if (def?.outputSchema && Object.keys(def.outputSchema).length > 0) {
      map[moduleId] = def.outputSchema;
    }
  }
  return map;
}

/**
 * Structural mirror of apcore-typescript's `GovernanceState`
 * (`src/pipeline.ts`, apcore 0.28.0, PROTOCOL_SPEC §6.6.5).
 *
 * Declared locally rather than imported from `apcore-js` because
 * `Executor.governanceState()` is detected via runtime duck-typing (like
 * every other optional apcore-js>=N feature in this file — `.use()`,
 * `.setAcl()`) so this bridge keeps working, minus the warning, against an
 * apcore-js older than 0.28.0. A static `import type { GovernanceState }
 * from "apcore-js"` would fail `tsc` against such an install.
 */
interface GovernanceStateLike {
  controlModulesRegistered: boolean;
  readModulesRegistered: boolean;
  aclConfigured: boolean;
  builtinAclGateWired: boolean;
  approvalHandlerConfigured: boolean;
  builtinApprovalGateWired: boolean;
  policyStrict: boolean;
  allControlModulesRequireApproval: boolean;
  unprotectedControlSurface: boolean;
}

/**
 * Build the startup warning for aiperceivable/apcore-mcp#15(b): the
 * `system.control.*` write modules are registered and reachable via
 * `tools/call` with no recognised gate in front of them.
 *
 * Returns `null` when `state.unprotectedControlSurface` is false — nothing
 * to warn about. Pure formatting only: this function never enforces,
 * throws, or blocks startup — `Executor.governanceState()` is itself a pure
 * read (PROTOCOL_SPEC §6.6.5), and what to do with an unprotected surface is
 * left to the caller (here: warn and continue).
 */
/**
 * One finding from `ACL.validateRules()` (PROTOCOL_SPEC §6.2.1 tier 2).
 *
 * Matches apcore-js's real `RuleValidationFinding` shape exactly — measured
 * against a live `ACL` instance, not assumed: `{ruleIndex, conditionPath,
 * conditionKey, effect, syncResolvable, asyncResolvable}`. There is no
 * `reason`/`message` field; apcore-js hands back structured data only, and
 * the prose has to be built by whoever renders it (§6.1.3 — this is
 * diagnostics, not a rule-level error string). An earlier version of this
 * interface named `path`/`reason`/`message`, none of which exist on the real
 * object, so `formatAclNeverMatchesWarnings` silently rendered `'?': ` for
 * every finding — the field names are pinned by direct verification now.
 */
export interface AclRuleFindingLike {
  ruleIndex: number;
  conditionPath: string;
  conditionKey?: string | null;
  effect: string;
  syncResolvable?: boolean;
  asyncResolvable?: boolean;
}

/**
 * Format the §6.2.1 tier-2 warnings: ACL rules that loaded cleanly and can
 * protect nothing.
 *
 * apcore 0.29.0 closed the *shape* of a pattern array at every door, but that
 * does not exhaust the inert class: `["$not", "*"]` has legal arity, exactly
 * one operand, and matches nothing — the identical fail-open, reached through a
 * well-formed array. apcore reports these through `ACL.validateRules()` as
 * findings that load, change no decision, and are never rejected, because the
 * predicate cannot be closed without freezing the pattern language.
 *
 * Pure formatting, exactly like `formatUnprotectedControlSurfaceWarning` above:
 * a finding never fails startup, and deciding what to do with one is the
 * caller's (here: warn and continue). Returns `null` when there is nothing to
 * report.
 *
 * Call this only once the registry is assembled — `validateRules()` also
 * reports `conditions` keys with no registered handler, and handler
 * registration legitimately happens after discovery.
 */
export function formatAclNeverMatchesWarnings(
  findings: AclRuleFindingLike[] | null | undefined,
): string | null {
  if (!findings || findings.length === 0) return null;
  const lines = findings.map((f) => {
    const key = f.conditionKey ? ` (${f.conditionKey})` : "";
    return (
      `mcp.acl.rules[${f.ruleIndex}] '${f.conditionPath}'${key}: this pattern is ` +
      `well-formed but matches no legal module ID, so the '${f.effect}' rule protects ` +
      "nothing. It still loads and still changes no decision (PROTOCOL_SPEC §6.1.3) — " +
      "rewrite the pattern or remove the rule."
    );
  });
  return lines.join("\n");
}

export function formatUnprotectedControlSurfaceWarning(
  state: GovernanceStateLike,
): string | null {
  if (!state.unprotectedControlSurface) return null;

  const gaps: string[] = [];
  if (!state.aclConfigured) {
    gaps.push("No ACL is configured (executor.setAcl() / mcp.acl was never set).");
  } else if (!state.builtinAclGateWired) {
    gaps.push(
      "An ACL is configured, but the running execution strategy does not " +
        "include the built-in ACL gate, so the ACL is never consulted.",
    );
  }
  if (!state.builtinApprovalGateWired) {
    gaps.push(
      "The running execution strategy does not include the built-in " +
        "approval gate, so requiresApproval is never enforced.",
    );
  } else if (!state.allControlModulesRequireApproval) {
    gaps.push(
      "Not every registered system.control.* module declares " +
        "requiresApproval, so at least one bypasses the approval gate entirely.",
    );
  } else if (!state.approvalHandlerConfigured && !state.policyStrict) {
    gaps.push(
      "No ApprovalHandler is configured and no ExecutionPolicy({ strict: " +
        "true }) is set, so the approval gate SKIPS with a warning instead " +
        "of failing closed.",
    );
  }

  const rule = "=".repeat(78);
  const lines = [
    rule,
    "apcore-mcp WARNING: unprotected system.control.* management surface",
    rule,
    "system.control.update_config / reload_module / toggle_feature are",
    "registered and reachable via tools/call, but no recognised gate is",
    "currently protecting them:",
    "",
    ...gaps.map((gap) => `  - ${gap}`),
    "",
    "Close this before exposing this server outside a fully trusted process:",
    '  1. Configure an "acl/" directory with a rule covering targets:',
    '     ["system.control.*"] (see src/acl-builder.ts for a copy-pasteable',
    "     template), and/or",
    "  2. Register an ApprovalHandler (e.g. ElicitationApprovalHandler /",
    '     StorageBackedApprovalHandler) via the "approvalHandler" option, and/or',
    "  3. Set an ExecutionPolicy({ strict: true }) so the approval gate fails",
    "     closed instead of skipping when no handler is configured.",
    "",
    "This is a warning only — the server will continue to start.",
    rule,
  ];
  return lines.join("\n");
}

/**
 * Duck-typed `Executor.governanceState()` call (apcore-js>=0.28.0). Returns
 * `null` when the executor doesn't expose the method (older apcore-js) or
 * the call throws for any reason — this warning must never block startup.
 */
function tryGovernanceState(executor: Executor): GovernanceStateLike | null {
  const fn = (executor as { governanceState?: () => GovernanceStateLike }).governanceState;
  if (typeof fn !== "function") return null;
  try {
    return fn.call(executor);
  } catch {
    return null;
  }
}

/**
 * FR-ACL-004 / §6.2.1 tier 2: call `ACL.validateRules()` on the ACL actually
 * wired into this executor call, once it is fully assembled, and return its
 * findings — or `null` when there is no ACL, the ACL exposes no
 * `validateRules`, or the call itself throws. Mirrors `tryGovernanceState`'s
 * defensive shape: this is advisory diagnostics (PROTOCOL_SPEC §6.1.3), never
 * enforcement, so a thrown or missing accessor is silently skipped rather
 * than propagated.
 */
function tryValidateAclRules(acl: unknown): AclRuleFindingLike[] | null {
  if (!acl || typeof acl !== "object") return null;
  const fn = (acl as { validateRules?: () => AclRuleFindingLike[] }).validateRules;
  if (typeof fn !== "function") return null;
  try {
    return fn.call(acl);
  } catch {
    return null;
  }
}

/**
 * Scalar Config Bus keys consumed by serve()/asyncServe(). Snake-case names
 * match `MCP_DEFAULTS` in src/config.ts; serve() converts to camelCase and
 * applies a caller-wins precedence chain on top of these. [D9-002]
 */
interface ConfigBusDefaults {
  transport?: string;
  host?: string;
  port?: number;
  name?: string;
  logLevel?: string;
  validateInputs?: boolean;
  explorer?: boolean;
  explorerPrefix?: string;
  requireAuth?: boolean;
}

/**
 * Load Config Bus overrides for strategy, middleware, ACL, and the scalar
 * `mcp.*` keys consumed by serve()/asyncServe().
 *
 * F-040: YAML Pipeline Config via Config Bus. Extracted to eliminate the
 * byte-for-byte duplicate block that previously appeared in both serve() and
 * asyncServe(). Both functions call this helper and merge the results with
 * their caller-supplied values.
 *
 * D9-002: Also reads the 9 scalar `mcp.*` keys (transport, host, port, name,
 * log_level, validate_inputs, explorer, explorer_prefix, require_auth) so
 * users setting `APCORE_MCP_PORT=9000` (or `mcp.port: 9000` in YAML) actually
 * see the change take effect. Caller options still win over Config Bus.
 */
async function loadConfigBusOverrides(
  strategy: string | undefined,
  callerMiddleware: unknown[] | undefined,
  callerAcl: unknown | undefined,
): Promise<{
  resolvedStrategy: string | undefined;
  combinedMiddleware: unknown[];
  effectiveAcl: unknown | null;
  configOpenapi: unknown | null;
  configBusDefaults: ConfigBusDefaults;
}> {
  let resolvedStrategy = strategy;
  let configMiddleware: unknown[] = [];
  let configAcl: unknown | null = null;
  let configOpenapi: unknown | null = null;
  const configBusDefaults: ConfigBusDefaults = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apcoreConfig = await import("apcore-js") as any;
    const Config = apcoreConfig.Config ?? apcoreConfig.default?.Config;
    const buildStrategyFromConfig = apcoreConfig.buildStrategyFromConfig ?? apcoreConfig.default?.buildStrategyFromConfig;
    if (Config && buildStrategyFromConfig) {
      const config = typeof Config.getInstance === 'function' ? Config.getInstance() : new Config();
      const pipelineCfg = config.get?.("mcp.pipeline");
      if (pipelineCfg && typeof pipelineCfg === 'object' && Object.keys(pipelineCfg).length > 0) {
        if (resolvedStrategy) {
          console.warn(
            `YAML pipeline config found in Config Bus — overriding strategy='${resolvedStrategy}' with config-driven strategy.`,
          );
        }
        resolvedStrategy = buildStrategyFromConfig(pipelineCfg);
      }
      // Load declarative middleware from Config Bus (`mcp.middleware`).
      const mwCfg = config.get?.("mcp.middleware");
      if (Array.isArray(mwCfg) && mwCfg.length > 0) {
        const { buildMiddlewareFromConfig } = await import(
          "./middleware-builder.js"
        );
        configMiddleware = await buildMiddlewareFromConfig(mwCfg);
      }
      // Load declarative ACL from Config Bus (`mcp.acl`).
      const aclCfg = config.get?.("mcp.acl");
      if (aclCfg) {
        const { buildAclFromConfig } = await import("./acl-builder.js");
        configAcl = await buildAclFromConfig(aclCfg);
      }
      // Read (not build — the registry doesn't exist yet at this point in
      // serve()/asyncServe()) the `mcp.openapi` section. PRD F-054
      // Acceptance Criterion 1: `mcp.openapi.spec` alone must start a server.
      configOpenapi = config.get?.("mcp.openapi") ?? null;
      // [D9-002] Load 9 scalar mcp.* keys. Snake-case → camelCase.
      const readStr = (k: string): string | undefined => {
        const v = config.get?.(k);
        return typeof v === "string" ? v : undefined;
      };
      const readNum = (k: string): number | undefined => {
        const v = config.get?.(k);
        if (typeof v === "number") return v;
        if (typeof v === "string" && v !== "") {
          const n = Number(v);
          if (!Number.isNaN(n)) return n;
        }
        return undefined;
      };
      const readBool = (k: string): boolean | undefined => {
        const v = config.get?.(k);
        if (typeof v === "boolean") return v;
        if (typeof v === "string") {
          if (v === "true") return true;
          if (v === "false") return false;
        }
        return undefined;
      };
      configBusDefaults.transport = readStr("mcp.transport");
      configBusDefaults.host = readStr("mcp.host");
      configBusDefaults.port = readNum("mcp.port");
      configBusDefaults.name = readStr("mcp.name");
      configBusDefaults.logLevel = readStr("mcp.log_level");
      configBusDefaults.validateInputs = readBool("mcp.validate_inputs");
      configBusDefaults.explorer = readBool("mcp.explorer");
      configBusDefaults.explorerPrefix = readStr("mcp.explorer_prefix");
      configBusDefaults.requireAuth = readBool("mcp.require_auth");
    }
  } catch {
    // apcore-js not installed or Config Bus not available — use strategy param as-is
  }

  const combinedMiddleware: unknown[] = [...configMiddleware];
  if (callerMiddleware && callerMiddleware.length > 0) {
    combinedMiddleware.push(...callerMiddleware);
  }

  // Caller-supplied ACL wins over Config Bus.
  const effectiveAcl = callerAcl !== undefined ? callerAcl : configAcl;

  return { resolvedStrategy, combinedMiddleware, effectiveAcl, configOpenapi, configBusDefaults };
}

/**
 * Validate common serve/asyncServe options. Throws on invalid input.
 */
function validateServeOptions(options: {
  name?: string;
  tags?: string[] | null;
  prefix?: string | null;
  explorer?: boolean;
  explorerPrefix?: string;
}): void {
  const name = options.name ?? "apcore-mcp";
  if (!name || name.length === 0) {
    throw new Error("name must not be empty");
  }
  if (name.length > 255) {
    throw new Error("name must not exceed 255 characters");
  }
  if (options.tags) {
    for (const tag of options.tags) {
      if (!tag || tag.length === 0) {
        throw new Error("tags must not contain empty strings");
      }
    }
  }
  if (options.prefix !== undefined && options.prefix !== null && options.prefix.length === 0) {
    throw new Error("prefix must not be empty if provided");
  }
  if (options.explorer && !(options.explorerPrefix ?? "/explorer").startsWith("/")) {
    throw new Error("explorerPrefix must start with '/'");
  }
}

/** Common options shared by serve() and asyncServe(). */
export interface BaseServeOptions {
  /** MCP server name. Default: "apcore-mcp" */
  name?: string;
  /** MCP server version. Default: package version */
  version?: string;
  /** Enable input validation against schemas. Default: false */
  validateInputs?: boolean;
  /** Filter modules by tags. Default: null (no filtering) */
  tags?: string[] | null;
  /** Filter modules by prefix. Default: null (no filtering) */
  prefix?: string | null;
  /** Minimum log level. Suppresses console methods below this level. Default: undefined (no suppression) */
  logLevel?: "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
  /**
   * Optional MetricsCollector for Prometheus /metrics endpoint.
   *
   * - Pass a concrete `MetricsExporter` instance to surface its output on
   *   the `/metrics` endpoint (existing behaviour).
   * - Pass `true` to auto-instantiate apcore-js's `MetricsCollector` and
   *   install `MetricsMiddleware` via `executor.use()`.
   */
  metricsCollector?: MetricsExporter | boolean;
  /**
   * Enable the full observability stack (metrics + usage middleware). When
   * `true`, apcore-js's `MetricsCollector` + `MetricsMiddleware` AND
   * `UsageCollector` + `UsageMiddleware` are auto-instantiated and installed
   * on the executor. The transport exposes `/metrics` and `/usage` endpoints.
   */
  observability?: ObservabilityFlag;
  /** Enable the browser-based Tool Explorer UI (HTTP transports only). Default: false */
  explorer?: boolean;
  /** URL prefix for the explorer. Default: "/explorer" */
  explorerPrefix?: string;
  /** Allow tool execution from the explorer UI. Default: false */
  allowExecute?: boolean;
  /** Title for the explorer UI page. Default: "APCore MCP Explorer" */
  explorerTitle?: string;
  /** Project name shown in the explorer UI footer. Default: "apcore-mcp" */
  explorerProjectName?: string;
  /** Project URL shown in the explorer UI footer. */
  explorerProjectUrl?: string;
  /** Optional authenticator for request authentication (HTTP transports only). */
  authenticator?: Authenticator;
  /**
   * If true (default), unauthenticated requests are rejected with 401.
   * If false, requests proceed without identity (permissive mode).
   * Overrides the authenticator's own requireAuth when set explicitly.
   */
  requireAuth?: boolean;
  /** Custom paths exempt from authentication. Default: ["/health", "/metrics"] */
  exemptPaths?: string[];
  /** Optional approval handler passed to the Executor (e.g. ElicitationApprovalHandler). */
  approvalHandler?: unknown;
  /**
   * Pluggable ApprovalStore for Phase B async polling. When provided and no
   * explicit `approvalHandler` is given, a StorageBackedApprovalHandler is
   * auto-created and wired as the Executor's approval handler. If the store
   * exposes `start()`/`stop()`, its lifecycle is managed by serve()/asyncServe()
   * (e.g. the background sweep timer is started before the transport binds and
   * stopped on shutdown), preventing unbounded record growth.
   */
  approvalStore?: ApprovalStore;
  /**
   * Optional callback invoked when a new approval is requested. Used together
   * with `approvalStore` to fan out to Slack/email/webhooks.
   * Signature: (approvalId, moduleId, args) => Promise<void>
   */
  approvalNotify?: (approvalId: string, moduleId: string, args: Record<string, unknown>) => Promise<void>;
  /** Execution strategy name passed to the Executor constructor (e.g. "standard", "internal"). */
  strategy?: string;
  /**
   * Optional function that formats execution results into text for LLM consumption.
   * When undefined, results are serialised with `JSON.stringify(result)`.
   * Only applied to plain-object results; non-object results always use JSON.stringify.
   */
  outputFormatter?: (result: Record<string, unknown> | Array<unknown>) => string;
  /**
   * Optional built-in output format name ("json", "csv", "jsonl").
   * When set, automatically uses the corresponding formatter from `apcore-toolkit`.
   */
  outputFormat?: "json" | "csv" | "jsonl";
  /**
   * When true (default), redact sensitive fields from tool output using apcore's
   * `redactSensitive()` before formatting. Requires apcore-js to be installed.
   */
  redactOutput?: boolean;
  /**
   * When true, enable pipeline trace via callWithTrace(). Adds `_meta.trace`
   * to non-streaming tool responses. Default: false.
   */
  trace?: boolean;
  /**
   * Optional list of apcore `Middleware` instances to install on the Executor
   * via `executor.use()`. Appended to any middleware declared under Config
   * Bus key `mcp.middleware`. Chain execution order is controlled by
   * `Middleware.priority`, not insertion order.
   */
  middleware?: unknown[];
  /**
   * Optional apcore `ACL` instance to install via `executor.setAcl()`.
   * When omitted, the bridge falls back to any ACL declared under Config
   * Bus key `mcp.acl` (rules + default_effect). Caller-supplied ACL takes
   * precedence over Config Bus.
   */
  acl?: unknown;
  /**
   * Configure the Async Task Bridge (F-043). When `true` (default),
   * async-hinted modules (`metadata.async === true` OR
   * `annotations.extra["mcp_async"] === "true"`) route through the
   * AsyncTaskManager and the four `__apcore_task_*` meta-tools are
   * advertised. Pass `false` to disable entirely or an object for
   * fine-grained tuning.
   */
  async?: boolean | { enabled?: boolean; maxConcurrent?: number; maxTasks?: number };
}

/** Options for serve() */
export interface ServeOptions extends BaseServeOptions {
  /** Transport type. Default: "stdio" */
  transport?: "stdio" | "streamable-http" | "sse";
  /** Host address for HTTP-based transports. Default: "127.0.0.1" */
  host?: string;
  /** Port number for HTTP-based transports. Default: 8000 */
  port?: number;
  /** Enable dynamic tool registration/unregistration. Default: false */
  dynamic?: boolean;
  /** Callback invoked before the server starts. */
  onStartup?: () => void | Promise<void>;
  /** Callback invoked after the server stops (or on error). */
  onShutdown?: () => void | Promise<void>;
}

/**
 * Launch an MCP Server that exposes all apcore modules as tools.
 *
 * @param registryOrExecutor - An apcore Registry or Executor instance.
 * @param options - Server configuration options.
 */
export async function serve(
  registryOrExecutor: RegistryOrExecutor | undefined = undefined,
  options: ServeOptions = {},
): Promise<void> {
  // [D9-002] Apply caller-wins precedence: caller option → Config Bus → hardcoded
  // default. We can't tell at the destructure step whether a value came from the
  // caller or from a hardcoded default, so for the 9 scalar keys we destructure
  // raw (no inline default) and resolve below, after loadConfigBusOverrides runs.
  const {
    transport: optTransport,
    host: optHost,
    port: optPort,
    name: optName,
    version = VERSION,
    validateInputs: optValidateInputs,
    tags,
    prefix,
    logLevel: optLogLevel,
    onStartup,
    onShutdown,
    metricsCollector,
    explorer: optExplorer,
    explorerPrefix: optExplorerPrefix,
    allowExecute = false,
    explorerTitle = "APCore MCP Explorer",
    explorerProjectName = "apcore-mcp",
    explorerProjectUrl = "https://github.com/aiperceivable/apcore-mcp-typescript",
    authenticator,
    requireAuth: optRequireAuth,
    exemptPaths,
    approvalHandler,
    approvalStore,
    approvalNotify,
    outputFormatter,
    outputFormat,
    redactOutput,
    strategy,
    trace,
    middleware: callerMiddleware,
    acl: callerAcl,
    observability: observabilityFlag,
    async: asyncFlag,
  } = options;

  // Phase B: when an ApprovalStore is supplied without an explicit handler,
  // auto-create a StorageBackedApprovalHandler so direct serve() callers get
  // the same wiring as the APCoreMCP class. Store lifecycle (start/stop) is
  // managed below so the background sweep timer runs even for this path.
  const effectiveApprovalHandler =
    approvalHandler ??
    (approvalStore
      ? new StorageBackedApprovalHandler(approvalStore, { notifyCallback: approvalNotify })
      : undefined);

  // Save original console methods before suppression. Suppression itself
  // happens AFTER Config Bus resolution so that `mcp.log_level` from YAML or
  // `APCORE_MCP_LOG_LEVEL` from env can drive it. [D9-002]
  const origDebug = console.debug;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;

  // ── F-040: YAML Pipeline Config via Config Bus ─────────────────────
  const { resolvedStrategy, combinedMiddleware, effectiveAcl, configOpenapi, configBusDefaults } =
    await loadConfigBusOverrides(strategy, callerMiddleware, callerAcl);

  // PRD F-054 Acceptance Criterion 1: `mcp.openapi.spec` alone, with no
  // explicit backend and no CLI flag, must start a server. When a backend
  // IS given and `mcp.openapi` is ALSO configured, the two are unioned
  // (given backend first, OpenAPI operations layered on top) and
  // `mcp.openapi.prefix` becomes required — enforced inside
  // `openapiBackend`'s own `hasOtherBackendSource` check.
  let resolvedBackend: RegistryOrExecutor;
  if (registryOrExecutor === undefined) {
    if (!configOpenapi) {
      throw new Error(
        "registryOrExecutor is required unless mcp.openapi.spec is configured on the Config " +
          "Bus (PRD F-054). Pass a Registry/Executor, or set mcp.openapi.spec.",
      );
    }
    const { buildOpenapiBackendFromConfig } = await import("./openapi-backend.js");
    resolvedBackend = (await buildOpenapiBackendFromConfig(configOpenapi)) as unknown as RegistryOrExecutor;
  } else {
    resolvedBackend = registryOrExecutor;
    if (configOpenapi) {
      const { buildOpenapiBackendFromConfig } = await import("./openapi-backend.js");
      await buildOpenapiBackendFromConfig(configOpenapi, {
        // Structural (this package's `Registry`) vs. nominal (apcore-js's
        // class-based `Registry`) type mismatch — same cast convention used
        // throughout this codebase's apcore-js interop (e.g.
        // tests/acl-approval-gating-e2e.test.ts) for the identical reason.
        registry: resolveRegistry(resolvedBackend) as never,
        hasOtherBackendSource: true,
      });
    }
  }

  // [D9-002] Resolve scalar config values: caller → Config Bus → hardcoded default.
  const transport = optTransport ?? configBusDefaults.transport ?? "stdio";
  const host = optHost ?? configBusDefaults.host ?? "127.0.0.1";
  const port = optPort ?? configBusDefaults.port ?? 8000;
  const name = optName ?? configBusDefaults.name ?? "apcore-mcp";
  const validateInputs = optValidateInputs ?? configBusDefaults.validateInputs;
  const logLevel = optLogLevel ?? configBusDefaults.logLevel;
  const explorer = optExplorer ?? configBusDefaults.explorer ?? false;
  const explorerPrefix = optExplorerPrefix ?? configBusDefaults.explorerPrefix ?? "/explorer";
  const requireAuth = optRequireAuth ?? configBusDefaults.requireAuth;

  // Input validation (matching Python's checks) — moved here so it sees
  // Config-Bus-resolved values.
  validateServeOptions({ name, tags, prefix, explorer, explorerPrefix });

  // Apply log-level suppression (post-resolution so Config Bus values apply).
  if (logLevel) {
    const levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
    const minLevel = levels.indexOf(logLevel);
    if (minLevel > 0) console.debug = () => { };
    if (minLevel > 1) console.info = () => { };
    if (minLevel > 2) console.warn = () => { };
    if (minLevel > 3) console.error = () => { };
  }

  const registry = resolveRegistry(resolvedBackend);
  const executor = await resolveExecutor(resolvedBackend, {
    approvalHandler: effectiveApprovalHandler,
    strategy: resolvedStrategy,
    middleware: combinedMiddleware,
    acl: effectiveAcl,
  });

  // aiperceivable/apcore-mcp#15(b): ACL/approval/policy are fully wired by
  // this point (resolveExecutor above). Warn — before the server actually
  // starts — when system.control.* is registered and reachable with no
  // recognised gate in front of it. Uses origWarn (not console.warn) so the
  // warning is never silenced by `logLevel`. Warning only; never blocks
  // startup.
  const governanceState = tryGovernanceState(executor);
  if (governanceState) {
    const warning = formatUnprotectedControlSurfaceWarning(governanceState);
    if (warning) origWarn(warning);
  }

  // FR-ACL-004 / §6.2.1 tier 2: report ACL rules that loaded cleanly and can
  // protect nothing (e.g. ["$not", "*"]) — a well-formed pattern array that
  // matches no legal module ID. Same placement and advisory contract as the
  // governance-state warning above: never blocks startup, uses origWarn so
  // it survives `logLevel` suppression.
  const aclFindings = tryValidateAclRules(effectiveAcl);
  if (aclFindings) {
    const warning = formatAclNeverMatchesWarnings(aclFindings);
    if (warning) origWarn(warning);
  }

  // Phase B: start the store's background sweep before the transport binds so
  // resolved/abandoned records are reclaimed. Stopped in the finally below.
  if (approvalStore && typeof approvalStore.start === "function") {
    approvalStore.start();
  }

  // ── F-044: observability auto-wire (metrics + usage middleware) ──────
  const obsStack = await installObservability(
    executor,
    metricsCollector,
    observabilityFlag,
  );
  const resolvedMetricsCollector = obsStack.metricsCollector;

  // Register MCP config namespace and error formatter (idempotent)
  registerMcpNamespace();
  await registerMcpFormatter();

  // Build output schema map for redaction
  const outputSchemaMap = buildOutputSchemaMap(registry);

  // ── F-043: AsyncTaskBridge ───────────────────────────────────────────
  const asyncOpt = typeof asyncFlag === "object" ? asyncFlag : null;
  const asyncEnabled = asyncFlag === undefined ? true : asyncFlag !== false;
  const asyncBridge: AsyncTaskBridge | null = asyncEnabled
    ? await createAsyncTaskBridge(executor, {
        enabled: true,
        maxConcurrent: asyncOpt?.maxConcurrent,
        maxTasks: asyncOpt?.maxTasks,
        outputSchemaMap,
        // [A-D-008]: enable ASYNC_MODULE_NOT_ASYNC enforcement on
        // __apcore_task_submit by giving the bridge a way to fetch the
        // descriptor for a module id.
        descriptorLookup: (moduleId: string) =>
          (registry as { getDefinition?: (id: string) => ModuleDescriptor | null | undefined })
            .getDefinition?.(moduleId) ?? null,
      })
    : null;

  // Build MCP server components
  const factory = new MCPServerFactory();
  // aiperceivable/apcore-mcp#16 phase A: advertise `com.aiperceivable/management`
  // in `initialize` capabilities only for surfaces actually registered.
  const managementSurfaces = computeManagementSurfaces(registry);
  const server = factory.createServer(name, version, managementSurfaces);
  let tools = factory.buildTools(registry, { tags, prefix });
  tools = factory.attachAsyncMetaTools(tools, asyncBridge ?? undefined);
  const router = new ExecutionRouter(executor, {
    validateInputs,
    outputFormatter,
    outputFormat,
    redactOutput,
    outputSchemaMap,
    trace,
    asyncTaskBridge: asyncBridge ?? undefined,
  });
  factory.registerHandlers(server, tools, router);
  factory.registerResourceHandlers(server, registry, router);

  // Start dynamic tool registration listener if enabled
  if (options.dynamic) {
    const listener = new RegistryListener(registry, factory);
    listener.start();
    origInfo("Dynamic tool registration enabled via RegistryListener");
  }

  origInfo(
    `Starting MCP server '${name}' v${version} with ${tools.length} tools via ${transport}`,
  );

  // Invoke startup callback
  await onStartup?.();

  // Select and run transport
  const transportManager = new TransportManager();
  transportManager.setModuleCount(tools.length);
  if (resolvedMetricsCollector) {
    transportManager.setMetricsCollector(resolvedMetricsCollector);
  }
  if (obsStack.usageCollector) {
    transportManager.setUsageCollector(obsStack.usageCollector);
  }
  // [A-D-018] Wire the bridge so transport-level disconnect events
  // trigger cancelSessionTasks(sessionId) for cooperative cancellation.
  // Defensive call — older mocks/test doubles may lack the setter.
  if (asyncBridge && typeof transportManager.setAsyncTaskBridge === "function") {
    transportManager.setAsyncTaskBridge(asyncBridge);
  }
  if (authenticator) {
    transportManager.setAuthenticator(authenticator);
  }
  if (requireAuth !== undefined) {
    transportManager.setRequireAuth(requireAuth);
  }
  if (exemptPaths) {
    transportManager.setExemptPaths(exemptPaths);
  }

  // Mount explorer for HTTP transports only
  const transportLower = transport.toLowerCase();
  if (explorer && (transportLower === "streamable-http" || transportLower === "sse")) {
    // Build auth hook for POST (tool execution) calls
    const authHook = authenticator
      ? buildExplorerAuthHook(authenticator, { requireAuth })
      : undefined;

    const explorerNodeHandler = createNodeHandler(
      tools as UITool[],
      async (name: string, args: Record<string, unknown>) => router.handleCall(name, args),
      {
        prefix: explorerPrefix,
        allowExecute,
        authHook,
        title: explorerTitle,
        projectName: explorerProjectName,
        projectUrl: explorerProjectUrl,
      },
    );
    transportManager.setExplorer(explorerNodeHandler, explorerPrefix);
    origInfo(`Tool Explorer enabled at ${explorerPrefix}`);
  }

  try {
    if (transport === "stdio") {
      await transportManager.runStdio(server);
    } else if (transport === "streamable-http") {
      await transportManager.runStreamableHttp(server, { host, port });
    } else if (transport === "sse") {
      await transportManager.runSse(server, { host, port });
    } else {
      throw new Error(
        `Unknown transport: '${transport as string}'. Expected 'stdio', 'streamable-http', or 'sse'.`,
      );
    }
  } finally {
    console.debug = origDebug;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origError;
    if (asyncBridge?.manager.shutdown) {
      try {
        await asyncBridge.manager.shutdown();
      } catch (err) {
        origWarn("[apcore-mcp] AsyncTaskManager shutdown failed:", err);
      }
    }
    if (approvalStore && typeof approvalStore.stop === "function") {
      approvalStore.stop();
    }
    await onShutdown?.();
  }
}

/** Options for asyncServe() — extends BaseServeOptions with embed-specific options. */
export interface AsyncServeOptions extends BaseServeOptions {
  /** MCP endpoint path. Default: "/mcp" */
  endpoint?: string;
  /**
   * Enable dynamic tool registration/unregistration via RegistryListener.
   * Default: false. The listener is torn down by the returned `close()`.
   */
  dynamic?: boolean;
}

/** Return type of asyncServe(). */
export interface AsyncServeApp {
  /** Node.js HTTP request handler — mount this in your HTTP server. */
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>;
  /** Clean up the MCP transport. Call this when shutting down. */
  close: () => Promise<void>;
}

/**
 * Build an embeddable MCP HTTP request handler for mounting into a larger server.
 *
 * Unlike `serve()`, this does NOT create its own HTTP server. Instead it returns
 * a Node.js HTTP request handler that you can wire into `http.createServer()`,
 * Express, or any framework that accepts `(req, res) => void`.
 *
 * This is the TypeScript equivalent of Python's `async_serve()` context manager
 * that yields a Starlette ASGI app.
 *
 * @example
 * ```ts
 * import { createServer } from "node:http";
 * import { asyncServe } from "apcore-mcp";
 *
 * const { handler, close } = await asyncServe(registry, { explorer: true });
 *
 * const server = createServer((req, res) => {
 *   // Mount MCP under /mcp prefix or handle other routes
 *   handler(req, res);
 * });
 * server.listen(8000);
 *
 * // On shutdown:
 * await close();
 * ```
 */
export async function asyncServe(
  registryOrExecutor: RegistryOrExecutor | undefined = undefined,
  options: AsyncServeOptions = {},
): Promise<AsyncServeApp> {
  // [D9-002] See serve() for the rationale on the optX naming and post-load resolution.
  const {
    name: optName,
    version = VERSION,
    validateInputs: optValidateInputs,
    tags,
    prefix,
    logLevel: optLogLevel,
    metricsCollector,
    explorer: optExplorer,
    explorerPrefix: optExplorerPrefix,
    allowExecute = false,
    explorerTitle = "APCore MCP Explorer",
    explorerProjectName = "apcore-mcp",
    explorerProjectUrl = "https://github.com/aiperceivable/apcore-mcp-typescript",
    authenticator,
    requireAuth: optRequireAuth,
    exemptPaths,
    approvalHandler,
    approvalStore,
    approvalNotify,
    endpoint,
    outputFormatter,
    outputFormat,
    redactOutput,
    strategy,
    trace,
    dynamic,
    middleware: callerMiddleware,
    acl: callerAcl,
    observability: observabilityFlag,
    async: asyncFlag,
  } = options;

  // Phase B: auto-create a StorageBackedApprovalHandler from an ApprovalStore
  // when no explicit handler is given. See serve() for rationale.
  const effectiveApprovalHandler =
    approvalHandler ??
    (approvalStore
      ? new StorageBackedApprovalHandler(approvalStore, { notifyCallback: approvalNotify })
      : undefined);

  // Save original console methods before suppression. Suppression itself
  // happens AFTER Config Bus resolution so that `mcp.log_level` from YAML or
  // `APCORE_MCP_LOG_LEVEL` from env can drive it. [D9-002]
  const origDebug = console.debug;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;

  // ── F-040: YAML Pipeline Config via Config Bus ─────────────────────
  const { resolvedStrategy, combinedMiddleware, effectiveAcl, configOpenapi, configBusDefaults } =
    await loadConfigBusOverrides(strategy, callerMiddleware, callerAcl);

  // PRD F-054 Acceptance Criterion 1: `mcp.openapi.spec` alone, with no
  // explicit backend and no CLI flag, must start a server. When a backend
  // IS given and `mcp.openapi` is ALSO configured, the two are unioned
  // (given backend first, OpenAPI operations layered on top) and
  // `mcp.openapi.prefix` becomes required — enforced inside
  // `openapiBackend`'s own `hasOtherBackendSource` check.
  let resolvedBackend: RegistryOrExecutor;
  if (registryOrExecutor === undefined) {
    if (!configOpenapi) {
      throw new Error(
        "registryOrExecutor is required unless mcp.openapi.spec is configured on the Config " +
          "Bus (PRD F-054). Pass a Registry/Executor, or set mcp.openapi.spec.",
      );
    }
    const { buildOpenapiBackendFromConfig } = await import("./openapi-backend.js");
    resolvedBackend = (await buildOpenapiBackendFromConfig(configOpenapi)) as unknown as RegistryOrExecutor;
  } else {
    resolvedBackend = registryOrExecutor;
    if (configOpenapi) {
      const { buildOpenapiBackendFromConfig } = await import("./openapi-backend.js");
      await buildOpenapiBackendFromConfig(configOpenapi, {
        // Structural (this package's `Registry`) vs. nominal (apcore-js's
        // class-based `Registry`) type mismatch — same cast convention used
        // throughout this codebase's apcore-js interop (e.g.
        // tests/acl-approval-gating-e2e.test.ts) for the identical reason.
        registry: resolveRegistry(resolvedBackend) as never,
        hasOtherBackendSource: true,
      });
    }
  }

  // [D9-002] Resolve scalar config values: caller → Config Bus → hardcoded default.
  // asyncServe does not bind a transport (returns an ASGI-style app); transport,
  // host, and port are not part of AsyncServeOptions.
  const name = optName ?? configBusDefaults.name ?? "apcore-mcp";
  const validateInputs = optValidateInputs ?? configBusDefaults.validateInputs;
  const logLevel = optLogLevel ?? configBusDefaults.logLevel;
  const explorer = optExplorer ?? configBusDefaults.explorer ?? false;
  const explorerPrefix = optExplorerPrefix ?? configBusDefaults.explorerPrefix ?? "/explorer";
  const requireAuth = optRequireAuth ?? configBusDefaults.requireAuth;

  // Input validation (matching Python's checks) — moved here so it sees
  // Config-Bus-resolved values.
  validateServeOptions({ name, tags, prefix, explorer, explorerPrefix });

  // Apply log-level suppression (post-resolution so Config Bus values apply).
  if (logLevel) {
    const levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
    const minLevel = levels.indexOf(logLevel);
    if (minLevel > 0) console.debug = () => { };
    if (minLevel > 1) console.info = () => { };
    if (minLevel > 2) console.warn = () => { };
    if (minLevel > 3) console.error = () => { };
  }

  const registry = resolveRegistry(resolvedBackend);
  const executor = await resolveExecutor(resolvedBackend, {
    approvalHandler: effectiveApprovalHandler,
    strategy: resolvedStrategy,
    middleware: combinedMiddleware,
    acl: effectiveAcl,
  });

  // aiperceivable/apcore-mcp#15(b): see serve() for rationale — warn before
  // the app is built when system.control.* is reachable with no recognised
  // gate. Warning only; never blocks startup.
  const governanceState = tryGovernanceState(executor);
  if (governanceState) {
    const warning = formatUnprotectedControlSurfaceWarning(governanceState);
    if (warning) origWarn(warning);
  }

  // FR-ACL-004 / §6.2.1 tier 2: report ACL rules that loaded cleanly and can
  // protect nothing (e.g. ["$not", "*"]) — a well-formed pattern array that
  // matches no legal module ID. Same placement and advisory contract as the
  // governance-state warning above: never blocks startup, uses origWarn so
  // it survives `logLevel` suppression.
  const aclFindings = tryValidateAclRules(effectiveAcl);
  if (aclFindings) {
    const warning = formatAclNeverMatchesWarnings(aclFindings);
    if (warning) origWarn(warning);
  }

  // Phase B: start the store's background sweep. Stopped in the wrapped close().
  if (approvalStore && typeof approvalStore.start === "function") {
    approvalStore.start();
  }

  // ── F-044: observability auto-wire ───────────────────────────────────
  const obsStack = await installObservability(
    executor,
    metricsCollector,
    observabilityFlag,
  );
  const resolvedMetricsCollector = obsStack.metricsCollector;

  // Register MCP config namespace and error formatter (idempotent)
  registerMcpNamespace();
  await registerMcpFormatter();

  // Build output schema map for redaction
  const outputSchemaMap = buildOutputSchemaMap(registry);

  // ── F-043: AsyncTaskBridge ───────────────────────────────────────────
  const asyncOpt = typeof asyncFlag === "object" ? asyncFlag : null;
  const asyncEnabled = asyncFlag === undefined ? true : asyncFlag !== false;
  const asyncBridge: AsyncTaskBridge | null = asyncEnabled
    ? await createAsyncTaskBridge(executor, {
        enabled: true,
        maxConcurrent: asyncOpt?.maxConcurrent,
        maxTasks: asyncOpt?.maxTasks,
        outputSchemaMap,
        // [A-D-008]: enable ASYNC_MODULE_NOT_ASYNC enforcement on
        // __apcore_task_submit by giving the bridge a way to fetch the
        // descriptor for a module id.
        descriptorLookup: (moduleId: string) =>
          (registry as { getDefinition?: (id: string) => ModuleDescriptor | null | undefined })
            .getDefinition?.(moduleId) ?? null,
      })
    : null;

  // Build MCP server components
  const factory = new MCPServerFactory();
  // aiperceivable/apcore-mcp#16 phase A: advertise `com.aiperceivable/management`
  // in `initialize` capabilities only for surfaces actually registered.
  const managementSurfaces = computeManagementSurfaces(registry);
  const server = factory.createServer(name, version, managementSurfaces);
  let tools = factory.buildTools(registry, { tags, prefix });
  tools = factory.attachAsyncMetaTools(tools, asyncBridge ?? undefined);
  const router = new ExecutionRouter(executor, {
    validateInputs,
    outputFormatter,
    outputFormat,
    redactOutput,
    outputSchemaMap,
    trace,
    asyncTaskBridge: asyncBridge ?? undefined,
  });
  factory.registerHandlers(server, tools, router);
  factory.registerResourceHandlers(server, registry, router);

  // Start dynamic tool registration listener if enabled. The embedded handler
  // has no explicit stop hook, so the listener's teardown is wired into the
  // returned close() below. [item 3]
  let registryListener: RegistryListener | null = null;
  if (dynamic) {
    registryListener = new RegistryListener(registry, factory);
    registryListener.start();
    console.info("Dynamic tool registration enabled via RegistryListener");
  }

  console.info(
    `Building MCP app '${name}' v${version} with ${tools.length} tools`,
  );

  // Configure transport manager
  const transportManager = new TransportManager();
  transportManager.setModuleCount(tools.length);
  if (resolvedMetricsCollector) {
    transportManager.setMetricsCollector(resolvedMetricsCollector);
  }
  if (obsStack.usageCollector) {
    transportManager.setUsageCollector(obsStack.usageCollector);
  }
  // [A-D-018] Same wiring as serve() — transport-level disconnect
  // triggers cooperative cancellation of session-bound async tasks.
  if (asyncBridge && typeof transportManager.setAsyncTaskBridge === "function") {
    transportManager.setAsyncTaskBridge(asyncBridge);
  }
  if (authenticator) {
    transportManager.setAuthenticator(authenticator);
  }
  if (requireAuth !== undefined) {
    transportManager.setRequireAuth(requireAuth);
  }
  if (exemptPaths) {
    transportManager.setExemptPaths(exemptPaths);
  }

  // Mount explorer
  if (explorer) {
    const authHook = authenticator
      ? buildExplorerAuthHook(authenticator, { requireAuth })
      : undefined;

    const explorerNodeHandler = createNodeHandler(
      tools as UITool[],
      async (name: string, args: Record<string, unknown>) => router.handleCall(name, args),
      {
        prefix: explorerPrefix,
        allowExecute,
        authHook,
        title: explorerTitle,
        projectName: explorerProjectName,
        projectUrl: explorerProjectUrl,
      },
    );
    transportManager.setExplorer(explorerNodeHandler, explorerPrefix);
    console.info(`Tool Explorer enabled at ${explorerPrefix}`);
  }

  // Build the embeddable HTTP handler, wrapping close() to restore console methods
  const app = await transportManager.buildStreamableHttpApp(server, { endpoint });
  const originalClose = app.close;
  app.close = async () => {
    await originalClose();
    if (registryListener) {
      registryListener.stop();
    }
    if (asyncBridge?.manager.shutdown) {
      try {
        await asyncBridge.manager.shutdown();
      } catch (err) {
        origWarn("[apcore-mcp] AsyncTaskManager shutdown failed:", err);
      }
    }
    if (approvalStore && typeof approvalStore.stop === "function") {
      approvalStore.stop();
    }
    console.debug = origDebug;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origError;
  };
  return app;
}

/** Options for toOpenaiTools() */
export interface ToOpenaiToolsOptions extends ConvertRegistryOptions { }

/**
 * Export apcore Registry modules as OpenAI-compatible tool definitions.
 *
 * @param registryOrExecutor - An apcore Registry or Executor instance.
 * @param options - Conversion options.
 * @returns List of OpenAI tool definition dicts.
 */
export function toOpenaiTools(
  registryOrExecutor: RegistryOrExecutor,
  options: ToOpenaiToolsOptions = {},
): OpenAIToolDef[] {
  const registry = resolveRegistry(registryOrExecutor);
  const converter = new OpenAIConverter();
  const tools = converter.convertRegistry(registry, options);
  return tools;
}
