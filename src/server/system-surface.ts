/**
 * Classification and URI mapping for the `system.*` management surface.
 *
 * PROTOCOL_SPEC §6.6.2 classifies `system.health.*` / `system.usage.*` /
 * `system.manifest.*` as read-only Observability/Introspection modules that
 * MUST be projected as MCP resources, not tools — they carry no side
 * effects, and a tool an agent should never invoke measurably degrades tool
 * selection quality. `system.control.*` has side effects and stays a tool
 * (gated by ACL + approval exactly like any other write module).
 *
 * Classification is by `module_id` prefix ONLY. PROTOCOL_SPEC §6.6.2 SHOULD
 * NOT: adapters must not invent their own classification mechanism (no
 * reserved tags, no environment variables, no adapter-level switches).
 *
 * See aiperceivable/apcore-mcp#15 and aiperceivable/apcore-mcp-typescript#9.
 */

/** Prefix for the read-only `system.health.*` modules. */
export const SYSTEM_HEALTH_PREFIX = "system.health.";
/** Prefix for the read-only `system.usage.*` modules. */
export const SYSTEM_USAGE_PREFIX = "system.usage.";
/** Prefix for the read-only `system.manifest.*` modules. */
export const SYSTEM_MANIFEST_PREFIX = "system.manifest.";
/** Prefix for the write `system.control.*` modules — these stay MCP tools. */
export const SYSTEM_CONTROL_PREFIX = "system.control.";
/** Any `system.*` module (read or write). */
export const SYSTEM_PREFIX = "system.";

/** URI scheme (including `:`) used for the management-resource projection. */
export const SYSTEM_RESOURCE_SCHEME = "apcore:";

/**
 * True when `moduleId` is projected as an MCP resource rather than a tool:
 * one of the six canonical read-only management modules. `system.control.*`
 * (and anything outside `system.*`) is false.
 *
 * Matches the six canonical ids exactly rather than the three prefixes. The
 * two agree for every registry `registerSysModules()` produces, and differ
 * only for a read-only `system.*` id this adapter has no resource for — a
 * seventh module added by a future apcore-js, or one a host registered
 * through `registerInternal` itself. A prefix match would drop such a module
 * from `tools/list` while {@link MCPServerFactory.registerResourceHandlers}
 * (which builds from these same canonical ids) gave it no resource either,
 * so it would vanish from both discovery surfaces at once. Keeping it a tool
 * is the safer failure: visible and callable, merely classified as a tool
 * until this adapter learns its resource shape. Discovery is all that is at
 * stake — `tools/call` dispatches by id and never consulted this list.
 */
export function isSystemReadModule(moduleId: string): boolean {
  return SYSTEM_RESOURCE_MODULE_IDS.has(moduleId);
}

/** True for a `system.control.*` write module — stays an MCP tool. */
export function isSystemControlModule(moduleId: string): boolean {
  return moduleId.startsWith(SYSTEM_CONTROL_PREFIX);
}

/**
 * The three parameterless read-only modules, projected as static resources:
 *   apcore://system.health.summary
 *   apcore://system.usage.summary{?period}
 *   apcore://system.manifest.full
 */
export const SYSTEM_STATIC_RESOURCE_MODULES = [
  "system.health.summary",
  "system.usage.summary",
  "system.manifest.full",
] as const;

/**
 * The three per-module read-only modules, projected as resource templates:
 *   apcore://system.health.module/{module_id}
 *   apcore://system.manifest.module/{module_id}
 *   apcore://system.usage.module/{module_id}{?period}
 */
export const SYSTEM_TEMPLATE_RESOURCE_MODULES = [
  "system.health.module",
  "system.manifest.module",
  "system.usage.module",
] as const;

/**
 * The read-only management modules this adapter actually projects as
 * resources. Membership here — not a bare prefix match — is what removes a
 * module from `tools/list`; see {@link isSystemReadModule}.
 */
const SYSTEM_RESOURCE_MODULE_IDS: ReadonlySet<string> = new Set<string>([
  ...SYSTEM_STATIC_RESOURCE_MODULES,
  ...SYSTEM_TEMPLATE_RESOURCE_MODULES,
]);

