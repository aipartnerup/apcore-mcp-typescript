/**
 * OpenAPI backend — serve an OpenAPI 3.0/3.1 document as MCP tools.
 *
 * Composes apcore-toolkit's shipped pieces into a populated `Registry`:
 *
 *   loadSpec -> OpenAPIScanner.scan -> HTTPProxyRegistryWriter.write -> Registry
 *
 * and hands it to the machinery apcore-mcp already has. No scanning logic, no
 * schema conversion and no new execution path live here.
 *
 * See `apcore-mcp/docs/features/openapi-backend.md` for the specification and
 * `conformance/fixtures/openapi_backend.json` for the shared contract.
 */

import path from "node:path";
import { Registry } from "apcore-js";
import {
  HTTPProxyRegistryWriter,
  OpenAPIScanner,
  loadSpec,
  type ScannedModule,
} from "apcore-toolkit";

/**
 * One dot-separated segment of an apcore-legal module ID. apcore's registry
 * enforces `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` at `Registry.register` and
 * again at `Executor.call`; this is that pattern, per segment.
 */
export const MODULE_ID_SEGMENT = /^[a-z][a-z0-9_]*$/;

/** Methods that write — used only by the "nothing asks for approval" warning. */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const URL_SCHEMES = ["http://", "https://"];

