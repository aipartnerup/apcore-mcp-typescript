/**
 * TransportManager - Manages MCP server transport lifecycle.
 *
 * Supports three transport modes:
 * - stdio: Standard input/output (fully implemented)
 * - streamableHttp: Streamable HTTP with SSE support
 * - sse: Legacy Server-Sent Events transport
 */

import * as crypto from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Authenticator } from "../auth/types.js";
import { identityStorage } from "../auth/storage.js";

/** Options for HTTP-based transports. */
export interface HttpTransportOptions {
  host: string;
  port: number;
  endpoint?: string;
}

/** Duck-typed interface for a metrics collector that can export Prometheus text. */
export interface MetricsExporter {
  exportPrometheus(): string;
}

/** Duck-typed interface for apcore-js's UsageCollector. */
export interface UsageExporter {
  getSummary(period?: string): unknown;
  getModule(moduleId: string, period?: string): unknown;
}

/** Default maximum request body size in bytes (4MB). */
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Prometheus exposition format content-type. */
const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Maximum request body size in bytes. Configurable via APCORE_MAX_BODY_BYTES env var. */
const MAX_BODY_BYTES = (() => {
  const env = process.env.APCORE_MAX_BODY_BYTES;
  if (env === undefined) return DEFAULT_MAX_BODY_BYTES;
  const parsed = Number.parseInt(env, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BODY_BYTES;
  return parsed;
})();

/**
 * Read the full request body as a string.
 *
 * Enforces a maximum byte size to prevent memory exhaustion.
 * @param req - The incoming HTTP request
 * @param maxBytes - Maximum allowed body size in bytes (default: MAX_BODY_BYTES)
 */
export function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        rejected = true;
        // Resume to drain remaining data, allowing the response to be sent
        req.resume();
        reject(new Error("Request body too large"));
        return;
      }
      data += chunk.toString();
    });
    req.on("end", () => {
      if (!rejected) resolve(data);
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

export class TransportManager {
  /** The underlying HTTP server, if an HTTP-based transport is active. */
  httpServer?: HttpServer;

  /** Timestamp (ms) when this manager was created, used for uptime calculation. */
  private _startTime: number = Date.now();

  /** Number of registered modules/tools. */
  private _moduleCount: number = 0;

  /** Optional metrics collector for Prometheus /metrics endpoint. */
  private _metricsCollector?: MetricsExporter;

  /** Optional usage collector for /usage endpoint. */
  private _usageCollector?: UsageExporter;

  /** Optional explorer node handler (from mcp-embedded-ui). */
  private _explorerNodeHandler?: (req: IncomingMessage, res: ServerResponse) => void;

  /** URL prefix for the explorer UI. */
  private _explorerPrefix?: string;

  /** Optional authenticator for request authentication. */
  private _authenticator?: Authenticator;

  /** Configurable set of paths exempt from authentication.
   *
   * [D11-2] Cross-SDK parity with apcore-mcp-python (auth/middleware.py)
   * and apcore-mcp-rust (auth/middleware.rs) which both default to
   * {"/health", "/metrics"} only. `/usage` is an auth-requiring diagnostic
   * endpoint by default; callers who want it exempt must opt in explicitly
   * via the exemptPaths option.
   */
  private _exemptPaths = new Set(["/health", "/metrics"]);

  /** Explicit requireAuth override (when set, takes precedence over authenticator's own value). */
  private _requireAuth?: boolean;

  /**
   * Optional AsyncTaskBridge — used to cancel session-bound async tasks
   * on transport disconnect via `cancelSessionTasks(sessionId)`.
   * [A-D-018]
   */
  private _asyncTaskBridge?: {
    cancelSessionTasks(sessionKey: string): Promise<number>;
  };

  /**
   * Set the number of registered modules/tools.
   *
   * @param count - The number of modules
   */
  setModuleCount(count: number): void {
    this._moduleCount = count;
  }

  /**
   * Set the authenticator for request authentication.
   *
   * @param authenticator - An Authenticator instance (e.g. JWTAuthenticator)
   */
  setAuthenticator(authenticator: Authenticator): void {
    this._authenticator = authenticator;
  }

  /**
   * Set the requireAuth override.
   *
   * When set, this takes precedence over the authenticator's own requireAuth property.
   * Matches the Python SDK's top-level require_auth parameter.
   *
   * @param requireAuth - If true, unauthenticated requests are rejected. If false, they proceed without identity.
   */
  setRequireAuth(requireAuth: boolean): void {
    this._requireAuth = requireAuth;
  }

  /**
   * Set the paths that are exempt from authentication.
   *
   * @param paths - Array of path strings to exempt
   */
  setExemptPaths(paths: string[]): void {
    this._exemptPaths = new Set(paths);
  }

  /**
   * Set the metrics collector for Prometheus /metrics endpoint.
   *
   * @param collector - A MetricsExporter instance (e.g. MetricsCollector from apcore)
   */
  setMetricsCollector(collector: MetricsExporter): void {
    this._metricsCollector = collector;
  }

  /**
   * Set the usage collector for the /usage JSON endpoint.
   *
   * @param collector - A UsageExporter instance (e.g. UsageCollector from apcore)
   */
  setUsageCollector(collector: UsageExporter): void {
    this._usageCollector = collector;
  }

  /**
   * Set the explorer handler for Tool Explorer UI routes.
   *
   * @param handler - A Node.js HTTP handler (from mcp-embedded-ui's createNodeHandler)
   * @param prefix - The URL prefix for the explorer (e.g. "/explorer")
   */
  setExplorer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    prefix: string,
  ): void {
    this._explorerNodeHandler = handler;
    this._explorerPrefix = prefix;
  }

  /**
   * Wire an AsyncTaskBridge into the transport so client-disconnect events
   * trigger `cancelSessionTasks(sessionId)` for cooperative cancellation
   * of long-running async tasks bound to that session. Mirrors Rust's
   * `TransportManager::set_cancel_handler`. [A-D-018]
   *
   * @param bridge - Object with a `cancelSessionTasks(sessionKey)` method
   */
  setAsyncTaskBridge(bridge: {
    cancelSessionTasks(sessionKey: string): Promise<number>;
  }): void {
    // [D10-006] Reject null/undefined bridge (matching Python `TypeError`).
    // Silently storing null would surface later as a TypeError on first
    // session disconnect, far from the actual misconfiguration site.
    if (bridge == null) {
      throw new TypeError(
        "setAsyncTaskBridge requires a non-null bridge with cancelSessionTasks(sessionKey)",
      );
    }
    this._asyncTaskBridge = bridge;
  }

  /**
   * Build the health check response payload.
   *
   * @returns Health status object with uptime and module count
   */
  private _buildHealthResponse(): { status: string; uptime_seconds: number; module_count: number } {
    return {
      status: "ok",
      uptime_seconds: Math.round((Date.now() - this._startTime) / 100) / 10,
      module_count: this._moduleCount,
    };
  }

  /**
   * Handle built-in routes (/health and /metrics).
   *
   * @param req - The incoming HTTP request
   * @param res - The server response
   * @param url - The parsed URL
   * @returns true if the request was handled, false otherwise
   */
  private _handleBuiltinRoute(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this._buildHealthResponse()));
      return true;
    }
    if (url.pathname === "/metrics" && req.method === "GET") {
      if (!this._metricsCollector) {
        res.writeHead(404);
        res.end();
        return true;
      }
      try {
        const body = this._metricsCollector.exportPrometheus();
        res.writeHead(200, { "Content-Type": PROMETHEUS_CONTENT_TYPE });
        res.end(body);
      } catch {
        res.writeHead(500);
        res.end();
      }
      return true;
    }
    if (url.pathname === "/usage" && req.method === "GET") {
      if (!this._usageCollector) {
        res.writeHead(404);
        res.end();
        return true;
      }
      try {
        const period = url.searchParams.get("period") ?? "24h";
        const moduleId = url.searchParams.get("module_id");
        const payload = moduleId
          ? this._usageCollector.getModule(moduleId, period)
          : { summary: this._usageCollector.getSummary(period), period };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return true;
    }
    return false;
  }

  /**
   * Dispatch a builtin route only when that route is exempt from authentication.
   *
   * [A-D-TR-8] Builtin routes used to be dispatched wholesale *before*
   * `_authenticateRequest`, which short-circuited `/usage` and served module ids,
   * call counts, unique callers and latency to unauthenticated clients even when
   * `requireAuth` was on. Only paths in `_exemptPaths` (default `/health` and
   * `/metrics`) may be served pre-auth; everything else falls through to
   * `_authenticateRequest` and is dispatched by `_handleBuiltinRoute` afterwards.
   * Callers who genuinely want `/usage` open must opt in via `setExemptPaths`.
   *
   * @param req - The incoming HTTP request
   * @param res - The server response
   * @param url - The parsed URL
   * @returns true if the request was handled, false otherwise
   */
  private _handleExemptBuiltinRoute(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!this._isAuthExempt(url.pathname, req.method ?? "GET")) return false;
    return this._handleBuiltinRoute(req, res, url);
  }

  /**
   * Check if a request path/method combination is exempt from authentication.
   *
   * Exempt routes: /health, /metrics (GET), and explorer GET routes.
   */
  _isAuthExempt(pathname: string, method: string): boolean {
    if (method === "GET" && this._exemptPaths.has(pathname)) return true;
    // Explorer GET routes are exempt (browsing the UI).
    // Note: in practice, explorer routes are dispatched before _authenticateRequest
    // is called, so this branch is a defensive fallback for safety.
    if (this._explorerPrefix && method === "GET") {
      const prefix = this._explorerPrefix;
      if (pathname === prefix || pathname === prefix + "/" || pathname.startsWith(prefix + "/")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Authenticate an incoming request using the configured authenticator.
   *
   * Returns the Identity on success, or sends a 401 response and returns null.
   * If no authenticator is set, returns null (no auth required).
   */
  async _authenticateRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<{ identity: import("../auth/types.js").Identity | null; blocked: boolean }> {
    if (!this._authenticator) {
      return { identity: null, blocked: false };
    }

    // Extract flat headers map from IncomingMessage for the Authenticator interface.
    // The Authenticator now takes Record<string,string> (matching Python dict / Rust HashMap),
    // so the transport layer is responsible for the IncomingMessage → headers adaptation.
    const headersMap = this._extractHeaders(req);

    if (this._isAuthExempt(url.pathname, req.method ?? "GET")) {
      // Best-effort identity extraction: exempt paths don't *require* auth,
      // but if a valid token is present we still return the identity so that
      // downstream handlers (e.g. require_user_id) can use it.
      let identity: import("../auth/types.js").Identity | null = null;
      try {
        identity = await this._authenticator.authenticate(headersMap);
      } catch {
        // Exempt path — auth failure is fine
      }
      return { identity, blocked: false };
    }

    const identity = await this._authenticator.authenticate(headersMap);
    if (!identity) {
      const requireAuth = this._requireAuth ?? this._authenticator.requireAuth ?? true;
      if (!requireAuth) {
        return { identity: null, blocked: false };
      }
      // [JWT-2] Unify 401 body shape with Python+Rust:
      // {error: "Unauthorized", detail: "Missing or invalid Bearer token"}.
      // Pre-fix TS emitted {error: "Authentication required"} which
      // diverged from the other two SDKs' shape.
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      res.end(
        JSON.stringify({
          error: "Unauthorized",
          detail: "Missing or invalid Bearer token",
        }),
      );
      return { identity: null, blocked: true };
    }

    return { identity, blocked: false };
  }

  /**
   * Extract a flat headers map from an IncomingMessage.
   *
   * Converts Node.js's `IncomingHttpHeaders` (which allows string | string[] | undefined)
   * to Record<string, string> so Authenticators receive the same flat dict that
   * Python (`headers: dict`) and Rust (`&HashMap<String, String>`) expose.
   * Multi-value headers are joined with ", " (the HTTP/1.1 header folding convention).
   */
  private _extractHeaders(req: IncomingMessage): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      result[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
    return result;
  }

  /**
   * Create a Streamable HTTP request handler function.
   *
   * Shared by both `runStreamableHttp` (standalone server) and
   * `buildStreamableHttpApp` (embeddable handler).
   */
  private _createStreamableHandler(
    transport: StreamableHTTPServerTransport,
    endpoint: string,
    urlBase: string,
  ): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    const explorerNodeHandler = this._explorerNodeHandler;
    const explorerPrefix = this._explorerPrefix;

    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const url = new URL(req.url ?? "/", urlBase);

      // Exempt builtin routes (/health, /metrics by default) are served before auth.
      if (this._handleExemptBuiltinRoute(req, res, url)) return;

      // Delegate to explorer handler if path matches prefix (handles its own auth)
      if (explorerNodeHandler && explorerPrefix &&
        (url.pathname === explorerPrefix || url.pathname.startsWith(explorerPrefix + "/"))) {
        explorerNodeHandler(req, res);
        return;
      }

      // Authenticate non-exempt requests
      const { identity, blocked } = await this._authenticateRequest(req, res, url);
      if (blocked) return;

      // Auth-requiring builtin routes (/usage by default) are served only now.
      if (this._handleBuiltinRoute(req, res, url)) return;

      if (url.pathname !== endpoint) {
        res.writeHead(404).end("Not Found");
        return;
      }

      const handleMcp = async () => {
        try {
          if (req.method === "POST" || req.method === "DELETE") {
            const body = await readBody(req);
            const parsed = body ? JSON.parse(body) : undefined;
            await transport.handleRequest(req, res, parsed);
          } else {
            await transport.handleRequest(req, res);
          }
        } catch (err) {
          if (!res.headersSent) {
            const message = err instanceof Error ? err.message : "";
            if (message === "Request body too large") {
              res.writeHead(413).end("Request Entity Too Large");
            } else if (err instanceof SyntaxError) {
              res.writeHead(400).end("Bad Request");
            } else {
              res.writeHead(500).end("Internal Server Error");
            }
          }
        }
      };

      // Wrap in identityStorage so getCurrentIdentity() works in the call chain
      if (identity) {
        await identityStorage.run(identity, handleMcp);
      } else {
        await handleMcp();
      }
    };
  }

  /**
   * Run the server using stdio transport.
   *
   * Creates a StdioServerTransport and connects it to the server.
   * This is the standard transport for CLI-based MCP servers.
   *
   * @param server - The MCP Server instance to connect
   */
  async runStdio(server: Server): Promise<void> {
    const transport = new StdioServerTransport();

    // [A-D-TR-2] stdio has no wire-level session id, so synthesize one and wire
    // teardown cancellation the same way runSse and runStreamableHttp do. The
    // set_async_task_bridge contract is not restricted to network transports —
    // Python honours it on stdio (transport.py:106-113) — and without this,
    // async tasks submitted over stdio outlived the client's exit.
    if (this._asyncTaskBridge) {
      const sessionId = crypto.randomUUID();
      const existing = transport.onclose;
      transport.onclose = () => {
        this._asyncTaskBridge?.cancelSessionTasks(sessionId).catch((err: unknown) => {
          console.warn(
            `cancelSessionTasks failed for stdio session ${sessionId}:`,
            err,
          );
        });
        if (existing) existing();
      };
    }

    await server.connect(transport);
  }

  /**
   * Run the server using Streamable HTTP transport.
   *
   * Creates a StreamableHTTPServerTransport and sets up an HTTP server
   * to handle requests.
   *
   * @param server - The MCP Server instance to connect
   * @param options - Host, port, and optional endpoint configuration
   */
  async runStreamableHttp(
    server: Server,
    options: HttpTransportOptions,
  ): Promise<void> {
    this._validateHostPort(options.host, options.port);

    const endpoint = options.endpoint ?? "/mcp";

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    // [A-D-018] StreamableHTTP wiring: when the transport closes (server
    // shutdown or SDK-internal session expiry), cancel any session-bound
    // async tasks via the bridge. Mirrors the SSE-side onclose handler.
    // Note: the SDK exposes a single onclose for the whole transport,
    // not per-session — this fires once when the transport tears down,
    // not on individual client disconnects. For per-client cancellation
    // we'd need per-session-aware hooks the SDK does not currently
    // provide. The transport-shutdown path is still a real cleanup
    // point worth wiring.
    if (this._asyncTaskBridge) {
      const existing = transport.onclose;
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && this._asyncTaskBridge) {
          this._asyncTaskBridge.cancelSessionTasks(sid).catch((err: unknown) => {
            console.warn(
              `cancelSessionTasks failed for streamable-http session ${sid}:`,
              err,
            );
          });
        }
        if (existing) existing();
      };
    }

    await server.connect(transport);

    const handler = this._createStreamableHandler(
      transport,
      endpoint,
      `http://${options.host}:${options.port}`,
    );
    const httpServer = createServer(handler);

    this.httpServer = httpServer;

    return new Promise((resolve) => {
      httpServer.listen(options.port, options.host, () => {
        const addr = httpServer.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : options.port;
        console.info(
          `StreamableHTTP transport listening on ${options.host}:${actualPort}${endpoint}`,
        );
        resolve();
      });
    });
  }

  /**
   * Run the server using SSE (Server-Sent Events) transport.
   *
   * Creates an HTTP server that handles SSE connections (GET) and
   * message posting (POST). Each SSE connection creates a new
   * SSEServerTransport instance.
   *
   * @param server - The MCP Server instance to connect
   * @param options - Host, port, and optional endpoint configuration
   */
  async runSse(
    server: Server,
    options: HttpTransportOptions,
  ): Promise<void> {
    this._validateHostPort(options.host, options.port);

    const endpoint = options.endpoint ?? "/sse";
    const messagesEndpoint = "/messages";
    const transports = new Map<string, SSEServerTransport>();

    const explorerNodeHandler = this._explorerNodeHandler;
    const explorerPrefix = this._explorerPrefix;

    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${options.host}:${options.port}`);

      // Exempt builtin routes (/health, /metrics by default) are served before auth.
      if (this._handleExemptBuiltinRoute(req, res, url)) return;

      // Delegate to explorer handler if path matches prefix (handles its own auth)
      if (explorerNodeHandler && explorerPrefix &&
        (url.pathname === explorerPrefix || url.pathname.startsWith(explorerPrefix + "/"))) {
        explorerNodeHandler(req, res);
        return;
      }

      // Authenticate non-exempt requests
      const { identity, blocked } = await this._authenticateRequest(req, res, url);
      if (blocked) return;

      // Auth-requiring builtin routes (/usage by default) are served only now.
      if (this._handleBuiltinRoute(req, res, url)) return;

      const handleSse = async () => {
        if (url.pathname === endpoint && req.method === "GET") {
          // Establish SSE connection
          const transport = new SSEServerTransport(messagesEndpoint, res);
          const sessionId = transport.sessionId;
          transports.set(sessionId, transport);

          transport.onclose = () => {
            transports.delete(sessionId);
            // [A-D-018] Cooperatively cancel any async tasks bound to
            // this session when the client disconnects.
            if (this._asyncTaskBridge) {
              this._asyncTaskBridge
                .cancelSessionTasks(sessionId)
                .catch((err: unknown) => {
                  console.warn(
                    `cancelSessionTasks failed for session ${sessionId}:`,
                    err,
                  );
                });
            }
          };

          await server.connect(transport);
          await transport.start();
        } else if (url.pathname === messagesEndpoint && req.method === "POST") {
          // Route message to the correct session transport
          const sessionId = url.searchParams.get("sessionId");
          if (!sessionId) {
            res.writeHead(400).end("Missing sessionId parameter");
            return;
          }

          const transport = transports.get(sessionId);
          if (!transport) {
            res.writeHead(400).end("Unknown session");
            return;
          }

          try {
            const body = await readBody(req);
            const parsed = body ? JSON.parse(body) : undefined;
            await transport.handlePostMessage(req, res, parsed);
          } catch (err) {
            if (!res.headersSent) {
              const message = err instanceof Error ? err.message : "";
              if (message === "Request body too large") {
                res.writeHead(413).end("Request Entity Too Large");
              } else if (err instanceof SyntaxError) {
                res.writeHead(400).end("Bad Request");
              } else {
                res.writeHead(500).end("Internal Server Error");
              }
            }
          }
        } else {
          res.writeHead(404).end("Not Found");
        }
      };

      // Wrap in identityStorage so getCurrentIdentity() works in the call chain
      if (identity) {
        await identityStorage.run(identity, handleSse);
      } else {
        await handleSse();
      }
    });

    this.httpServer = httpServer;

    return new Promise((resolve) => {
      httpServer.listen(options.port, options.host, () => {
        const addr = httpServer.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : options.port;
        console.info(
          `SSE transport listening on ${options.host}:${actualPort}${endpoint}`,
        );
        resolve();
      });
    });
  }

  /**
   * Build a Streamable HTTP request handler for embedding into a larger HTTP server.
   *
   * Returns a Node.js HTTP request handler `(req, res) => Promise<void>` that
   * handles all MCP, health, metrics, explorer, and auth routes. The caller is
   * responsible for creating the HTTP server and wiring this handler.
   *
   * This is the TypeScript equivalent of Python's `build_streamable_http_app()`
   * which returns a Starlette ASGI app for mounting into larger services.
   *
   * @param server - The MCP Server instance to connect
   * @param options - Optional endpoint configuration (default: "/mcp")
   * @returns Object with `handler` and `close()` to clean up the transport
   */
  async buildStreamableHttpApp(
    server: Server,
    options?: { endpoint?: string },
  ): Promise<{
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    close: () => Promise<void>;
  }> {
    const endpoint = options?.endpoint ?? "/mcp";

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    // [A-D-018] StreamableHTTP wiring: when the transport closes (server
    // shutdown or SDK-internal session expiry), cancel any session-bound
    // async tasks via the bridge. Mirrors the SSE-side onclose handler.
    // Note: the SDK exposes a single onclose for the whole transport,
    // not per-session — this fires once when the transport tears down,
    // not on individual client disconnects. For per-client cancellation
    // we'd need per-session-aware hooks the SDK does not currently
    // provide. The transport-shutdown path is still a real cleanup
    // point worth wiring.
    if (this._asyncTaskBridge) {
      const existing = transport.onclose;
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && this._asyncTaskBridge) {
          this._asyncTaskBridge.cancelSessionTasks(sid).catch((err: unknown) => {
            console.warn(
              `cancelSessionTasks failed for streamable-http session ${sid}:`,
              err,
            );
          });
        }
        if (existing) existing();
      };
    }

    await server.connect(transport);

    const handler = this._createStreamableHandler(transport, endpoint, "http://localhost");

    const close = async () => {
      await transport.close();
    };

    return { handler, close };
  }

  /**
   * Close the HTTP server if one is running.
   */
  async close(): Promise<void> {
    if (!this.httpServer) return;

    return new Promise((resolve) => {
      this.httpServer!.close(() => resolve());
    });
  }

  /**
   * Validate host and port parameters for HTTP transports.
   *
   * @param host - Must be a non-empty string
   * @param port - Must be an integer between 1 and 65535
   * @throws Error if validation fails
   */
  _validateHostPort(host: string, port: number): void {
    if (!host || typeof host !== "string" || host.trim().length === 0) {
      throw new Error("Host must be a non-empty string");
    }

    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      throw new Error("Port must be an integer between 1 and 65535");
    }
  }
}
