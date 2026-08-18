/**
 * ErrorMapper - Maps apcore errors to MCP-compatible error responses.
 *
 * Handles ModuleError instances with specific error codes, sanitizes
 * internal error details, formats schema validation errors with
 * field-level detail, and extracts AI guidance fields.
 *
 * Cross-language contract: apcore-js exposes concrete error classes
 * (e.g. `TaskLimitExceededError`). We prefer `instanceof` dispatch when
 * those classes are importable so structured fields flow through
 * losslessly; we fall back to duck-typing (`error.code` inspection)
 * when apcore-js is unavailable or the caller constructs a bare
 * `ModuleError`.
 */

import { ErrorCodes } from "../types.js";
import type { McpErrorResponse } from "../types.js";

/**
 * Canonical GENERAL_INTERNAL_ERROR envelope for non-ModuleError fallback.
 *
 * All three SDKs (Python, TypeScript, Rust) emit byte-identical envelopes so
 * MCP clients can branch on `errorType === "GENERAL_INTERNAL_ERROR"` portably.
 * See `apcore-mcp/docs/features/error-mapper.md` (EM-6).
 */
export function internalErrorResponse(): McpErrorResponse {
  return {
    isError: true,
    errorType: ErrorCodes.GENERAL_INTERNAL_ERROR,
    message: "Internal error occurred",
    details: null,
  };
}

/**
 * Lazy snapshot of apcore-js error classes used for `instanceof` dispatch.
 * Populated on first use; falls back to duck-typing when apcore-js is
 * unavailable. Cached across calls for perf.
 *
 * `ModuleError` is the documented base class for all structured apcore errors.
 * `toMcpErrorAny` uses it as a downcast pivot, mirroring Rust's
 * `to_mcp_error_any` which checks `err.downcast_ref::<ModuleError>()` before
 * collapsing to the canonical envelope.
 */
let _apcoreErrorClasses: {
  ModuleError?: new (...args: unknown[]) => Error;
  TaskLimitExceededError?: new (...args: unknown[]) => Error;
  VersionConstraintError?: new (...args: unknown[]) => Error;
  DependencyNotFoundError?: new (...args: unknown[]) => Error;
  DependencyVersionMismatchError?: new (...args: unknown[]) => Error;
  loaded?: true;
} | null = null;

async function _loadApcoreErrorClasses(): Promise<NonNullable<typeof _apcoreErrorClasses>> {
  if (_apcoreErrorClasses) return _apcoreErrorClasses;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apcore = (await import("apcore-js")) as any;
    _apcoreErrorClasses = {
      ModuleError: apcore.ModuleError,
      TaskLimitExceededError: apcore.TaskLimitExceededError,
      VersionConstraintError: apcore.VersionConstraintError,
      DependencyNotFoundError: apcore.DependencyNotFoundError,
      DependencyVersionMismatchError: apcore.DependencyVersionMismatchError,
      loaded: true,
    };
  } catch {
    _apcoreErrorClasses = { loaded: true };
  }
  return _apcoreErrorClasses;
}

// Kick off the load eagerly but don't await; toMcpError is sync and will
// observe the populated cache on subsequent invocations.
void _loadApcoreErrorClasses();

/** Internal error codes that should be sanitized to a generic message. */
const INTERNAL_ERROR_CODES: Set<string> = new Set([
  ErrorCodes.CALL_DEPTH_EXCEEDED,
  ErrorCodes.CIRCULAR_CALL,
  ErrorCodes.CALL_FREQUENCY_EXCEEDED,
]);

/**
 * AI guidance field names on the MCP wire format (camelCase).
 * Both Python and TypeScript output identical camelCase keys in MCP responses.
 * Python reads snake_case from apcore errors and maps to camelCase on output.
 */
const _AI_GUIDANCE_FIELDS = ["retryable", "aiGuidance", "userFixable", "suggestion"] as const;

