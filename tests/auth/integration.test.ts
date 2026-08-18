/**
 * Integration tests for auth + transport + explorer.
 *
 * Tests that authenticated requests flow through to the MCP endpoint,
 * unauthenticated requests are rejected, and exempt routes bypass auth.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AddressInfo } from "node:net";
import { createNodeHandler, type Tool as UITool } from "mcp-embedded-ui";
import { TransportManager } from "../../src/server/transport.js";
import { JWTAuthenticator } from "../../src/auth/jwt.js";
import { buildExplorerAuthHook } from "../../src/auth/hooks.js";
import { getCurrentIdentity } from "../../src/auth/storage.js";
import type { ExecutionRouter } from "../../src/server/router.js";
import type { TextContentDict } from "../../src/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = "integration-test-secret";

function signToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, SECRET, { algorithm: "HS256" });
}

function createMockServer(): Server {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
  } as unknown as Server;
}

function createMockRouter(): ExecutionRouter {
  return {
    handleCall: vi.fn().mockResolvedValue([
      [{ type: "text", text: '{"result":"ok"}' }] as TextContentDict[],
      false,
      "trace-int",
    ]),
  } as unknown as ExecutionRouter;
}

const sampleTools: Tool[] = [
  {
    name: "test.tool",
    description: "Test tool",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

/**
 * Build a mcp-embedded-ui node handler and set it on the TransportManager,
 * matching the pattern used in serve().
 */
function setupExplorer(
  mgr: TransportManager,
  router: ExecutionRouter,
  options: { authenticator?: JWTAuthenticator; allowExecute?: boolean; prefix?: string } = {},
): void {
  const prefix = options.prefix ?? "/explorer";
  const authHook = options.authenticator
    ? buildExplorerAuthHook(options.authenticator)
    : undefined;

  const handler = createNodeHandler(
    sampleTools as UITool[],
    async (name: string, args: Record<string, unknown>) => router.handleCall(name, args),
    { prefix, allowExecute: options.allowExecute ?? true, authHook },
  );

  mgr.setExplorer(handler, prefix);
}

// ---------------------------------------------------------------------------
// Transport + Auth Integration
// ---------------------------------------------------------------------------

describe("Transport auth integration (streamable-http)", () => {
  let mgr: TransportManager;

  afterEach(async () => {
    if (mgr) await mgr.close();
  });

  it("/health is exempt from auth", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET }));
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("/metrics is exempt from auth", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET }));
    mgr.setMetricsCollector({ exportPrometheus: () => "# no metrics" });
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
    expect(res.status).toBe(200);
  });

  it("POST /mcp returns 401 without token", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET }));
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    // [JWT-2] 401 body shape unified with Python+Rust:
    // {error: "Unauthorized", detail: "Missing or invalid Bearer token"}
    expect(body.error).toBe("Unauthorized");
    expect(body.detail).toContain("Bearer");
  });

  it("POST /mcp proceeds with valid token", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET }));
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const token = signToken({ sub: "user-1" });
    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    // Should reach the transport handler (not our 401)
    expect(res.status).not.toBe(401);
  });

  it("returns 401 for invalid token", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET }));
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid.token.here",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("no auth required when no authenticator is set", async () => {
    mgr = new TransportManager();
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).not.toBe(401);
  });
});

