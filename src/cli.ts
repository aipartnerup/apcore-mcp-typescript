#!/usr/bin/env node

/**
 * CLI entry point: npx apcore-mcp
 *
 * Usage:
 *   apcore-mcp --extensions-dir ./extensions
 *   apcore-mcp --extensions-dir ./extensions --transport streamable-http --port 8000
 *   apcore-mcp --extensions-dir ./extensions --transport sse --port 8000
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { serve, VERSION, JWTAuthenticator, ElicitationApprovalHandler } from "./index.js";
import type { Algorithm } from "jsonwebtoken";

function printUsage(): void {
  console.log(`
apcore-mcp v${VERSION} - Automatic MCP Server for apcore modules

Usage:
  apcore-mcp --extensions-dir <path> [options]

Backend source (at least one; both allowed; combining requires --openapi-prefix):
  --extensions-dir <path>    Path to apcore extensions directory
  --from-openapi <url|path> OpenAPI 3.0/3.1 spec URL or path — serve a remote API as MCP tools
                             (mcp.openapi.spec on the Config Bus also works with neither flag)

Options:
  --openapi-base-url <url>   Base URL for proxied requests (default: the document's servers[0].url)
  --openapi-prefix <prefix>  Prepended to every derived module ID
  --openapi-include <glob>   Scanner include filter
  --openapi-exclude <glob>   Scanner exclude filter
  --openapi-header <k:v>     Header for the spec fetch only, repeatable. Never sent with proxied calls
  --openapi-no-deprecated    Skip operations marked deprecated: true
  --transport <type>         Transport type: stdio, streamable-http, sse (default: stdio)
  --host <address>           Host for HTTP transports (default: 127.0.0.1)
  --port <number>            Port for HTTP transports (default: 8000, range: 1-65535)
  --name <string>            MCP server name (default: apcore-mcp, max 255 chars)
  --version <string>         MCP server version (default: package version)
  --log-level <level>        Logging level: DEBUG, INFO, WARNING, ERROR (default: INFO)
  --explorer                 Enable the browser-based Tool Explorer UI (HTTP only)
  --explorer-prefix <path>   URL prefix for the explorer UI (default: /explorer)
  --allow-execute            Allow tool execution from the explorer UI
  --jwt-key-file <path>      File holding the JWT key (PEM or secret); highest-priority
                             key source: --jwt-key-file > --jwt-secret > APCORE_JWT_SECRET
  --jwt-secret <string>      JWT secret key for Bearer token authentication
  --jwt-algorithm <alg>      JWT algorithm (default: HS256)
  --jwt-audience <string>    Expected JWT audience claim
  --jwt-issuer <string>      Expected JWT issuer claim
  --jwt-require-auth         Require auth (default: true)
  --jwt-permissive           Permissive mode: allow unauthenticated requests (overrides --jwt-require-auth)
  --strategy <name>          Execution strategy: standard, internal, testing, performance, minimal
  --approval <mode>          Approval mode: elicit, auto-approve, always-deny, off (default: off)
  --output-format <type>     Built-in output format: json, csv, jsonl (default: json)
  --exempt-paths <paths>     Comma-separated paths exempt from auth (default: /health,/metrics; /usage requires auth per D11-2 contract)
  --observability            Enable metrics + usage middleware and expose /metrics and /usage endpoints
  --async                    Enable the Async Task Bridge (default: on; use --no-async to disable)
  --no-async                 Disable the Async Task Bridge
  --help                     Show this help message
`);
}

function fail(message: string, exitCode: number = 1): never {
  console.error(`Error: ${message}`);
  process.exit(exitCode);
}

export async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        "extensions-dir": { type: "string" },
        "from-openapi": { type: "string" },
        "openapi-base-url": { type: "string" },
        "openapi-prefix": { type: "string" },
        "openapi-include": { type: "string" },
        "openapi-exclude": { type: "string" },
        "openapi-header": { type: "string", multiple: true },
        "openapi-no-deprecated": { type: "boolean", default: false },
        transport: { type: "string", default: "stdio" },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "string", default: "8000" },
        name: { type: "string", default: "apcore-mcp" },
        version: { type: "string" },
        "log-level": { type: "string", default: "INFO" },
        explorer: { type: "boolean", default: false },
        "explorer-prefix": { type: "string", default: "/explorer" },
        "allow-execute": { type: "boolean", default: false },
        "jwt-secret": { type: "string" },
        "jwt-key-file": { type: "string" },
        "jwt-algorithm": { type: "string" },
        "jwt-audience": { type: "string" },
        "jwt-issuer": { type: "string" },
        "jwt-require-auth": { type: "boolean", default: true },
        "jwt-permissive": { type: "boolean", default: false },
        approval: { type: "string", default: "off" },
        strategy: { type: "string" },
        "output-format": { type: "string", default: "json" },
        "exempt-paths": { type: "string" },
        observability: { type: "boolean", default: false },
        async: { type: "boolean", default: true },
        "no-async": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
    });
  } catch {
    printUsage();
    process.exit(2);
  }

  const { values } = parsed;

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  // Backend-source rule: at least one, both allowed, both requires a prefix.
  // A third route — mcp.openapi.spec configured on the Config Bus alone,
  // with neither CLI flag — also counts (PRD F-054 Acceptance Criterion 1).
  // serve() -> its Config-Bus fallback picks it up automatically once a
  // (possibly undefined) registry reaches it, so this CLI's own job is only
  // to not reject that case before it gets there.
  const extensionsDir = values["extensions-dir"];
  const fromOpenapi = values["from-openapi"];
  const openapiPrefix = values["openapi-prefix"];
  if (!extensionsDir && !fromOpenapi) {
    let hasConfigBusOpenapi = false;
    try {
      const apcore = await import("apcore-js");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Config = (apcore as any).Config;
      const config = typeof Config?.getInstance === "function" ? Config.getInstance() : undefined;
      hasConfigBusOpenapi = Boolean(config?.get?.("mcp.openapi"));
    } catch {
      // apcore-js not installed — treated the same as "no Config Bus value".
    }
    if (!hasConfigBusOpenapi) {
      fail(
        "a backend source is required — pass --extensions-dir, --from-openapi, set " +
          "mcp.openapi.spec on the Config Bus, or combine them.",
        2,
      );
    }
  }
  if (extensionsDir && fromOpenapi && !openapiPrefix) {
    fail(
      "--openapi-prefix is required when --extensions-dir and --from-openapi are combined, " +
        "so the two module-ID spaces cannot collide.",
      2,
    );
  }

  let resolvedDir: string | undefined;
  if (extensionsDir) {
    resolvedDir = resolve(extensionsDir);
    if (!existsSync(resolvedDir)) {
      fail(`--extensions-dir '${extensionsDir}' does not exist.`);
    }
    if (!statSync(resolvedDir).isDirectory()) {
      fail(`--extensions-dir '${extensionsDir}' is not a directory.`);
    }
  }

  // Validate transport
  const transport = values.transport as string;
  const validTransports = ["stdio", "streamable-http", "sse"];
  if (!validTransports.includes(transport)) {
    fail(
      `--transport must be one of: ${validTransports.join(", ")}. Got '${transport}'.`,
    );
  }

  // Validate port
  const port = parseInt(values.port as string, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    fail(`--port must be in range 1-65535, got '${values.port}'.`);
  }

  // Validate name length
  const name = values.name as string;
  if (name.length > 255) {
    fail(`--name must be at most 255 characters, got ${name.length}.`);
  }

  // Dynamic import of apcore Registry (peer dependency)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Registry: new (options?: { extensionsDir?: string }) => {
    discover(): Promise<number>;
  };
  try {
    const apcore = await import("apcore-js");
    Registry = apcore.Registry;
  } catch {
    fail(
      "Failed to import 'apcore-js' package. Install it with: npm install apcore-js",
    );
  }

  // Create the Registry. The union is assembled in a fixed order —
  // extensions directory first, then OpenAPI operations — so a collision
  // report names the OpenAPI side, which is the one the operator can
  // rename with a prefix. Neither flag given: pass `undefined` through to
  // serve() -> its Config-Bus fallback, rather than handing it an empty
  // stand-in Registry() that would be mistaken for a second, explicit
  // backend source and wrongly require mcp.openapi.prefix.
  let registry: { discover(): Promise<number> } | undefined;
  if (resolvedDir) {
    registry = new Registry({ extensionsDir: resolvedDir });
    const numModules = await registry.discover();
    if (numModules === 0) {
      console.warn(`Warning: No modules discovered in '${extensionsDir}'.`);
    } else {
      console.info(`Discovered ${numModules} module(s) in '${extensionsDir}'.`);
    }
  } else if (fromOpenapi) {
    registry = new Registry();
  }

  if (fromOpenapi) {
    const { openapiBackend } = await import("./openapi-backend.js");
    const headers: Record<string, string> = {};
    for (const raw of values["openapi-header"] ?? []) {
      const idx = raw.indexOf(":");
      if (idx === -1) {
        fail(`--openapi-header must be KEY:VALUE, got '${raw}'.`, 2);
      }
      headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
    }
    try {
      await openapiBackend(fromOpenapi, {
        baseUrl: values["openapi-base-url"],
        prefix: openapiPrefix,
        include: values["openapi-include"],
        exclude: values["openapi-exclude"],
        includeDeprecated: !values["openapi-no-deprecated"],
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        registry: registry as never,
        hasOtherBackendSource: Boolean(extensionsDir),
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  // Validate log-level
  const logLevel = values["log-level"] as string | undefined;
  const validLogLevels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
  if (logLevel && !validLogLevels.includes(logLevel)) {
    fail(
      `--log-level must be one of: ${validLogLevels.join(", ")}. Got '${logLevel}'.`,
    );
  }

  // Validate and build approval handler
  const approvalMode = values.approval as string;
  const validApprovalModes = ["elicit", "auto-approve", "always-deny", "off"];
  if (!validApprovalModes.includes(approvalMode)) {
    fail(
      `--approval must be one of: ${validApprovalModes.join(", ")}. Got '${approvalMode}'.`,
    );
  }

  // Validate strategy
  const strategy = values.strategy as string | undefined;
  if (strategy) {
    const validStrategies = ["standard", "internal", "testing", "performance", "minimal"];
    if (!validStrategies.includes(strategy)) {
      fail(
        `--strategy must be one of: ${validStrategies.join(", ")}. Got '${strategy}'.`,
      );
    }
  }

  // Validate output-format
  const outputFormat = values["output-format"] as string | undefined;
  const validOutputFormats = ["json", "csv", "jsonl"];
  if (outputFormat && !validOutputFormats.includes(outputFormat)) {
    fail(
      `--output-format must be one of: ${validOutputFormats.join(", ")}. Got '${outputFormat}'.`,
    );
  }

  let approvalHandler: unknown;
  if (approvalMode === "elicit") {
    approvalHandler = new ElicitationApprovalHandler();
  } else if (approvalMode === "auto-approve" || approvalMode === "always-deny") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const apcore = await import("apcore-js") as any;
      if (approvalMode === "auto-approve") {
        const AutoApprove = apcore.AutoApproveHandler ?? apcore.default?.AutoApproveHandler;
        if (AutoApprove) {
          approvalHandler = new AutoApprove();
        } else {
          fail("apcore-js does not export AutoApproveHandler.");
        }
      } else {
        const AlwaysDeny = apcore.AlwaysDenyHandler ?? apcore.default?.AlwaysDenyHandler;
        if (AlwaysDeny) {
          approvalHandler = new AlwaysDeny();
        } else {
          fail("apcore-js does not export AlwaysDenyHandler.");
        }
      }
    } catch {
      fail(`Failed to import approval handler from apcore-js for mode '${approvalMode}'.`);
    }
  }

  // Build JWT authenticator.
  // Resolution: --jwt-key-file > --jwt-secret > APCORE_JWT_SECRET env var
  let jwtKey: string | undefined;
  const keyFile = values["jwt-key-file"] as string | undefined;
  if (keyFile) {
    const { readFileSync } = await import("fs");
    try {
      jwtKey = readFileSync(keyFile, "utf-8").trim();
    } catch (err) {
      fail(`Cannot read JWT key file: ${keyFile} (${err})`);
    }
  } else {
    jwtKey = (values["jwt-secret"] as string) || process.env.APCORE_JWT_SECRET;
  }
  const jwtRequireAuth = values["jwt-permissive"] ? false : (values["jwt-require-auth"] as boolean);
  const authenticator = jwtKey
    ? new JWTAuthenticator({
        secret: jwtKey,
        algorithms: values["jwt-algorithm"]
          ? [values["jwt-algorithm"] as Algorithm]
          : undefined,
        audience: values["jwt-audience"],
        issuer: values["jwt-issuer"],
        requireAuth: jwtRequireAuth,
      })
    : undefined;

  // Parse exempt paths
  const exemptPathsRaw = values["exempt-paths"] as string | undefined;
  const exemptPaths = exemptPathsRaw
    ? exemptPathsRaw.split(",").map((p) => p.trim())
    : undefined;

  const observabilityEnabled = values.observability as boolean;
  const asyncDisabled = values["no-async"] as boolean;
  const asyncEnabled = asyncDisabled ? false : (values.async as boolean);

  // Launch the MCP server
  try {
    await serve(registry as never, {
      transport: transport as "stdio" | "streamable-http" | "sse",
      host: values.host as string,
      port,
      name,
      version: values.version ?? undefined,
      logLevel: logLevel as "DEBUG" | "INFO" | "WARNING" | "ERROR" | undefined,
      explorer: values.explorer as boolean,
      explorerPrefix: values["explorer-prefix"] as string,
      allowExecute: values["allow-execute"] as boolean,
      authenticator,
      exemptPaths,
      approvalHandler,
      strategy,
      outputFormat: outputFormat as "json" | "csv" | "jsonl",
      observability: observabilityEnabled,
      async: asyncEnabled,
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(2);
  }
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(2);
});
