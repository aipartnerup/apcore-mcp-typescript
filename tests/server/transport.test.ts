/**
 * Tests for TransportManager validation logic and HTTP transports.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { TransportManager } from "../../src/server/transport.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AddressInfo } from "node:net";

describe("TransportManager", () => {
  const manager = new TransportManager();

  describe("_validateHostPort", () => {
    it("accepts valid host and port", () => {
      expect(() => manager._validateHostPort("127.0.0.1", 8000)).not.toThrow();
    });

    it("accepts port 1 (minimum)", () => {
      expect(() => manager._validateHostPort("localhost", 1)).not.toThrow();
    });

    it("accepts port 65535 (maximum)", () => {
      expect(() =>
        manager._validateHostPort("localhost", 65535),
      ).not.toThrow();
    });

    it("rejects empty host", () => {
      expect(() => manager._validateHostPort("", 8000)).toThrow(
        "Host must be a non-empty string",
      );
    });

    it("rejects port 0", () => {
      expect(() => manager._validateHostPort("localhost", 0)).toThrow(
        "Port must be an integer between 1 and 65535",
      );
    });

    it("rejects port above 65535", () => {
      expect(() => manager._validateHostPort("localhost", 65536)).toThrow(
        "Port must be an integer between 1 and 65535",
      );
    });

    it("rejects negative port", () => {
      expect(() => manager._validateHostPort("localhost", -1)).toThrow(
        "Port must be an integer between 1 and 65535",
      );
    });

    it("rejects non-integer port", () => {
      expect(() => manager._validateHostPort("localhost", 8000.5)).toThrow(
        "Port must be an integer between 1 and 65535",
      );
    });
  });

  describe("runStreamableHttp", () => {
    let mgr: TransportManager;

    afterEach(async () => {
      if (mgr) await mgr.close();
    });

    it("connects transport to server and starts HTTP listener", async () => {
      mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      await mgr.runStreamableHttp(mockServer, {
        host: "127.0.0.1",
        port: 0,
      });

      expect(mockServer.connect).toHaveBeenCalledOnce();
      expect(mgr.httpServer).toBeDefined();
      expect(mgr.httpServer!.listening).toBe(true);
    });

    it("returns 404 for non-endpoint paths", async () => {
      mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      await mgr.runStreamableHttp(mockServer, {
        host: "127.0.0.1",
        port: 0,
      });

      const addr = mgr.httpServer!.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/nonexistent`);
      expect(res.status).toBe(404);
    });

    it("routes POST to /mcp endpoint to transport", async () => {
      mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      await mgr.runStreamableHttp(mockServer, {
        host: "127.0.0.1",
        port: 0,
      });

      const addr = mgr.httpServer!.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
        }),
      });
      // Should reach transport (not our 404)
      expect(res.status).not.toBe(404);
    });

    it("uses custom endpoint when specified", async () => {
      mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      await mgr.runStreamableHttp(mockServer, {
        host: "127.0.0.1",
        port: 0,
        endpoint: "/custom",
      });

      const addr = mgr.httpServer!.address() as AddressInfo;
      // Default /mcp should return 404
      const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`);
      expect(res.status).toBe(404);
    });

    it("returns 413 when request body exceeds size limit", async () => {
      mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      await mgr.runStreamableHttp(mockServer, {
        host: "127.0.0.1",
        port: 0,
      });

      const addr = mgr.httpServer!.address() as AddressInfo;
      // 5MB body exceeds the 4MB default limit
      const largeBody = "x".repeat(5 * 1024 * 1024);
      const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: largeBody,
      });
      expect(res.status).toBe(413);
    });
  });

  describe("runSse", () => {
    let mgr: TransportManager;

    afterEach(async () => {
      if (mgr) await mgr.close();
    });

    it("starts HTTP server and listens", async () => {
      mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      await mgr.runSse(mockServer, { host: "127.0.0.1", port: 0 });

      expect(mgr.httpServer).toBeDefined();
      expect(mgr.httpServer!.listening).toBe(true);
    });

    it("returns 404 for non-endpoint paths", async () => {
      mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      await mgr.runSse(mockServer, { host: "127.0.0.1", port: 0 });

      const addr = mgr.httpServer!.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/nonexistent`);
      expect(res.status).toBe(404);
    });

    it("POST to /messages without session returns 400", async () => {
      mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      await mgr.runSse(mockServer, { host: "127.0.0.1", port: 0 });

      const addr = mgr.httpServer!.address() as AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${addr.port}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "test", id: 1 }),
        },
      );
      expect(res.status).toBe(400);
    });

    it("uses custom endpoint when specified", async () => {
      mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      await mgr.runSse(mockServer, {
        host: "127.0.0.1",
        port: 0,
        endpoint: "/events",
      });

      const addr = mgr.httpServer!.address() as AddressInfo;
      // Default /sse should 404
      const res = await fetch(`http://127.0.0.1:${addr.port}/sse`);
      expect(res.status).toBe(404);
    });
  });

  describe("health endpoint (streamable-http)", () => {
    let mgr: TransportManager;

    afterEach(async () => {
      if (mgr) await mgr.close();
    });

    it("returns JSON with status, uptime_seconds, and module_count", async () => {
      mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      await mgr.runStreamableHttp(mockServer, {
        host: "127.0.0.1",
        port: 0,
      });

      const addr = mgr.httpServer!.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");

      const body = await res.json();
      expect(body).toHaveProperty("status", "ok");
      expect(body).toHaveProperty("uptime_seconds");
      expect(typeof body.uptime_seconds).toBe("number");
      expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
      expect(body).toHaveProperty("module_count");
      expect(typeof body.module_count).toBe("number");
    });

    it("reflects module_count set via setModuleCount()", async () => {
      mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      mgr.setModuleCount(42);

      await mgr.runStreamableHttp(mockServer, {
        host: "127.0.0.1",
        port: 0,
      });

      const addr = mgr.httpServer!.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
      const body = await res.json();
      expect(body.module_count).toBe(42);
    });
  });

  describe("health endpoint (sse)", () => {
    let mgr: TransportManager;

    afterEach(async () => {
      if (mgr) await mgr.close();
    });

    it("returns JSON with status, uptime_seconds, and module_count", async () => {
      mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      await mgr.runSse(mockServer, {
        host: "127.0.0.1",
        port: 0,
      });

      const addr = mgr.httpServer!.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");

      const body = await res.json();
      expect(body).toHaveProperty("status", "ok");
      expect(body).toHaveProperty("uptime_seconds");
      expect(typeof body.uptime_seconds).toBe("number");
      expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
      expect(body).toHaveProperty("module_count");
      expect(typeof body.module_count).toBe("number");
    });

    it("reflects module_count set via setModuleCount()", async () => {
      mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      mgr.setModuleCount(7);

      await mgr.runSse(mockServer, {
        host: "127.0.0.1",
        port: 0,
      });

      const addr = mgr.httpServer!.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
      const body = await res.json();
      expect(body.module_count).toBe(7);
    });
  });

  describe("[A-D-TR-2] runStdio async-task teardown", () => {
    it("mints a session id and cancels session tasks when the transport closes", async () => {
      const mgr = new TransportManager();
      const cancelSessionTasks = vi.fn().mockResolvedValue(0);
      mgr.setAsyncTaskBridge({ cancelSessionTasks });

      let connected: { onclose?: () => void } | undefined;
      const mockServer = {
        connect: vi.fn(async (transport: { onclose?: () => void }) => {
          connected = transport;
        }),
      } as unknown as Server;

      await mgr.runStdio(mockServer);

      expect(connected).toBeDefined();
      expect(connected!.onclose).toBeTypeOf("function");

      connected!.onclose!();

      // The set_async_task_bridge contract is not restricted to network
      // transports: Python honours it on stdio (transport.py:106-113), and the
      // SSE/streamable-http paths in this file already wire onclose.
      expect(cancelSessionTasks).toHaveBeenCalledTimes(1);
      const sessionId = cancelSessionTasks.mock.calls[0][0] as string;
      expect(typeof sessionId).toBe("string");
      expect(sessionId.length).toBeGreaterThan(0);
    });

    it("preserves a pre-existing onclose handler", async () => {
      const mgr = new TransportManager();
      const cancelSessionTasks = vi.fn().mockResolvedValue(0);
      mgr.setAsyncTaskBridge({ cancelSessionTasks });

      let connected: { onclose?: () => void } | undefined;
      const mockServer = {
        connect: vi.fn(async (transport: { onclose?: () => void }) => {
          connected = transport;
        }),
      } as unknown as Server;

      await mgr.runStdio(mockServer);

      const later = vi.fn();
      const wired = connected!.onclose!;
      connected!.onclose = () => {
        wired();
        later();
      };
      connected!.onclose!();

      expect(cancelSessionTasks).toHaveBeenCalledTimes(1);
      expect(later).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when no async task bridge is configured", async () => {
      const mgr = new TransportManager();
      let connected: { onclose?: () => void } | undefined;
      const mockServer = {
        connect: vi.fn(async (transport: { onclose?: () => void }) => {
          connected = transport;
        }),
      } as unknown as Server;

      await mgr.runStdio(mockServer);

      expect(() => connected!.onclose?.()).not.toThrow();
    });
  });

  describe("close", () => {
    it("closes the HTTP server", async () => {
      const mgr = new TransportManager();
      vi.spyOn(mgr, "_validateHostPort").mockImplementation(() => {});
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as Server;

      await mgr.runStreamableHttp(mockServer, {
        host: "127.0.0.1",
        port: 0,
      });
      expect(mgr.httpServer!.listening).toBe(true);

      await mgr.close();
      expect(mgr.httpServer!.listening).toBe(false);
    });

    it("is safe to call when no server is running", async () => {
      const mgr = new TransportManager();
      await expect(mgr.close()).resolves.toBeUndefined();
    });
  });
});