describe("Transport auth integration (sse)", () => {
  let mgr: TransportManager;

  afterEach(async () => {
    if (mgr) await mgr.close();
  });

  it("/health is exempt from auth in SSE mode", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET }));
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runSse(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(res.status).toBe(200);
  });

  it("POST /messages returns 401 without token in SSE mode", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET }));
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runSse(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/messages?sessionId=abc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Explorer + Auth Integration
// ---------------------------------------------------------------------------

describe("Explorer auth integration", () => {
  let mgr: TransportManager;

  afterEach(async () => {
    if (mgr) await mgr.close();
  });

  it("GET /explorer/ is exempt from auth", async () => {
    mgr = new TransportManager();
    const authenticator = new JWTAuthenticator({ secret: SECRET });
    mgr.setAuthenticator(authenticator);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    const router = createMockRouter();
    setupExplorer(mgr, router, { authenticator, allowExecute: true });

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/explorer/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("MCP Tool Explorer");
  });

  it("GET /explorer/tools is exempt from auth", async () => {
    mgr = new TransportManager();
    const authenticator = new JWTAuthenticator({ secret: SECRET });
    mgr.setAuthenticator(authenticator);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    const router = createMockRouter();
    setupExplorer(mgr, router, { authenticator, allowExecute: true });

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/explorer/tools`);
    expect(res.status).toBe(200);
  });

  it("POST /explorer/tools/{name}/call returns 401 without token when authenticator set", async () => {
    mgr = new TransportManager();
    const authenticator = new JWTAuthenticator({ secret: SECRET });
    mgr.setAuthenticator(authenticator);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    const router = createMockRouter();
    setupExplorer(mgr, router, { authenticator, allowExecute: true });

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/explorer/tools/test.tool/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Unauthorized");
  });

  it("POST /explorer/tools/{name}/call succeeds with valid token", async () => {
    mgr = new TransportManager();
    const authenticator = new JWTAuthenticator({ secret: SECRET });
    mgr.setAuthenticator(authenticator);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    const router = createMockRouter();
    setupExplorer(mgr, router, { authenticator, allowExecute: true });

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const token = signToken({ sub: "explorer-user" });
    const res = await fetch(`http://127.0.0.1:${addr.port}/explorer/tools/test.tool/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isError).toBe(false);
  });

  it("TC-AUTH-INT-018: Explorer GET routes are exempt even with custom exempt_paths", async () => {
    mgr = new TransportManager();
    const authenticator = new JWTAuthenticator({ secret: SECRET });
    mgr.setAuthenticator(authenticator);
    // Set custom exempt paths that do NOT include /explorer
    mgr.setExemptPaths(["/health", "/status"]);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    const router = createMockRouter();
    setupExplorer(mgr, router, { authenticator, allowExecute: true });

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    // Explorer GET routes should still be exempt because explorer is handled before auth
    const htmlRes = await fetch(`http://127.0.0.1:${addr.port}/explorer/`);
    expect(htmlRes.status).toBe(200);
    const text = await htmlRes.text();
    expect(text).toContain("MCP Tool Explorer");

    const toolsRes = await fetch(`http://127.0.0.1:${addr.port}/explorer/tools`);
    expect(toolsRes.status).toBe(200);

    const toolDetailRes = await fetch(`http://127.0.0.1:${addr.port}/explorer/tools/test.tool`);
    expect(toolDetailRes.status).toBe(200);

    // /status is in custom exempt paths, so GET /status should bypass auth
    // (returns 404 because no handler, but NOT 401)
    const statusRes = await fetch(`http://127.0.0.1:${addr.port}/status`);
    expect(statusRes.status).not.toBe(401);

    // POST /mcp should still require auth (not exempt)
    const mcpRes = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(mcpRes.status).toBe(401);
  });

  it("GET /explorer/tools extracts identity when valid token is present", async () => {
    mgr = new TransportManager();
    const authenticator = new JWTAuthenticator({ secret: SECRET });
    mgr.setAuthenticator(authenticator);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    const router = createMockRouter();
    setupExplorer(mgr, router, { authenticator, allowExecute: true });

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    // GET /explorer/tools with a valid token should succeed (exempt)
    const token = signToken({ sub: "viewer-user" });
    const res = await fetch(`http://127.0.0.1:${addr.port}/explorer/tools`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("GET /explorer/ works with invalid token (exempt, best-effort)", async () => {
    mgr = new TransportManager();
    const authenticator = new JWTAuthenticator({ secret: SECRET });
    mgr.setAuthenticator(authenticator);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    const router = createMockRouter();
    setupExplorer(mgr, router, { authenticator, allowExecute: true });

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    // GET with an invalid token on exempt path should still succeed (not 401)
    const res = await fetch(`http://127.0.0.1:${addr.port}/explorer/`, {
      headers: { Authorization: "Bearer bad.token.here" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("MCP Tool Explorer");
  });

  it("explorer call works without authenticator (no auth required)", async () => {
    mgr = new TransportManager();
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    const router = createMockRouter();
    setupExplorer(mgr, router, { allowExecute: true });

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/explorer/tools/test.tool/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// _isAuthExempt tests
// ---------------------------------------------------------------------------

describe("TransportManager._isAuthExempt", () => {
  it("exempts GET /health", () => {
    const mgr = new TransportManager();
    expect(mgr._isAuthExempt("/health", "GET")).toBe(true);
  });

  it("does not exempt POST /health", () => {
    const mgr = new TransportManager();
    expect(mgr._isAuthExempt("/health", "POST")).toBe(false);
  });

  it("exempts GET /metrics", () => {
    const mgr = new TransportManager();
    expect(mgr._isAuthExempt("/metrics", "GET")).toBe(true);
  });

  it("does not exempt /mcp", () => {
    const mgr = new TransportManager();
    expect(mgr._isAuthExempt("/mcp", "POST")).toBe(false);
  });

  it("exempts GET /explorer/ when explorer is set", () => {
    const mgr = new TransportManager();
    const noop = () => {};
    mgr.setExplorer(noop as never, "/explorer");

    expect(mgr._isAuthExempt("/explorer/", "GET")).toBe(true);
    expect(mgr._isAuthExempt("/explorer/tools", "GET")).toBe(true);
    expect(mgr._isAuthExempt("/explorer", "GET")).toBe(true);
  });

  it("does not exempt explorer GET when no explorer is set", () => {
    const mgr = new TransportManager();
    expect(mgr._isAuthExempt("/explorer/", "GET")).toBe(false);
  });

  it("uses custom exempt paths", () => {
    const mgr = new TransportManager();
    mgr.setExemptPaths(["/health", "/status", "/ready"]);

    expect(mgr._isAuthExempt("/health", "GET")).toBe(true);
    expect(mgr._isAuthExempt("/status", "GET")).toBe(true);
    expect(mgr._isAuthExempt("/ready", "GET")).toBe(true);
    expect(mgr._isAuthExempt("/metrics", "GET")).toBe(false); // removed from defaults
  });
});

// ---------------------------------------------------------------------------
// Permissive mode (requireAuth=false)
// ---------------------------------------------------------------------------

describe("Permissive mode (requireAuth=false)", () => {
  let mgr: TransportManager;

  afterEach(async () => {
    if (mgr) await mgr.close();
  });

  it("allows requests without token when requireAuth=false", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET, requireAuth: false }));
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    // Should NOT get 401 — permissive mode allows through
    expect(res.status).not.toBe(401);
  });

  it("still authenticates with valid token in permissive mode", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET, requireAuth: false }));
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const token = signToken({ sub: "user-1" });
    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Top-level requireAuth override (matches Python's serve(require_auth=...))
// ---------------------------------------------------------------------------

describe("Top-level requireAuth override via setRequireAuth()", () => {
  let mgr: TransportManager;

  afterEach(async () => {
    if (mgr) await mgr.close();
  });

  it("overrides authenticator's requireAuth=true with top-level false", async () => {
    mgr = new TransportManager();
    // Authenticator says requireAuth=true, but top-level override says false
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET, requireAuth: true }));
    mgr.setRequireAuth(false);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    // Request without token should NOT get 401 — top-level override wins
    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).not.toBe(401);
  });

  it("overrides authenticator's requireAuth=false with top-level true", async () => {
    mgr = new TransportManager();
    // Authenticator says requireAuth=false, but top-level override says true
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET, requireAuth: false }));
    mgr.setRequireAuth(true);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    // Request without token SHOULD get 401 — top-level override wins
    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Custom exempt paths integration
// ---------------------------------------------------------------------------

describe("Custom exempt paths integration", () => {
  let mgr: TransportManager;

  afterEach(async () => {
    if (mgr) await mgr.close();
  });

  it("custom exempt path bypasses auth", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET }));
    mgr.setExemptPaths(["/health", "/metrics", "/status"]);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    // /health still exempt
    const healthRes = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(healthRes.status).toBe(200);
  });
});

describe("/usage endpoint authentication", () => {
  let mgr: TransportManager;

  afterEach(async () => {
    if (mgr) await mgr.close();
  });

  const usageCollector = {
    getSummary: (period?: string) => ({ total_calls: 7, period }),
    getModule: (moduleId: string) => ({ module_id: moduleId, calls: 3 }),
  };

  it("returns 401 for GET /usage without a token", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET }));
    mgr.setUsageCollector(usageCollector);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/usage`);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("total_calls");
  });

  it("serves GET /usage with a valid token", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET }));
    mgr.setUsageCollector(usageCollector);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/usage`, {
      headers: { Authorization: `Bearer ${signToken({ sub: "user-1" })}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toEqual({ total_calls: 7, period: "24h" });
  });

  it("returns 401 for GET /usage without a token in SSE mode", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET }));
    mgr.setUsageCollector(usageCollector);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runSse(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/usage`);
    expect(res.status).toBe(401);
  });

  it("serves GET /usage unauthenticated once explicitly exempted", async () => {
    mgr = new TransportManager();
    mgr.setAuthenticator(new JWTAuthenticator({ secret: SECRET }));
    mgr.setUsageCollector(usageCollector);
    mgr.setExemptPaths(["/health", "/metrics", "/usage"]);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/usage`);
    expect(res.status).toBe(200);
  });

  it("serves GET /usage when no authenticator is configured", async () => {
    mgr = new TransportManager();
    mgr.setUsageCollector(usageCollector);
    vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});

    await mgr.runStreamableHttp(createMockServer(), { host: "127.0.0.1", port: 0 });
    const addr = mgr.httpServer!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/usage`);
    expect(res.status).toBe(200);
  });
});

