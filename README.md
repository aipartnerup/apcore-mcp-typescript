<div align="center">
  <img src="https://raw.githubusercontent.com/aiperceivable/apcore-mcp/main/apcore-mcp-logo.svg" alt="apcore-mcp logo" width="200"/>
</div>

# apcore-mcp

Automatic MCP Server & OpenAI Tools Bridge for [apcore](https://github.com/aiperceivable/apcore).

Converts apcore module registries into [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) tool definitions and [OpenAI-compatible function calling](https://platform.openai.com/docs/guides/function-calling) formats — zero boilerplate required.

## Features

- **MCP Server** — Expose apcore modules as MCP tools over stdio, Streamable HTTP, or SSE
- **OpenAI Tools** — Convert modules to OpenAI function calling format with strict mode support
- **Markdown tool descriptions** (`richDescription: true`, v0.15+) — render `Tool.description` and OpenAI `function.description` as canonical apcore-toolkit Markdown so LLMs get more decision-relevant signal per token. Requires `apcore-toolkit` (declared as `optionalDependencies`) and `await MCPServerFactory.prepare()` at startup.
- **Module preview meta-tool** (`__apcore_module_preview`, v0.15+) — drives `executor.validate()` to predict state changes WITHOUT executing the module (apcore PROTOCOL_SPEC §5.6). Returns `{valid, requires_approval, predicted_changes, checks}` so AI orchestrators can ask "what would change?" before invoking.
- **Schema Conversion** — Inline `$defs`/`$ref` from Pydantic-generated JSON Schema
- **Annotation Mapping** — Map module annotations to MCP hints and OpenAI description suffixes
- **Approval Mechanism** — Built-in elicitation-based approval flow for sensitive tool executions
- **Error Mapping** — Sanitize internal errors for safe client-facing responses
- **Dynamic Registration** — Listen for registry changes and update tools at runtime
- **Tool Explorer** — Browser-based UI for browsing schemas and testing tools interactively
- **CLI** — Launch an MCP server from the command line
- **Config Bus integration** — Registers an `mcp` namespace with the apcore Config Bus; configure via unified `apcore.yaml` or `APCORE_MCP_*` env vars
- **Error Formatter Registry** — Registers an MCP-specific error formatter for ecosystem-wide consistent error handling

## Documentation

For full documentation, including Quick Start guides for both Python and TypeScript, visit:
**[https://aiperceivable.github.io/apcore-mcp/](https://aiperceivable.github.io/apcore-mcp/)**

## Requirements

- Node.js >= 18.0.0
- `apcore-js >= 0.21.1`
- Optional: `apcore-toolkit >= 0.6.1` for Markdown-rendered tool descriptions (declared under `optionalDependencies`).

## Installation

```bash
npm install apcore-mcp
```

`apcore-js` is included as a direct dependency — no separate install needed.

## Quick Start

### Programmatic API

```typescript
import { serve, toOpenaiTools } from "apcore-mcp";

// Launch MCP server over stdio
await serve(executor);

// Launch over Streamable HTTP
await serve(executor, {
  transport: "streamable-http",
  host: "127.0.0.1",
  port: 8000,
});

// Export OpenAI tool definitions
const tools = toOpenaiTools(registry, {
  embedAnnotations: true,
  strict: true,
});
```

### CLI

```bash
# stdio (default)
npx apcore-mcp --extensions-dir ./extensions

# Streamable HTTP
npx apcore-mcp --extensions-dir ./extensions --transport streamable-http --port 8000

# SSE
npx apcore-mcp --extensions-dir ./extensions --transport sse --port 8000
```

#### CLI Arguments

| Argument | Default | Description |
|---|---|---|
| `--extensions-dir` | *(required)* | Path to apcore extensions directory |
| `--transport` | `stdio` | `stdio`, `streamable-http`, or `sse` |
| `--host` | `127.0.0.1` | Host for HTTP transports |
| `--port` | `8000` | Port for HTTP transports (1-65535) |
| `--name` | `apcore-mcp` | MCP server name |
| `--version` | package version | MCP server version |
| `--log-level` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| `--explorer` | off | Enable the browser-based Tool Explorer UI (HTTP only) |
| `--explorer-prefix` | `/explorer` | URL prefix for the explorer UI |
| `--allow-execute` | off | Allow tool execution from the explorer UI |
| `--jwt-secret` | — | JWT secret key for Bearer token authentication |
| `--jwt-key-file` | — | Path to PEM key file for JWT verification (RS256/ES256) |
| `--jwt-algorithm` | `HS256` | JWT algorithm |
| `--jwt-audience` | — | Expected JWT audience claim |
| `--jwt-issuer` | — | Expected JWT issuer claim |
| `--jwt-require-auth` | `true` | Require auth (use `--jwt-permissive` to override and allow unauthenticated requests) |
| `--jwt-permissive` | `false` | Permissive mode: allow unauthenticated requests (overrides `--jwt-require-auth`) |
| `--exempt-paths` | `/health,/metrics,/usage` | Comma-separated paths exempt from auth |
| `--output-format` | `json` | Built-in output format: `json`, `csv`, or `jsonl` |

JWT key resolution priority: `--jwt-key-file` > `--jwt-secret` > `APCORE_JWT_SECRET` environment variable.

## MCP Client Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "apcore": {
      "command": "npx",
      "args": ["apcore-mcp", "--extensions-dir", "/path/to/your/extensions"]
    }
  }
}
```

### Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "apcore": {
      "command": "npx",
      "args": ["apcore-mcp", "--extensions-dir", "./extensions"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "apcore": {
      "command": "npx",
      "args": ["apcore-mcp", "--extensions-dir", "./extensions"]
    }
  }
}
```