export interface OpenAPIBackendOptions {
  baseUrl?: string;
  prefix?: string;
  include?: string;
  exclude?: string;
  includeDeprecated?: boolean;
  headers?: Record<string, string>;
  timeout?: number;
  authHeaderFactory?: () => Record<string, string>;
  registry?: Registry;
  hasOtherBackendSource?: boolean;
  projectRoot?: string;
  acknowledgeUnapprovedWrites?: boolean;
  transformOperation?: (
    p: string,
    method: string,
    operation: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  transformModule?: (module: ScannedModule) => ScannedModule | null;
  deriveModuleId?: (
    p: string,
    method: string,
    operation: Record<string, unknown>,
  ) => string | null;
  logger?: { warn: (msg: string) => void; error: (msg: string) => void };
}

/**
 * Map a scanner-derived module ID into apcore's legal alphabet, or `null`.
 *
 * apcore-toolkit's `deriveModuleId` sanitizes to `[A-Za-z0-9_.-]`. apcore's
 * registry accepts only lowercase, digits, underscores and dots — "no hyphens"
 * — so the two alphabets differ and the scanner's output is not directly
 * registrable. Measured against apcore 0.30.0 and apcore-toolkit 0.11.1, only
 * two of nine realistic operation shapes register unrepaired, and the canonical
 * Swagger Petstore (`listPets`, `createPets`, `showPetById`) is entirely in the
 * rejected set: it scans cleanly, fails registration on every operation as a
 * per-module `WriteResult`, and yields an **empty registry**.
 *
 * The projection is lowercase, then `-` -> `_`. Both are mechanical and
 * lossless up to case. It deliberately stops there: a segment that still does
 * not begin with a lowercase letter (`/v1/2fa` -> `v1.2fa.post`) can only be
 * repaired by *inventing* a character, which is a naming decision that belongs
 * to the operator's own hook rather than to a silent default.
 */
export function projectModuleId(moduleId: string): string | null {
  const candidate = moduleId.toLowerCase().replace(/-/g, "_");
  if (!candidate) return null;
  if (!candidate.split(".").every((seg) => MODULE_ID_SEGMENT.test(seg))) return null;
  return candidate;
}

/**
 * Resolve the `mcp.openapi.spec` value.
 *
 * `spec` is the `mcp` namespace's first path-typed configuration key, and
 * apcore 0.30.0's protections for path-typed keys do **not** reach it:
 * `Config.pathTypedKeys()` returns a hardcoded set of apcore's own keys and
 * never consults a namespace registered through `Config.registerNamespace`,
 * and the PROTOCOL_SPEC §9.2.1 requirement-5 empty-value discard is gated on
 * that same set. So the three rules are the bridge's own:
 *
 * 1. an `http(s)://` value is a URL, used **verbatim**;
 * 2. a set-but-empty value is discarded (caller falls through to the next tier);
 * 3. a relative filesystem path resolves against `Config.projectRoot` — §9.2.2's
 *    *target* semantics, adopted immediately because this key has never shipped
 *    and so owes no deprecation window.
 *
 * @returns the URL unchanged, an absolute path, or `null` when the value was
 *   empty and the caller should fall through.
 */
export function resolveSpecLocation(
  spec: unknown,
  options: { projectRoot?: string; logger?: { warn: (m: string) => void } } = {},
): unknown {
  if (spec === null || spec === undefined) return null;
  if (typeof spec !== "string") return spec; // an already-parsed document

  if (spec.trim() === "") {
    options.logger?.warn(
      "mcp.openapi.spec is set but empty; it is path-typed and an empty string is not a path " +
        "(mirrors PROTOCOL_SPEC §9.2.1 requirement 5). Ignoring the value.",
    );
    return null;
  }
  if (URL_SCHEMES.some((s) => spec.startsWith(s))) return spec;
  if (path.isAbsolute(spec)) return spec;
  const base = options.projectRoot ?? process.cwd();
  return path.resolve(base, spec);
}

/** Build a `Registry` from an OpenAPI 3.0/3.1 document. */
export async function openapiBackend(
  spec: unknown,
  options: OpenAPIBackendOptions = {},
): Promise<Registry> {
  const log = options.logger ?? {
    // eslint-disable-next-line no-console
    warn: (m: string) => console.warn(m),
    // eslint-disable-next-line no-console
    error: (m: string) => console.error(m),
  };

  if (options.hasOtherBackendSource && !options.prefix) {
    throw new Error(
      "mcp.openapi.prefix is required when an OpenAPI backend is combined with another backend " +
        "source: the scanner deduplicates IDs within one scan only and knows nothing about modules " +
        "already in the registry. Set --openapi-prefix / mcp.openapi.prefix.",
    );
  }

  // --- 1. Locate and load ---------------------------------------------------
  const resolved = resolveSpecLocation(spec, {
    projectRoot: options.projectRoot,
    logger: log,
  });
  if (resolved === null) {
    throw new Error("mcp.openapi.spec is required and resolved to nothing.");
  }
  const document =
    typeof resolved === "string"
      ? await loadSpec(resolved, { headers: options.headers, timeout: options.timeout })
      : (resolved as Record<string, unknown>);

  // --- 2. Scan --------------------------------------------------------------
  const skipped: Array<{ derived: string; segment: string }> = [];

  /**
   * Caller hook first, projection last.
   *
   * The order is normative: running the projection last makes the invariant
   * *every registered module ID is apcore-legal* hold unconditionally, whatever
   * a caller's own hook returns. It also runs BEFORE the scanner's
   * `deduplicateIds` — which happens after this callback — because lowercasing
   * can CREATE a collision the document did not have (`listPets`/`listpets`).
   */
  const project = (mod: ScannedModule): ScannedModule | null => {
    let module: ScannedModule | null = mod;
    if (options.transformModule) {
      module = options.transformModule(module);
      if (module === null) return null;
    }
    const projected = projectModuleId(module.moduleId);
    if (projected === null) {
      const lowered = module.moduleId.toLowerCase().replace(/-/g, "_");
      const bad = lowered.split(".").find((s) => !MODULE_ID_SEGMENT.test(s)) ?? module.moduleId;
      skipped.push({ derived: module.moduleId, segment: bad });
      return null;
    }
    return projected === module.moduleId ? module : { ...module, moduleId: projected };
  };

  const modules = await new OpenAPIScanner().scan(document, {
    include: options.include,
    exclude: options.exclude,
    basePathPrefix: options.prefix,
    includeDeprecated: options.includeDeprecated ?? true,
    transformOperation: options.transformOperation,
    transformModule: project,
    deriveModuleId: options.deriveModuleId,
  });

  for (const s of skipped) {
    log.warn(
      `OpenAPI operation skipped: derived module ID '${s.derived}' is not a legal apcore module ` +
        `ID — the segment '${s.segment}' does not match ${MODULE_ID_SEGMENT.source}. apcore's ` +
        `registry would refuse it. Supply a deriveModuleId or transformModule hook to name this ` +
        `operation yourself.`,
    );
  }
  for (const m of modules) {
    for (const w of m.warnings ?? []) log.warn(`OpenAPI scan warning for ${m.moduleId}: ${w}`);
  }
  if (modules.length === 0) {
    log.warn("OpenAPI document yielded zero modules; the server will start with no tools from it.");
  }

  // --- 3. Collision preflight -----------------------------------------------
  const target = options.registry ?? new Registry();
  const existing = new Set(registryIds(target));
  const collisions = modules
    .map((m) => m.moduleId)
    .filter((id) => existing.has(id))
    .sort();
  if (collisions.length) {
    throw new Error(
      "OpenAPI module IDs collide with modules already in the registry: " +
        `${[...new Set(collisions)].join(", ")}. Nothing was registered. Set or change ` +
        "mcp.openapi.prefix so the two ID spaces cannot overlap.",
    );
  }

  // --- 4. Base URL ----------------------------------------------------------
  const baseUrl = options.baseUrl ?? documentServerUrl(document);
  if (!baseUrl) {
    throw new Error(
      "mcp.openapi.base_url is required: the document declares no usable absolute " +
        "servers[0].url, so every proxied call would resolve against an unknown host.",
    );
  }

  // --- 5. Write -------------------------------------------------------------
  const writer = new HTTPProxyRegistryWriter({
    baseUrl,
    authHeaderFactory: options.authHeaderFactory,
  });
  for (const result of await writer.write(modules, target)) {
    const err = (result as { verificationError?: string }).verificationError;
    if (err) log.error(`OpenAPI module ${result.moduleId} failed to register: ${err}`);
  }

  if (!options.acknowledgeUnapprovedWrites) {
    warnIfWritesHaveNoApprovalPath(modules, log);
  }
  return target;
}

function registryIds(registry: Registry): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((registry as any).list({ visibility: ["public", "hidden"] }) as string[]) ?? [];
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((registry as any).list() as string[]) ?? [];
    } catch {
      return [];
    }
  }
}