describe("buildExplorerAuthHook requireAuth policy", () => {
  // Python (middleware.py:92) and Rust (middleware.rs:194) both let an
  // unauthenticated request through when require_auth is off; the hook used to
  // throw unconditionally, making permissive mode unreachable in TypeScript.
  const noHeaders = { headers: {} };
  const ok = () => Promise.resolve(new Response("ok"));

  it("proceeds with a null identity when the authenticator is permissive", async () => {
    const hook = buildExplorerAuthHook(
      new JWTAuthenticator({ secret: SECRET, requireAuth: false }),
    );

    let seen: unknown = "unset";
    const res = await hook(noHeaders, () => {
      seen = getCurrentIdentity();
      return ok();
    });

    expect(res.status).toBe(200);
    expect(seen).toBeNull();
  });

  it("still rejects unauthenticated requests by default", async () => {
    const hook = buildExplorerAuthHook(new JWTAuthenticator({ secret: SECRET }));

    await expect(hook(noHeaders, ok)).rejects.toThrow("Unauthorized");
  });

  it("still authenticates a valid token in permissive mode", async () => {
    const hook = buildExplorerAuthHook(
      new JWTAuthenticator({ secret: SECRET, requireAuth: false }),
    );

    let seen: { id?: string } | null = null;
    await hook(
      { headers: { authorization: `Bearer ${signToken({ sub: "user-9" })}` } },
      () => {
        seen = getCurrentIdentity() as { id?: string } | null;
        return ok();
      },
    );

    expect(seen).not.toBeNull();
    expect(seen!.id).toBe("user-9");
  });

  it("honours an explicit requireAuth override over the authenticator", async () => {
    const strict = buildExplorerAuthHook(
      new JWTAuthenticator({ secret: SECRET, requireAuth: false }),
      { requireAuth: true },
    );
    await expect(strict(noHeaders, ok)).rejects.toThrow("Unauthorized");

    const permissive = buildExplorerAuthHook(
      new JWTAuthenticator({ secret: SECRET, requireAuth: true }),
      { requireAuth: false },
    );
    await expect(permissive(noHeaders, ok)).resolves.toBeDefined();
  });
});