### Remote HTTP access

```bash
npx apcore-mcp --extensions-dir ./extensions \
    --transport streamable-http \
    --host 0.0.0.0 \
    --port 9000
```

Connect any MCP client to `http://your-host:9000/mcp`.

## API Reference

### Programmatic API – `APCoreMCP` class

The `APCoreMCP` class is the recommended OOP entry point. It bundles a unified configuration object, lazy backend resolution (path / `Registry` / `Executor`), and exposes `serve` / `asyncServe` / `toOpenaiTools` as instance methods so you configure once and use everywhere.

```typescript
import { APCoreMCP } from "apcore-mcp";

// 1. Point at an extensions directory (lazy discovery on first use)
const mcp = new APCoreMCP("./extensions", {
  name: "my-server",
  tags: ["public"],
  observability: true,
});

// 2. Launch as MCP server (blocks until shutdown)
await mcp.serve({ transport: "streamable-http", port: 8000, explorer: true });

// 3. Or export OpenAI tool definitions
const tools = mcp.toOpenaiTools({ strict: true });

// 4. Or embed into an existing HTTP server
const app = await mcp.asyncServe({ explorer: true });
// app.handler is a Node.js request handler; call app.close() on shutdown

// 5. Or pass an existing Registry / Executor
import { Registry } from "apcore-js";
const registry = new Registry({ extensionsDir: "./extensions" });
await registry.discover();
const mcp2 = new APCoreMCP(registry, { name: "my-server", tags: ["public"] });
```

**Constructor**

```typescript
new APCoreMCP(
  extensionsDirOrBackend: string | Registry | Executor,
  options?: APCoreMCPOptions,
);
```

The first argument is either a path to an apcore extensions directory (discovery is deferred to first use) or an existing `Registry` / `Executor` instance.

**`APCoreMCPOptions` fields**

- `name` — MCP server name. Default: `"apcore-mcp"`
- `version` — MCP server version. Default: package version
- `tags` — Filter modules by tag list
- `prefix` — Filter modules by ID prefix
- `logLevel` — Minimum log level (`DEBUG` | `INFO` | `WARNING` | `ERROR` | `CRITICAL`)
- `validateInputs` — Validate inputs against schemas. Default: `false`
- `metricsCollector` — `MetricsExporter` or `true` to auto-instantiate
- `observability` — Enable the full metrics + usage observability stack
- `async` — `boolean | { enabled?, maxConcurrent?, maxTasks? }` for the Async Task Bridge (F-043)
- `authenticator` — Optional `Authenticator` (HTTP transports only)
- `requireAuth` — If `true` (default), reject unauthenticated requests with 401
- `exemptPaths` — Paths exempt from authentication
- `approvalHandler` — Optional approval handler passed to the Executor
- `outputFormatter` — Custom function to format tool execution results
- `middleware` — Array of apcore `Middleware` installed via `executor.use()`
- `acl` — Optional apcore `ACL` instance installed via `executor.setAcl()`