function documentServerUrl(document: Record<string, unknown>): string | undefined {
  const servers = document.servers;
  if (!Array.isArray(servers) || servers.length === 0) return undefined;
  const first = servers[0] as { url?: unknown } | undefined;
  const url = first?.url;
  return typeof url === "string" && URL_SCHEMES.some((s) => url.startsWith(s)) ? url : undefined;
}

/**
 * Warn that nothing will ask for approval before a write.
 *
 * The toolkit infers annotations from the HTTP method alone and never infers
 * `requiresApproval`, so every scanned module arrives with it false: a
 * `POST /charges` that moves money is annotated exactly like a `POST /echo`.
 *
 * This reports the **absence of an approval path, never the presence of
 * protection** — the rule apcore states on
 * `GovernanceState.unprotectedControlSurface`: *"a wired ACL that permits every
 * call still yields false."* An attached ACL therefore does not suppress it.
 */
function warnIfWritesHaveNoApprovalPath(
  modules: ScannedModule[],
  log: { warn: (m: string) => void },
): void {
  const writes = modules.filter((m) => {
    const method = String((m.metadata as Record<string, unknown> | undefined)?.http_method ?? "");
    const ann = m.annotations as { requiresApproval?: boolean } | undefined;
    return WRITE_METHODS.has(method.toUpperCase()) && !ann?.requiresApproval;
  });
  if (writes.length === 0) return;
  log.warn(
    `${writes.length} OpenAPI operation(s) use a write method (POST/PUT/PATCH/DELETE) and declare ` +
      "requiresApproval=false — the approval gate will not fire for any of them. The scanner cannot " +
      "know which operations are consequential and does not guess. Close it with an ACL rule " +
      "carrying `approval: required`, `gate_destructive` on the ExecutionPolicy, or a " +
      "transformModule hook that sets the annotation. Set " +
      "mcp.openapi.acknowledge_unapproved_writes: true to record this as a deliberate decision.",
  );
}

/**
 * Build a `Registry` from a Config Bus `mcp.openapi` mapping, or `null`.
 *
 * Mirrors `acl-builder.ts`'s `buildAclFromConfig`: the raw `mcp.openapi`
 * Config Bus value is a plain object (from `apcore.yaml` or
 * `APCORE_MCP_OPENAPI_*` env vars), not the options `openapiBackend` takes
 * directly, so this is the one place that translates between them.
 *
 * PRD F-054 documents `mcp.openapi` as reached from three routes — the
 * Config Bus, the CLI flags, and `APCoreMCP.fromOpenapi` — and Acceptance
 * Criterion 1 states plainly that `mcp.openapi.spec` alone, with no CLI flag
 * and no explicit code, "starts a server". Before this function existed,
 * `mcp.openapi` was registered as a Config Bus namespace default (so the key
 * round-tripped) but nothing ever read it back — the Config Bus route was
 * documented and silently absent.
 *
 * `authHeaderFactory` is deliberately not read from `openapiConfig`: it is a
 * function, and a Config Bus value sourced from YAML/JSON/env can never
 * carry one.
 */
export async function buildOpenapiBackendFromConfig(
  openapiConfig: unknown,
  options: { registry?: Registry; hasOtherBackendSource?: boolean } = {},
): Promise<Registry | null> {
  if (!openapiConfig || typeof openapiConfig !== "object") return null;
  const cfg = openapiConfig as Record<string, unknown>;
  const spec = cfg.spec;
  if (!spec) {
    throw new Error("mcp.openapi.spec is required when mcp.openapi is configured");
  }

  return openapiBackend(spec, {
    baseUrl: typeof cfg.base_url === "string" ? cfg.base_url : undefined,
    prefix: typeof cfg.prefix === "string" ? cfg.prefix : undefined,
    include: typeof cfg.include === "string" ? cfg.include : undefined,
    exclude: typeof cfg.exclude === "string" ? cfg.exclude : undefined,
    includeDeprecated:
      typeof cfg.include_deprecated === "boolean" ? cfg.include_deprecated : true,
    headers: cfg.headers as Record<string, string> | undefined,
    timeout: typeof cfg.timeout === "number" ? cfg.timeout : 30,
    registry: options.registry,
    hasOtherBackendSource: options.hasOtherBackendSource ?? false,
    acknowledgeUnapprovedWrites:
      typeof cfg.acknowledge_unapproved_writes === "boolean"
        ? cfg.acknowledge_unapproved_writes
        : false,
  });
}