/** Query parameters each management module id accepts (beyond `module_id`). */
const SYSTEM_RESOURCE_QUERY_PARAMS: Record<string, readonly string[]> = {
  "system.health.summary": [],
  "system.usage.summary": ["period"],
  "system.manifest.full": [],
  "system.health.module": [],
  "system.manifest.module": [],
  "system.usage.module": ["period"],
};

/** Whether `moduleId` accepts `paramName` as a query parameter. */
export function systemResourceAcceptsQueryParam(moduleId: string, paramName: string): boolean {
  return (SYSTEM_RESOURCE_QUERY_PARAMS[moduleId] ?? []).includes(paramName);
}

/** Build the static resource URI for one of `SYSTEM_STATIC_RESOURCE_MODULES`. */
export function systemResourceUri(moduleId: string): string {
  return `${SYSTEM_RESOURCE_SCHEME}//${moduleId}`;
}

/** Build the RFC 6570 resource-template URI for one of `SYSTEM_TEMPLATE_RESOURCE_MODULES`. */
export function systemResourceUriTemplate(moduleId: string): string {
  const hasPeriod = systemResourceAcceptsQueryParam(moduleId, "period");
  return `${SYSTEM_RESOURCE_SCHEME}//${moduleId}/{module_id}${hasPeriod ? "{?period}" : ""}`;
}

/** Parsed `apcore://` management resource URI. */
export interface ParsedSystemResourceUri {
  /** Target module id — the URI host segment. */
  moduleId: string;
  /** Tool-call-style args assembled from the path segment and query string. */
  args: Record<string, unknown>;
}

/**
 * Parse an `apcore://` management resource URI into a target module id and
 * tool-call style args.
 *
 * URI shape (aiperceivable/apcore-mcp#15 "URI ↔ module input mapping"):
 *   apcore://{module_id}                       -> { }
 *   apcore://{module_id}/{path_param}          -> { module_id: path_param }
 *   apcore://{module_id}?{query}               -> named query args
 *
 * The host segment is the target module id (module ids are lowercase by
 * EBNF, so the URL parser's host lowercasing is harmless); path segments are
 * positional parameters, query parameters are named options.
 *
 * Returns `null` when `uri` is not a well-formed `apcore:` URI — callers
 * should fall through to other resource schemes (e.g. `docs://`) in that
 * case. Does NOT validate that `moduleId` is a recognised management
 * module, or that path/query parameters are the ones that module accepts —
 * that is the caller's job, so it can raise MCP-shaped errors.
 */
export function parseSystemResourceUri(uri: string): ParsedSystemResourceUri | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== SYSTEM_RESOURCE_SCHEME) return null;

  const moduleId = url.hostname;
  const args: Record<string, unknown> = {};

  const pathSegment = url.pathname.replace(/^\/+/, "");
  if (pathSegment) {
    args.module_id = decodeURIComponent(pathSegment);
  }

  for (const [key, value] of url.searchParams.entries()) {
    args[key] = value;
  }

  return { moduleId, args };
}

/** Registered-module booleans for the four management surfaces (issue #16 Phase A). */
export interface ManagementSurfaces {
  health: boolean;
  usage: boolean;
  manifest: boolean;
  control: boolean;
}

/** Minimal shape needed to scan a registry for management surface presence. */
export interface ListableRegistry {
  list(options?: { tags?: string[] | null; prefix?: string | null }): string[];
}

/**
 * Scan `registry.list()` for each management surface's prefix and report
 * which are actually reachable. Used to populate the `extensions` capability
 * (`com.aiperceivable/management`) advertised in `initialize` — a server
 * MUST NOT advertise a surface that has nothing registered under it.
 */
export function computeManagementSurfaces(registry: ListableRegistry): ManagementSurfaces {
  const ids = registry.list();
  return {
    health: ids.some((id) => id.startsWith(SYSTEM_HEALTH_PREFIX)),
    usage: ids.some((id) => id.startsWith(SYSTEM_USAGE_PREFIX)),
    manifest: ids.some((id) => id.startsWith(SYSTEM_MANIFEST_PREFIX)),
    control: ids.some((id) => id.startsWith(SYSTEM_CONTROL_PREFIX)),
  };
}