**Properties**

- `.registry` — The underlying apcore `Registry` (resolved on first access)
- `.executor` — The underlying apcore `Executor` (populated after `serve()` / `asyncServe()`)
- `.tools` — List of discovered module IDs that will be exposed as tools (honours `tags` / `prefix`)

**Methods**

- `.serve(options?)` — Launch an MCP server. Accepts `APCoreMCPServeOptions`: `transport`, `host`, `port`, `onStartup`, `onShutdown`, `explorer`, `explorerPrefix`, `allowExecute`, `explorerTitle`, `explorerProjectName`, `explorerProjectUrl`. Constructor-level options (auth, observability, middleware, acl, async, etc.) are applied automatically.
- `.asyncServe(options?)` — Build an embeddable Node.js HTTP request handler. Accepts `APCoreMCPAsyncServeOptions`: `explorer`, `explorerPrefix`, `allowExecute`, `explorerTitle`, `explorerProjectName`, `explorerProjectUrl`, `endpoint`. Returns `{ handler, close }`.
- `.toOpenaiTools(options?)` — Export modules as OpenAI-compatible tool definitions. Accepts `ToOpenaiToolsOptions`: `embedAnnotations`, `strict`. `tags` / `prefix` are inherited from the constructor.

### `serve(registryOrExecutor, options?)`

Launch an MCP Server that exposes all apcore modules as tools.

```typescript
function serve(
  registryOrExecutor: Registry | Executor,
  options?: {
    // Transport
    transport?: "stdio" | "streamable-http" | "sse";
    host?: string;
    port?: number;
    // Identity
    name?: string;
    version?: string;
    // Lifecycle
    onStartup?: () => void | Promise<void>;
    onShutdown?: () => void | Promise<void>;
    // Module filtering / discovery
    tags?: string[] | null;
    prefix?: string | null;
    dynamic?: boolean;
    validateInputs?: boolean;
    logLevel?: "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
    // Async Task Bridge (F-043)
    async?: boolean | { enabled?: boolean; maxConcurrent?: number; maxTasks?: number };
    // Executor wiring
    middleware?: unknown[];
    acl?: unknown;
    approvalHandler?: unknown;
    strategy?: string;
    // Observability (F-044)
    metricsCollector?: MetricsExporter | boolean;
    observability?: ObservabilityFlag;
    trace?: boolean;
    // Output handling
    outputFormatter?: (result: Record<string, unknown>) => string;
    redactOutput?: boolean;
    // Auth (HTTP transports only)
    authenticator?: Authenticator;
    requireAuth?: boolean;
    exemptPaths?: string[];
    // Tool Explorer UI
    explorer?: boolean;
    explorerPrefix?: string;
    allowExecute?: boolean;
    explorerTitle?: string;
    explorerProjectName?: string;
    explorerProjectUrl?: string;
    // Adapter overrides (advanced — Extension Bridge)
    schemaConverter?: SchemaConverter;
    annotationMapper?: AnnotationMapper;
    errorMapper?: ErrorMapper;
  }
): Promise<void>;
```

**Options reference:**

*Transport*
- `transport` — `"stdio"` (default), `"streamable-http"`, or `"sse"`
- `host` — Host address for HTTP-based transports. Default: `"127.0.0.1"`
- `port` — Port for HTTP-based transports. Default: `8000`

*Identity*
- `name` — MCP server name. Default: `"apcore-mcp"`
- `version` — MCP server version. Default: package version

*Lifecycle*
- `onStartup` — Async callback invoked before the server starts
- `onShutdown` — Async callback invoked after the server stops (or on error)

*Module filtering / discovery*
- `tags` — Filter modules by tag list. Default: `null` (no filtering)
- `prefix` — Filter modules by ID prefix. Default: `null` (no filtering)
- `dynamic` — Enable dynamic tool registration via `RegistryListener`. Default: `false`
- `validateInputs` — Validate inputs against schemas before dispatch. Default: `false`
- `logLevel` — Minimum log level. Suppresses console methods below this level

