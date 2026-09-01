/**
 * Integration-level tests (against the mocked factory/transport, matching
 * the pattern in tests/serve-features.test.ts) for:
 *
 * - aiperceivable/apcore-mcp#16 phase A: serve()/asyncServe() compute
 *   `ManagementSurfaces` from the registry and pass them to
 *   `factory.createServer()`.
 * - aiperceivable/apcore-mcp#15(b): serve()/asyncServe() call
 *   `executor.governanceState()` (when present) and print the startup
 *   warning via the ORIGINAL (unsuppressed) console.warn.
 * - registerResourceHandlers() is called with the router as its third arg.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Registry, Executor, ModuleDescriptor } from "../src/types.js";

const mockRunStdio = vi.fn().mockResolvedValue(undefined);
const mockBuildTools = vi.fn().mockReturnValue([]);
const mockCreateServer = vi.fn().mockReturnValue({});
const mockRegisterHandlers = vi.fn();
const mockRegisterResourceHandlers = vi.fn();

vi.mock("../src/server/transport.js", () => ({
  TransportManager: vi.fn().mockImplementation(() => ({
    runStdio: mockRunStdio,
    runStreamableHttp: vi.fn(),
    runSse: vi.fn(),
    setModuleCount: vi.fn(),
  })),
}));

vi.mock("../src/server/factory.js", () => ({
  MCPServerFactory: vi.fn().mockImplementation(() => ({
    createServer: mockCreateServer,
    buildTools: mockBuildTools,
    attachAsyncMetaTools: (tools: unknown[]) => tools,
    registerHandlers: mockRegisterHandlers,
    registerResourceHandlers: mockRegisterResourceHandlers,
  })),
}));

import { serve } from "../src/index.js";

function createDescriptor(moduleId: string): ModuleDescriptor {
  return {
    moduleId,
    description: `Description for ${moduleId}`,
    inputSchema: { type: "object", properties: {} },
    outputSchema: {},
    annotations: {
      readonly: false,
      destructive: false,
      idempotent: true,
      requiresApproval: false,
      openWorld: false,
      streaming: false,
    },
  };
}

function createMockRegistry(descriptors: Record<string, ModuleDescriptor>): Registry {
  return {
    list: vi.fn(() => Object.keys(descriptors)),
    getDefinition: (id: string) => descriptors[id] ?? null,
    on: vi.fn(),
  };
}

function createMockExecutor(
  registry: Registry,
  governanceState?: () => Record<string, unknown>,
): Executor {
  const executor: Executor & { governanceState?: () => Record<string, unknown> } = {
    registry,
    call: vi.fn().mockResolvedValue({ status: "ok" }),
  };
  if (governanceState) {
    executor.governanceState = governanceState;
  }
  return executor;
}

let originalWarn: typeof console.warn;

beforeEach(() => {
  originalWarn = console.warn;
  vi.clearAllMocks();
  mockRunStdio.mockResolvedValue(undefined);
  mockBuildTools.mockReturnValue([]);
  mockCreateServer.mockReturnValue({});
});

afterEach(() => {
  console.warn = originalWarn;
});

describe("serve() management surfaces (#16 phase A)", () => {
  it("passes a ManagementSurfaces object computed from the registry to factory.createServer", async () => {
    const registry = createMockRegistry({
      "system.health.summary": createDescriptor("system.health.summary"),
      "system.control.reload_module": createDescriptor("system.control.reload_module"),
      "text.analyze": createDescriptor("text.analyze"),
    });
    const executor = createMockExecutor(registry);

    await serve(executor, { transport: "stdio" });

    expect(mockCreateServer).toHaveBeenCalledTimes(1);
    const [, , managementSurfaces] = mockCreateServer.mock.calls[0];
    expect(managementSurfaces).toEqual({
      health: true,
      usage: false,
      manifest: false,
      control: true,
    });
  });

  it("passes all-false ManagementSurfaces when no system.* modules are registered", async () => {
    const registry = createMockRegistry({ "text.analyze": createDescriptor("text.analyze") });
    const executor = createMockExecutor(registry);

    await serve(executor, { transport: "stdio" });

    const [, , managementSurfaces] = mockCreateServer.mock.calls[0];
    expect(managementSurfaces).toEqual({
      health: false,
      usage: false,
      manifest: false,
      control: false,
    });
  });

  it("passes the router as the third argument to registerResourceHandlers", async () => {
    const registry = createMockRegistry({});
    const executor = createMockExecutor(registry);

    await serve(executor, { transport: "stdio" });

    expect(mockRegisterResourceHandlers).toHaveBeenCalledTimes(1);
    const [, passedRegistry, passedRouter] = mockRegisterResourceHandlers.mock.calls[0];
    expect(passedRegistry).toBe(registry);
    expect(passedRouter).toBeDefined();
    expect(typeof passedRouter.handleCall).toBe("function");
  });
});

describe("serve() unprotected-control-surface warning (#15(b))", () => {
  it("prints the warning via the original console.warn when governanceState().unprotectedControlSurface is true", async () => {
    const registry = createMockRegistry({});
    const executor = createMockExecutor(registry, () => ({
      controlModulesRegistered: true,
      readModulesRegistered: false,
      aclConfigured: false,
      builtinAclGateWired: false,
      approvalHandlerConfigured: false,
      builtinApprovalGateWired: false,
      policyStrict: false,
      allControlModulesRequireApproval: false,
      unprotectedControlSurface: true,
    }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await serve(executor, { transport: "stdio" });

    const banner = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .find((text) => /unprotected/i.test(text));
    expect(banner).toBeDefined();
    expect(banner).toContain("system.control");
    warnSpy.mockRestore();
  });

  it("does not print the warning when unprotectedControlSurface is false", async () => {
    const registry = createMockRegistry({});
    const executor = createMockExecutor(registry, () => ({
      controlModulesRegistered: true,
      readModulesRegistered: false,
      aclConfigured: true,
      builtinAclGateWired: true,
      approvalHandlerConfigured: true,
      builtinApprovalGateWired: true,
      policyStrict: false,
      allControlModulesRequireApproval: true,
      unprotectedControlSurface: false,
    }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await serve(executor, { transport: "stdio" });

    const banner = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .find((text) => /unprotected/i.test(text));
    expect(banner).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("never throws / blocks startup when the executor has no governanceState() at all", async () => {
    const registry = createMockRegistry({});
    const executor = createMockExecutor(registry); // no governanceState

    await expect(serve(executor, { transport: "stdio" })).resolves.toBeUndefined();
  });

  it("never throws / blocks startup when governanceState() itself throws", async () => {
    const registry = createMockRegistry({});
    const executor = createMockExecutor(registry, () => {
      throw new Error("boom");
    });

    await expect(serve(executor, { transport: "stdio" })).resolves.toBeUndefined();
  });
});