export class ErrorMapper {
  /**
   * Convert an error to an MCP error response.
   *
   * Duck-types the error to check for ModuleError properties (code, message, details).
   * Applies sanitization and formatting rules based on the error code.
   */
  toMcpError(error: unknown): McpErrorResponse {
    // ExecutionCancelledError: not a ModuleError subclass, check by name or code
    if (this._isExecutionCancelled(error)) {
      return {
        isError: true,
        errorType: ErrorCodes.EXECUTION_CANCELLED,
        message: "Execution was cancelled",
        details: null,
        retryable: true,
      };
    }

    // Preferred: instanceof dispatch against apcore-js's concrete error
    // classes so cross-language contracts stay tight. Falls back to the
    // duck-typed code-based dispatch below when apcore-js was unavailable
    // at load time.
    const instanceMatch = this._matchApcoreErrorInstance(error);
    if (instanceMatch) return instanceMatch;

    // Duck-type check for ModuleError-like objects
    if (this._isModuleError(error)) {
      const code = error.code;
      const details = error.details;

      // Internal error codes -> generic message
      if (INTERNAL_ERROR_CODES.has(code)) {
        return {
          isError: true,
          errorType: code,
          message: "Internal error occurred",
          details: null,
        };
      }

      // ACL denied -> sanitized access denied
      if (code === ErrorCodes.ACL_DENIED) {
        return {
          isError: true,
          errorType: ErrorCodes.ACL_DENIED,
          message: "Access denied",
          details: null,
        };
      }

      // Schema validation error -> formatted with field-level details
      if (code === ErrorCodes.SCHEMA_VALIDATION_ERROR) {
        const message = this._formatValidationError(details);
        const result: McpErrorResponse = {
          isError: true,
          errorType: ErrorCodes.SCHEMA_VALIDATION_ERROR,
          message,
          details,
        };
        this._attachAiGuidance(error, result);
        return result;
      }

      // Approval pending -> narrow details to approvalId only.
      // [D10-003] Cross-language parity: upstream apcore SDKs emit
      // snake_case (`approval_id`) exclusively, so the previous dual-key
      // branch for camelCase `approvalId` was dormant and diverged from
      // Python/Rust contracts (which accept snake_case only). Drop the
      // camelCase source key; the output stays camelCase per MCP convention.
      if (code === ErrorCodes.APPROVAL_PENDING) {
        const narrowed =
          details && "approval_id" in details
            ? { approvalId: details["approval_id"] }
            : null;
        const result: McpErrorResponse = {
          isError: true,
          errorType: code,
          message: error.message,
          details: narrowed,
        };
        this._attachAiGuidance(error, result);
        return result;
      }

      // Approval timeout -> mark as retryable
      if (code === ErrorCodes.APPROVAL_TIMEOUT) {
        const result: McpErrorResponse = {
          isError: true,
          errorType: code,
          message: error.message,
          details,
          retryable: true,
        };
        this._attachAiGuidance(error, result);
        return result;
      }

      // Approval denied -> extract reason from details
      if (code === ErrorCodes.APPROVAL_DENIED) {
        const reason = details ? (details.reason as string | undefined) : undefined;
        const result: McpErrorResponse = {
          isError: true,
          errorType: code,
          message: error.message,
          details: reason ? { reason } : details,
        };
        this._attachAiGuidance(error, result);
        return result;
      }

      // Config env map conflict -> formatted message with env_var
      if (code === ErrorCodes.CONFIG_ENV_MAP_CONFLICT) {
        const envVar = details?.env_var ?? "unknown";
        const result: McpErrorResponse = {
          isError: true,
          errorType: code,
          message: `Config env map conflict: ${String(envVar)}`,
          details,
        };
        this._attachAiGuidance(error, result);
        return result;
      }

      // Pipeline abort -> formatted message with step
      if (code === ErrorCodes.PIPELINE_ABORT) {
        const step = details?.step ?? "unknown";
        const result: McpErrorResponse = {
          isError: true,
          errorType: code,
          message: `Pipeline aborted at step: ${String(step)}`,
          details,
        };
        this._attachAiGuidance(error, result);
        return result;
      }

      // Step not found -> formatted message
      if (code === ErrorCodes.STEP_NOT_FOUND) {
        const result: McpErrorResponse = {
          isError: true,
          errorType: code,
          message: `Pipeline step not found: ${error.message}`,
          details,
        };
        this._attachAiGuidance(error, result);
        return result;
      }

      // Version incompatible -> formatted message
      if (code === ErrorCodes.VERSION_INCOMPATIBLE) {
        const result: McpErrorResponse = {
          isError: true,
          errorType: code,
          message: `Version incompatible: ${error.message}`,
          details,
        };
        this._attachAiGuidance(error, result);
        return result;
      }

      // Task limit exceeded -> retryable
      if (code === ErrorCodes.TASK_LIMIT_EXCEEDED) {
        const result: McpErrorResponse = {
          isError: true,
          errorType: code,
          message: error.message,
          details,
          retryable: true,
        };
        this._attachAiGuidance(error, result);
        return result;
      }

      // apcore 0.20.0 sync alignment A-001: CircuitBreakerOpenError ->
      // retryable=true with the per-module recovery hint already attached
      // by apcore-js's error class (mirrored via _attachAiGuidance).
      if (code === ErrorCodes.CIRCUIT_BREAKER_OPEN) {
        const result: McpErrorResponse = {
          isError: true,
          errorType: code,
          message: error.message,
          details,
          retryable: true,
        };
        this._attachAiGuidance(error, result);
        if (!result.aiGuidance) {
          result.aiGuidance =
            "Module's circuit breaker is OPEN — repeated failures have tripped " +
            "the breaker. Wait until the recovery window elapses, then retry; " +
            "the breaker will move to HALF_OPEN and accept a trial call.";
        }
        return result;
      }

      // Other known ModuleError codes -> pass through
      const result: McpErrorResponse = {
        isError: true,
        errorType: code,
        message: error.message,
        details,
      };
      this._attachAiGuidance(error, result);
      return result;
    }

    // Unknown/unexpected exceptions -> canonical GENERAL_INTERNAL_ERROR envelope (EM-6).
    // Mirrors Python `internal_error_response()` and Rust `to_mcp_error_any()`.
    return internalErrorResponse();
  }

