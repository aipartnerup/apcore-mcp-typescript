/**
 * APCore MCP Bridge — Type Definitions
 *
 * All interfaces use camelCase to match apcore-typescript conventions.
 * The protocol spec uses snake_case as canonical; this file maps to TypeScript idioms.
 */

// ─── Type Aliases ────────────────────────────────────────────────────────────

export type JsonSchema = Record<string, unknown>;
export type RegistryOrExecutor = Registry | Executor;

// ─── Constants ───────────────────────────────────────────────────────────────

/** Standard registry event names. */
export const REGISTRY_EVENTS = Object.freeze({
  REGISTER: "register",
  UNREGISTER: "unregister",
} as const);

/** Framework error codes used by ErrorMapper. */
export const ErrorCodes = Object.freeze({
  MODULE_NOT_FOUND: "MODULE_NOT_FOUND",
  MODULE_DISABLED: "MODULE_DISABLED",
  SCHEMA_VALIDATION_ERROR: "SCHEMA_VALIDATION_ERROR",
  ACL_DENIED: "ACL_DENIED",
  CALL_DEPTH_EXCEEDED: "CALL_DEPTH_EXCEEDED",
  CIRCULAR_CALL: "CIRCULAR_CALL",
  CALL_FREQUENCY_EXCEEDED: "CALL_FREQUENCY_EXCEEDED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  GENERAL_INTERNAL_ERROR: "GENERAL_INTERNAL_ERROR",
  MODULE_TIMEOUT: "MODULE_TIMEOUT",
  MODULE_LOAD_ERROR: "MODULE_LOAD_ERROR",
  MODULE_EXECUTE_ERROR: "MODULE_EXECUTE_ERROR",
  GENERAL_INVALID_INPUT: "GENERAL_INVALID_INPUT",
  APPROVAL_DENIED: "APPROVAL_DENIED",
  APPROVAL_TIMEOUT: "APPROVAL_TIMEOUT",
  APPROVAL_PENDING: "APPROVAL_PENDING",
  VERSION_INCOMPATIBLE: "VERSION_INCOMPATIBLE",
  ERROR_CODE_COLLISION: "ERROR_CODE_COLLISION",
  EXECUTION_CANCELLED: "EXECUTION_CANCELLED",
  CONFIG_NAMESPACE_DUPLICATE: "CONFIG_NAMESPACE_DUPLICATE",
  CONFIG_NAMESPACE_RESERVED: "CONFIG_NAMESPACE_RESERVED",
  CONFIG_ENV_PREFIX_CONFLICT: "CONFIG_ENV_PREFIX_CONFLICT",
  CONFIG_MOUNT_ERROR: "CONFIG_MOUNT_ERROR",
  CONFIG_BIND_ERROR: "CONFIG_BIND_ERROR",
  ERROR_FORMATTER_DUPLICATE: "ERROR_FORMATTER_DUPLICATE",
  CONFIG_ENV_MAP_CONFLICT: "CONFIG_ENV_MAP_CONFLICT",
  PIPELINE_ABORT: "PIPELINE_ABORT",
  STEP_NOT_FOUND: "STEP_NOT_FOUND",
  DEPENDENCY_NOT_FOUND: "DEPENDENCY_NOT_FOUND",
  DEPENDENCY_VERSION_MISMATCH: "DEPENDENCY_VERSION_MISMATCH",
  TASK_LIMIT_EXCEEDED: "TASK_LIMIT_EXCEEDED",
  VERSION_CONSTRAINT_INVALID: "VERSION_CONSTRAINT_INVALID",
  BINDING_SCHEMA_INFERENCE_FAILED: "BINDING_SCHEMA_INFERENCE_FAILED",
  BINDING_SCHEMA_MODE_CONFLICT: "BINDING_SCHEMA_MODE_CONFLICT",
  BINDING_STRICT_SCHEMA_INCOMPATIBLE: "BINDING_STRICT_SCHEMA_INCOMPATIBLE",
  BINDING_POLICY_VIOLATION: "BINDING_POLICY_VIOLATION",
  // apcore 0.20.0 sync alignment A-001: CircuitBreakerMiddleware emits
  // CIRCUIT_BREAKER_OPEN when the breaker is in the OPEN state.
  CIRCUIT_BREAKER_OPEN: "CIRCUIT_BREAKER_OPEN",
} as const);