*Async Task Bridge (F-043)*
- `async` — Enable the AsyncTaskBridge and `__apcore_task_*` meta-tools. Pass `false` to disable, or `{ maxConcurrent, maxTasks }` for fine-grained tuning. Default: `true`

*Executor wiring*
- `middleware` — Array of apcore `Middleware` instances installed via `executor.use()`. Appended to any middleware declared under Config Bus key `mcp.middleware`
- `acl` — Optional apcore `ACL` instance installed via `executor.setAcl()`. Caller-supplied ACL takes precedence over `mcp.acl` Config Bus entry. **If `sys_modules.enabled` is turned on with no `acl/` directory configured, `ACL.discover()` returns `null` — identical to a project that never configured an ACL — and the entire `system.*` management surface (including `system.control.*`) is reachable with no authorization.** See `src/acl-builder.ts` for a copy-pasteable rule template that gates it correctly.
- `approvalHandler` — Optional approval handler passed to the Executor (e.g. `ElicitationApprovalHandler`)
- `strategy` — Execution strategy name passed to the Executor (e.g. `"standard"`, `"internal"`)

*Observability (F-044)*
- `metricsCollector` — `MetricsExporter` instance, or `true` to auto-instantiate apcore-js's `MetricsCollector` and install `MetricsMiddleware`
- `observability` — Enable the full observability stack (metrics + usage middleware) and expose `/metrics` + `/usage` endpoints
- `trace` — When `true`, enables pipeline trace via `callWithTrace()`. Adds `_meta.trace` to non-streaming tool responses. Default: `false`

*Output handling*
- `outputFormatter` — Custom function to format tool execution results. When undefined, results are serialized with `JSON.stringify(result)`
- `redactOutput` — When `true` (default), redact sensitive fields from tool output via apcore's `redactSensitive()` before formatting

*Auth (HTTP transports only)*
- `authenticator` — `Authenticator` instance for request authentication
- `requireAuth` — If `true` (default), unauthenticated requests are rejected with 401. Set to `false` for permissive mode
- `exemptPaths` — Paths exempt from authentication. Default: `["/health", "/metrics"]`

*Tool Explorer UI*
- `explorer` — Enable the browser-based Tool Explorer UI (HTTP only). Default: `false`
- `explorerPrefix` — URL prefix for the explorer. Default: `"/explorer"`
- `allowExecute` — Allow tool execution from the explorer UI. Default: `false`
- `explorerTitle` — Custom title for the Tool Explorer UI page
- `explorerProjectName` — Project name shown in the explorer UI footer
- `explorerProjectUrl` — Project URL shown in the explorer UI footer

*Adapter overrides (advanced — Extension Bridge, F-042)*
- `schemaConverter` — Override the default `SchemaConverter` (custom JSON Schema strictness/dialect)
- `annotationMapper` — Override the default `AnnotationMapper` (custom annotation wire format)
- `errorMapper` — Override the default `ErrorMapper` consumed by `ExecutionRouter`

### `asyncServe(registryOrExecutor, options?)`

Embed the MCP server into a larger Node.js HTTP application. Returns an HTTP request handler and a close function for lifecycle management.

```typescript
import { asyncServe } from "apcore-mcp";

const { handler, close } = await asyncServe(executor, {
  name: "apcore-mcp",
  explorer: true,
  allowExecute: true,
});

// Mount in a custom HTTP server
const server = http.createServer(handler);
server.listen(8000);

// Clean up when done
await close();
```

Accepts the same options as `serve()` except `transport`, `host`, `port`, `onStartup`, and `onShutdown`.

### Output Formatting

By default, tool execution results are serialized as JSON (`JSON.stringify`). You can customize this by passing an `outputFormat` name or a custom `outputFormatter` function.

**Built-in formats** (requires `apcore-toolkit` 0.7.0+):

```typescript
// Via CLI
// npx apcore-mcp --extensions-dir ./extensions --output-format csv

// Via API
const mcp = new APCoreMCP("./extensions", { outputFormat: "csv" });
```

Supports `json`, `csv`, and `jsonl`. Non-tabular data gracefully falls back to JSON.

### Tool Explorer

When `explorer: true` is passed to `serve()`, a browser-based Tool Explorer UI is mounted on HTTP transports. It provides an interactive page for browsing tool schemas and testing tool execution.