  /**
   * Generic-error fallback for arbitrary inputs.
   *
   * Ports Rust's `to_mcp_error_any` downcast pattern: if the input is a
   * `ModuleError` subclass, delegate to {@link toMcpError} so structured
   * fields (code, details, AI guidance) survive. Otherwise — plain `Error`,
   * unrelated subclass, or non-error object — return the canonical
   * GENERAL_INTERNAL_ERROR envelope. The original class, message, stack,
   * and details are deliberately discarded in that branch (security: avoid
   * leaking server-side state). [D9-004]
   */
  toMcpErrorAny(error: unknown): McpErrorResponse {
    const ModuleError = _apcoreErrorClasses?.ModuleError;
    // [A-D-EM-5] The duck-type check is not a nicety: `_loadApcoreErrorClasses`
    // is kicked off without being awaited, so `ModuleError` is undefined for
    // every call made before that promise settles — and permanently if apcore-js
    // cannot be resolved. Without the fallback a genuine ModuleError collapsed
    // to GENERAL_INTERNAL_ERROR, discarding errorType, details, retryable and
    // aiGuidance. toMcpError has carried the same fallback all along.
    if ((ModuleError && error instanceof ModuleError) || this._isModuleError(error)) {
      return this.toMcpError(error);
    }
    return internalErrorResponse();
  }

