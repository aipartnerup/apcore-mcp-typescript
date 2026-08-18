/**
 * AnnotationMapper - Maps apcore module annotations to MCP tool annotations.
 *
 * Converts between apcore's annotation format and the MCP protocol's
 * hint-based annotation system. Also provides description suffix generation
 * and approval requirement checking.
 */

import type { ModuleAnnotations, McpAnnotationsDict } from "../types.js";

/** Default annotation values matching apcore's ModuleAnnotations defaults. */
const DEFAULT_ANNOTATIONS = {
  readonly: false,
  destructive: false,
  idempotent: false,
  requiresApproval: false,
  openWorld: true,
  streaming: false,
  cacheable: false,
  paginated: false,
  // [AM-2] Numeric/string defaults for cache_ttl and pagination_style.
  // Spec: default values omitted from suffix.
  cacheTtl: 0,
  paginationStyle: "cursor",
} as const;

export class AnnotationMapper {
  /**
   * Convert apcore module annotations to MCP annotations dict.
   *
   * Returns default values when annotations are null:
   * - readOnlyHint: false
   * - destructiveHint: false
   * - idempotentHint: false
   * - openWorldHint: true
   * - title: null
   */
  toMcpAnnotations(annotations: ModuleAnnotations | null): McpAnnotationsDict {
    if (annotations === null) {
      return {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        title: null,
      };
    }

    return {
      readOnlyHint: annotations.readonly,
      destructiveHint: annotations.destructive,
      idempotentHint: annotations.idempotent,
      openWorldHint: annotations.openWorld,
      title: null,
    };
  }

  /**
   * Generate a description suffix with safety warnings and annotation metadata.
   *
   * Produces:
   * 1. Safety warnings for destructive/approval/external operations.
   * 2. Machine-readable annotation block for non-default values.
   */
  toDescriptionSuffix(annotations: ModuleAnnotations | null): string {
    if (annotations === null) {
      return "";
    }

    const warnings: string[] = [];
    if (annotations.destructive) {
      warnings.push(
        "WARNING: DESTRUCTIVE - This operation may irreversibly modify or " +
          "delete data. Confirm with user before calling.",
      );
    }
    if (annotations.requiresApproval) {
      warnings.push(
        "REQUIRES APPROVAL: Human confirmation is required before execution.",
      );
    }

    const parts: string[] = [];
    if (annotations.readonly !== DEFAULT_ANNOTATIONS.readonly)
      parts.push(`readonly=${annotations.readonly}`);
    if (annotations.destructive !== DEFAULT_ANNOTATIONS.destructive)
      parts.push(`destructive=${annotations.destructive}`);
    if (annotations.idempotent !== DEFAULT_ANNOTATIONS.idempotent)
      parts.push(`idempotent=${annotations.idempotent}`);
    if (annotations.requiresApproval !== DEFAULT_ANNOTATIONS.requiresApproval)
      parts.push(`requires_approval=${annotations.requiresApproval}`);
    if (annotations.openWorld !== DEFAULT_ANNOTATIONS.openWorld)
      parts.push(`open_world=${annotations.openWorld}`);
    if (annotations.streaming !== DEFAULT_ANNOTATIONS.streaming)
      parts.push(`streaming=${annotations.streaming}`);
    if ((annotations.cacheable ?? false) !== DEFAULT_ANNOTATIONS.cacheable)
      parts.push(`cacheable=${annotations.cacheable}`);
    // [AM-2] Skip cache_ttl when equal to default (0). Spec: "Default
    // values omitted from suffix". Pre-fix TS emitted any non-null
    // value including the default, diverging from Python+Rust.
    if (
      annotations.cacheTtl !== undefined &&
      annotations.cacheTtl !== null &&
      annotations.cacheTtl !== DEFAULT_ANNOTATIONS.cacheTtl
    )
      parts.push(`cache_ttl=${annotations.cacheTtl}`);
    if (
      annotations.cacheKeyFields !== undefined &&
      annotations.cacheKeyFields !== null &&
      annotations.cacheKeyFields.length > 0
    )
      parts.push(`cache_key_fields=[${annotations.cacheKeyFields.join(",")}]`);
    if ((annotations.paginated ?? false) !== DEFAULT_ANNOTATIONS.paginated)
      parts.push(`paginated=${annotations.paginated}`);
    // [AM-2] Skip pagination_style when equal to default ("cursor").
    if (
      annotations.paginationStyle !== undefined &&
      annotations.paginationStyle !== null &&
      annotations.paginationStyle !== DEFAULT_ANNOTATIONS.paginationStyle
    )
      parts.push(`pagination_style=${annotations.paginationStyle}`);

    // Append mcp_-prefixed extra fields, sorted by codepoint for deterministic
    // output matching Python+Rust sort behavior. [D11-022]
    //
    // [A-D-AM-3] Ordinal, not localeCompare: ICU collation ranks primary letter
    // weight above case, so localeCompare emitted "cost" before "Model" where
    // Python's sorted() (annotations.py:134) and Rust's String::cmp
    // (annotations.rs:131) emit "Model" first. It is also host-locale
    // dependent, so the output was not byte-stable across environments.
    const extraLines: string[] = [];
    if (annotations.extra && typeof annotations.extra === "object") {
      for (const [key, value] of Object.entries(annotations.extra).sort(
        ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
      )) {
        if (key.startsWith("mcp_") && typeof value === "string") {
          const strippedKey = key.slice(4); // remove "mcp_" prefix
          extraLines.push(`${strippedKey}: ${value}`);
        }
      }
    }

    if (warnings.length === 0 && parts.length === 0 && extraLines.length === 0) {
      return "";
    }

    const sections: string[] = [];
    if (warnings.length > 0) {
      sections.push(warnings.join("\n"));
    }
    if (parts.length > 0) {
      sections.push(`[Annotations: ${parts.join(", ")}]`);
    }

    let suffix = "\n\n" + sections.join("\n\n");
    if (extraLines.length > 0) {
      suffix += "\n" + extraLines.join("\n");
    }
    return suffix;
  }

  /**
   * Check whether the annotations indicate the module requires approval.
   *
   * Returns false if annotations are null.
   */
  hasRequiresApproval(annotations: ModuleAnnotations | null): boolean {
    if (annotations === null) {
      return false;
    }

    return annotations.requiresApproval;
  }
}