```typescript
await serve(registry, {
  transport: "streamable-http",
  explorer: true,
  allowExecute: true,
});
// Open http://127.0.0.1:8000/explorer/ in a browser
```

**Endpoints:**

| Endpoint | Description |
|----------|-------------|
| `GET /explorer/` | Interactive HTML page (self-contained, no external dependencies) |
| `GET /explorer/tools` | JSON array of all tools with name, description, annotations |
| `GET /explorer/tools/<name>` | Full tool detail with inputSchema |
| `POST /explorer/tools/<name>/call` | Execute a tool (requires `allowExecute: true`) |

- **HTTP transports only** (`streamable-http`, `sse`). Silently ignored for `stdio`.
- **Execution disabled by default** — set `allowExecute: true` to enable Try-it.
- **Custom prefix** — use `explorerPrefix: "/browse"` to mount at a different path.
- **Authorization UI** — Swagger-UI-style Authorization input field. Paste a Bearer token to authenticate tool execution requests. Generated cURL commands automatically include the Authorization header.

### JWT Authentication

apcore-mcp supports JWT Bearer token authentication for HTTP-based transports.

#### Programmatic Usage

```typescript
import { serve, JWTAuthenticator } from "apcore-mcp";

const authenticator = new JWTAuthenticator({
  key: "your-secret-key",
  algorithms: ["HS256"],
  audience: "my-app",
  issuer: "auth-service",
  // Map custom claims to Identity fields
  claimMapping: {
    id: "sub",
    type: "type",
    roles: "roles",
    attrs: ["email", "org"],  // Extra claims → Identity.attrs
  },
  // Claims that must be present in the token (default: ["sub"])
  requireClaims: ["sub", "email"],
  // Set to false for permissive mode (allow unauthenticated requests)
  requireAuth: true,
});

await serve(executor, {
  transport: "streamable-http",
  authenticator,
  // Custom exempt paths (default: ["/health", "/metrics"])
  exemptPaths: ["/health", "/metrics", "/status"],
});
```

#### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--jwt-secret` | — | JWT secret key for Bearer token authentication |
| `--jwt-key-file` | — | Path to PEM key file for JWT verification |
| `--jwt-algorithm` | `HS256` | JWT algorithm |
| `--jwt-audience` | — | Expected audience claim |
| `--jwt-issuer` | — | Expected issuer claim |
| `--jwt-require-auth` | `true` | Require auth. Use `--jwt-permissive` to allow unauthenticated requests |
| `--jwt-permissive` | `false` | Overrides `--jwt-require-auth` and allows unauthenticated requests |
| `--exempt-paths` | `/health,/metrics,/usage` | Comma-separated paths exempt from auth |

JWT key resolution priority: `--jwt-key-file` > `--jwt-secret` > `APCORE_JWT_SECRET` environment variable.

#### curl Examples

```bash
# Authenticated request
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-jwt-token>" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# Health check (always exempt)
curl http://localhost:8000/health
```

#### Per-request identity helpers

When auth is enabled, each request runs inside an `AsyncLocalStorage`
context whose value is the verified `Identity`. Modules and middleware
read it with `getCurrentIdentity()` — no need to thread it through every
function.

```typescript
import { getCurrentIdentity, identityStorage } from "apcore-mcp";
import type { Identity } from "apcore-mcp";

// Inside a module / middleware called from a tool invocation:
const id: Identity | null = getCurrentIdentity();
if (id) {
  // id.id (user id), id.type ("user" | "service" | ...), id.roles, id.attrs
}

// Lower-level access (e.g. for running custom code inside a known identity):
identityStorage.run(myIdentity, async () => {
  /* code that calls getCurrentIdentity() */
});
```

Python parity: `apcore_mcp.get_current_identity()` / `auth_identity_var`.
Rust parity: `apcore_mcp::AUTH_IDENTITY` task-local.

#### Mounting the Explorer behind your own server

If you embed the bridge via `asyncServe(...)` instead of `serve(...)`,
gate the explorer routes behind an auth hook with
`buildExplorerAuthHook(authenticator)`:

```typescript
import { buildExplorerAuthHook } from "apcore-mcp";
import { JWTAuthenticator } from "apcore-mcp";

const auth = new JWTAuthenticator({ key: process.env.JWT_SECRET! });
const guard = buildExplorerAuthHook(auth);

// `guard` is a `(req, next) => Promise<Response>` hook accepted by
// mcp-embedded-ui's Hono router. Returns a 401 response when the
// Authorization header is missing or invalid; otherwise runs `next()`
// inside `identityStorage.run(identity, ...)` so the explorer's
// downstream handlers see the authenticated identity.
```

#### Custom observability stack (advanced)

For callers who don't want the `serve(... observability: true)` shorthand,
`installObservability` wires the metrics + usage middleware onto an
existing `Executor` directly. It is what `serve()` calls internally.

```typescript
import { installObservability } from "apcore-mcp";
import type { ObservabilityFlag } from "apcore-mcp";

const stack = await installObservability(executor, /* metricsCollector */ null, true satisfies ObservabilityFlag);
// stack.metricsCollector / stack.usageCollector are then exposed on
// the `/metrics` and `/usage` endpoints by your own HTTP wiring.
```

### `toOpenaiTools(registryOrExecutor, options?)`

Export apcore modules as OpenAI-compatible tool definitions.

```typescript
function toOpenaiTools(
  registryOrExecutor: Registry | Executor,
  options?: {
    embedAnnotations?: boolean;
    strict?: boolean;
    tags?: string[];
    prefix?: string;
  }
): OpenAIToolDef[];
```

**Options:**

- `embedAnnotations` — Append annotation metadata to tool descriptions (default: `false`)
- `strict` — Enable OpenAI strict mode: adds `additionalProperties: false`, makes all properties required, wraps optional properties with nullable (default: `false`)
- `tags` — Filter modules by tags
- `prefix` — Filter modules by ID prefix

### `reportProgress(context, progress, total?, message?)`

Report execution progress to the MCP client. No-ops silently when called outside an MCP context (no callback injected).

```typescript
import { reportProgress } from "apcore-mcp";

// Inside a module's execute() method:
await reportProgress(context, 5, 10, "Processing item 5 of 10");
```

**Parameters:**

- `context` — Object with a `data` dict (apcore Context or BridgeContext)
- `progress` — Current progress value
- `total` — Optional total for percentage calculation
- `message` — Optional human-readable progress message

### `elicit(context, message, requestedSchema?)`

Ask the MCP client for user input via the elicitation protocol. Returns `null` when called outside an MCP context.

```typescript
import { elicit } from "apcore-mcp";
import type { ElicitResult } from "apcore-mcp";

// Inside a module's execute() method:
const result: ElicitResult | null = await elicit(
  context,
  "Are you sure you want to proceed?",
  {
    type: "object",
    properties: {
      confirmed: { type: "boolean", description: "Confirm action" },
    },
    required: ["confirmed"],
  },
);

if (result?.action === "accept") {
  // User confirmed
}
```

**Parameters:**

- `context` — Object with a `data` dict (apcore Context or BridgeContext)
- `message` — Message to display to the user
- `requestedSchema` — Optional JSON Schema describing the expected input

**Returns:** `ElicitResult` with `action` (`"accept"`, `"decline"`, or `"cancel"`) and optional `content`, or `null` if not in an MCP context.

## Config Bus Integration

apcore-mcp registers an `mcp` namespace with the apcore Config Bus when `serve()` or `asyncServe()` is called. MCP settings can live alongside other apcore configuration in a single `apcore.yaml`:

```yaml
apcore:
  version: "1.0.0"
mcp:
  transport: streamable-http
  host: 0.0.0.0
  port: 9000
  explorer: true
  require_auth: false
```

Environment variable overrides use the `APCORE_MCP_` prefix:

```bash
APCORE_MCP_TRANSPORT=streamable-http
APCORE_MCP_PORT=9000
APCORE_MCP_EXPLORER=true
```

**Defaults:** `transport=stdio`, `host=127.0.0.1`, `port=8000`, `explorer=false`, `require_auth=true`.

The namespace, prefix, and defaults are also available as importable constants:

```typescript
import { MCP_NAMESPACE, MCP_ENV_PREFIX, MCP_DEFAULTS, registerMcpNamespace } from "apcore-mcp";
```

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Build
npm run build

# Watch mode
npm run dev
```

## License

Apache-2.0