  /**
   * Preferred `instanceof` dispatch for concrete apcore-js error classes.
   *
   * When the cache hasn't been populated yet (first call before the lazy
   * load settles), returns null and the caller falls back to duck-typing.
   * Once the cache is warm, subsequent calls produce identical output
   * whether the error was thrown as a concrete class or a duck-typed
   * plain object — the duck-typed branch below handles the latter.
   */
  private _matchApcoreErrorInstance(error: unknown): McpErrorResponse | null {
    if (!(error instanceof Error) || !_apcoreErrorClasses?.loaded) return null;
    const classes = _apcoreErrorClasses;

    const asModErr = error as Error & { code?: string; details?: Record<string, unknown> | null };

    if (classes.TaskLimitExceededError && error instanceof classes.TaskLimitExceededError) {
      const result: McpErrorResponse = {
        isError: true,
        errorType: ErrorCodes.TASK_LIMIT_EXCEEDED,
        message: error.message,
        details: asModErr.details ?? null,
        retryable: true,
      };
      this._attachAiGuidance(error as unknown as Record<string, unknown>, result);
      return result;
    }

    if (classes.DependencyNotFoundError && error instanceof classes.DependencyNotFoundError) {
      const result: McpErrorResponse = {
        isError: true,
        errorType: ErrorCodes.DEPENDENCY_NOT_FOUND,
        message: error.message,
        details: asModErr.details ?? null,
      };
      this._attachAiGuidance(error as unknown as Record<string, unknown>, result);
      return result;
    }

    if (classes.DependencyVersionMismatchError && error instanceof classes.DependencyVersionMismatchError) {
      const result: McpErrorResponse = {
        isError: true,
        errorType: ErrorCodes.DEPENDENCY_VERSION_MISMATCH,
        message: error.message,
        details: asModErr.details ?? null,
      };
      this._attachAiGuidance(error as unknown as Record<string, unknown>, result);
      return result;
    }

    if (classes.VersionConstraintError && error instanceof classes.VersionConstraintError) {
      const result: McpErrorResponse = {
        isError: true,
        errorType: ErrorCodes.VERSION_CONSTRAINT_INVALID,
        message: error.message,
        details: asModErr.details ?? null,
      };
      this._attachAiGuidance(error as unknown as Record<string, unknown>, result);
      return result;
    }

    return null;
  }

  /**
   * Extract AI guidance fields from error and attach non-undefined values to result.
   */
  private _attachAiGuidance(
    error: Record<string, unknown>,
    result: McpErrorResponse,
  ): void {
    for (const field of _AI_GUIDANCE_FIELDS) {
      const value = (error as Record<string, unknown>)[field];
      if (value !== undefined && value !== null && result[field] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result as any)[field] = value;
      }
    }
  }

  /**
   * Check for ExecutionCancelledError by name or code property.
   */
  private _isExecutionCancelled(error: unknown): boolean {
    if (error === null || typeof error !== "object") return false;
    const obj = error as Record<string, unknown>;
    if (obj.constructor?.name === "ExecutionCancelledError") return true;
    if (obj["code"] === ErrorCodes.EXECUTION_CANCELLED) return true;
    return false;
  }

  /**
   * Duck-type check for ModuleError-like objects.
   *
   * Checks for `code` (string), `message` (string), and `details` properties.
   */
  private _isModuleError(
    error: unknown,
  ): error is { code: string; message: string; details: Record<string, unknown> | null; [key: string]: unknown } {
    if (error === null || typeof error !== "object") {
      return false;
    }

    const obj = error as Record<string, unknown>;
    return (
      typeof obj["code"] === "string" &&
      typeof obj["message"] === "string" &&
      "details" in obj
    );
  }

  /**
   * Format a schema validation error message with field-level details.
   *
   * Extracts the `errors` array from details and formats each entry
   * as "field: message" lines appended to the base message.
   */
  private _formatValidationError(
    details: Record<string, unknown> | null,
  ): string {
    const baseMessage = "Schema validation failed";

    if (details === null) {
      return baseMessage;
    }

    const errors = details["errors"];
    if (!Array.isArray(errors) || errors.length === 0) {
      return baseMessage;
    }

    const fieldErrors = errors
      .map((err) => {
        if (err !== null && typeof err === "object") {
          const entry = err as Record<string, unknown>;
          const field = entry["field"] ?? "unknown";
          const message = entry["message"] ?? "validation error";
          return `  ${String(field)}: ${String(message)}`;
        }
        return `  ${String(err)}`;
      })
      .join("\n");

    return `${baseMessage}:\n${fieldErrors}`;
  }
}