/** Dot-namespaced event types introduced in apcore 0.15.0 (§9.16). */
export const APCORE_EVENTS = Object.freeze({
  MODULE_TOGGLED: "apcore.module.toggled",
  MODULE_RELOADED: "apcore.module.reloaded",
  CONFIG_UPDATED: "apcore.config.updated",
  HEALTH_RECOVERED: "apcore.health.recovered",
} as const);

/** Valid module ID pattern. No hyphens allowed. */
export const MODULE_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

// ─── Module Types ────────────────────────────────────────────────────────────

export interface ModuleAnnotations {
  readonly: boolean;
  destructive: boolean;
  idempotent: boolean;
  requiresApproval: boolean;
  openWorld: boolean;
  streaming: boolean;
  cacheable?: boolean;
  cacheTtl?: number;
  /**
   * Input fields used to compute the cache key (null = all fields).
   *
   * [B-TS-3] Declared `readonly string[]` to match apcore-js's own
   * `ModuleAnnotations.cacheKeyFields`. A mutable `string[]` here made every real
   * apcore-js `Registry` fail to satisfy this interface (TS2345), which broke the
   * documented "pass an existing Registry" pattern for all TypeScript consumers.
   */
  cacheKeyFields?: readonly string[] | null;
  paginated?: boolean;
  paginationStyle?: string;
  extra?: Record<string, unknown>;
}

export interface ModuleDescriptor {
  moduleId: string;
  name?: string | null;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: ModuleAnnotations | null;
  documentation?: string | null;
  tags?: string[];
  version?: string;
  examples?: unknown[];
  metadata?: Record<string, unknown>;
  sunsetDate?: string | null;
}

// ─── Core Interfaces (duck-typed for apcore-typescript compatibility) ────────

export interface Registry {
  list(options?: { tags?: string[] | null; prefix?: string | null }): string[];
  getDefinition(moduleId: string): ModuleDescriptor | null;
  has?(moduleId: string): boolean;
  on(event: string, callback: (...args: unknown[]) => void): void;
  discover?(): Promise<number>;
  exportSchema?(moduleId: string, strict?: boolean): Record<string, unknown> | null;
}

export interface Executor {
  registry: Registry;
  call(moduleId: string, inputs: Record<string, unknown>, context?: unknown, versionHint?: string): Promise<Record<string, unknown>>;
  callAsync?(moduleId: string, inputs: Record<string, unknown>, context?: unknown, versionHint?: string): Promise<Record<string, unknown>>;
  stream?(moduleId: string, inputs: Record<string, unknown>, context?: unknown, versionHint?: string): AsyncIterable<Record<string, unknown>>;
  validate?(toolName: string, args: Record<string, unknown>): unknown | Promise<unknown>;
  callWithTrace?(moduleId: string, inputs: Record<string, unknown>, context?: unknown, versionHint?: string): Promise<[Record<string, unknown>, unknown]>;
}

// ─── Error Type ──────────────────────────────────────────────────────────────

export interface ModuleError extends Error {
  code: string;
  details: Record<string, unknown> | null;
}

// ─── MCP Types ───────────────────────────────────────────────────────────────

export interface McpAnnotationsDict {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
  title: string | null;
}

export interface McpErrorResponse {
  isError: true;
  errorType: string;
  message: string;
  details: Record<string, unknown> | null;
  retryable?: boolean;
  aiGuidance?: string;
  userFixable?: boolean;
  suggestion?: string;
}

// ─── OpenAI Types ────────────────────────────────────────────────────────────

export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
    strict?: boolean;
  };
}

// ─── Utility Types ───────────────────────────────────────────────────────────

export interface TextContentDict {
  type: "text";
  text: string;
}
