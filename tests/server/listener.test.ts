import { describe, it, expect, vi } from "vitest";
import { RegistryListener } from "../../src/server/listener.js";
import { MCPServerFactory } from "../../src/server/factory.js";
import type { Registry, ModuleDescriptor } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDescriptor(
  overrides: Partial<ModuleDescriptor> = {},
): ModuleDescriptor {
  return {
    moduleId: overrides.moduleId ?? "test.module",
    description: overrides.description ?? "A test module",
    inputSchema: overrides.inputSchema ?? {
      type: "object",
      properties: {
        input: { type: "string" },
      },
      required: ["input"],
    },
    outputSchema: overrides.outputSchema ?? {
      type: "object",
      properties: {
        output: { type: "string" },
      },
    },
    annotations: overrides.annotations !== undefined
      ? overrides.annotations
      : null,
  };
}

function createMockRegistryWithCallbacks() {
  const callbacks: Record<string, Function[]> = {};
  const registry: Registry = {
    list: () => [],
    getDefinition: vi.fn().mockReturnValue(null),
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (!callbacks[event]) callbacks[event] = [];
      callbacks[event].push(cb);
    },
  };
  return { registry, callbacks };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RegistryListener", () => {
  // TC-LISTENER-001
  it("start() subscribes to registry 'register' and 'unregister' events", () => {
    const { registry, callbacks } = createMockRegistryWithCallbacks();
    const factory = new MCPServerFactory();
    const listener = new RegistryListener(registry, factory);

    listener.start();

    expect(callbacks["register"]).toBeDefined();
    expect(callbacks["register"]).toHaveLength(1);
    expect(callbacks["unregister"]).toBeDefined();
    expect(callbacks["unregister"]).toHaveLength(1);
  });

  // TC-LISTENER-002
  it("start() is idempotent - calling twice does not double-subscribe", () => {
    const { registry, callbacks } = createMockRegistryWithCallbacks();
    const factory = new MCPServerFactory();
    const listener = new RegistryListener(registry, factory);

    listener.start();
    listener.start();

    expect(callbacks["register"]).toHaveLength(1);
    expect(callbacks["unregister"]).toHaveLength(1);
  });

  // TC-LISTENER-003
  it("stop() prevents event handling - callbacks become no-ops", () => {
    const descriptor = makeDescriptor({ moduleId: "mod.stopped" });
    const { registry, callbacks } = createMockRegistryWithCallbacks();
    (registry.getDefinition as ReturnType<typeof vi.fn>).mockReturnValue(
      descriptor,
    );
    const factory = new MCPServerFactory();
    const listener = new RegistryListener(registry, factory);

    listener.start();
    listener.stop();

    // Simulate a register event after stop
    const registerCb = callbacks["register"][0];
    registerCb("mod.stopped");

    // The tool should NOT have been added because the listener is stopped
    expect(listener.tools.size).toBe(0);
  });

  // TC-LISTENER-004
  it("_onRegister adds tool to internal tools map", () => {
    const descriptor = makeDescriptor({ moduleId: "mod.new" });
    const { registry, callbacks } = createMockRegistryWithCallbacks();
    (registry.getDefinition as ReturnType<typeof vi.fn>).mockReturnValue(
      descriptor,
    );
    const factory = new MCPServerFactory();
    const listener = new RegistryListener(registry, factory);
    listener.start(); // [D11-001] _onRegister requires _active = true

    // Suppress console.log for the registration message
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    listener._onRegister("mod.new");

    expect(listener.tools.has("mod.new")).toBe(true);
    const tool = listener.tools.get("mod.new");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("mod.new");

    logSpy.mockRestore();
  });

  // TC-LISTENER-005
  it("_onRegister skips null definition and logs a warning", () => {
    const { registry } = createMockRegistryWithCallbacks();
    // getDefinition already mocked to return null by default
    const factory = new MCPServerFactory();
    const listener = new RegistryListener(registry, factory);
    listener.start(); // [D11-001] _onRegister requires _active = true

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    listener._onRegister("mod.missing");

    expect(listener.tools.has("mod.missing")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("mod.missing"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("definition is null"),
    );

    warnSpy.mockRestore();
  });

  // TC-LISTENER-006
  it("_onUnregister removes tool from internal tools map", () => {
    const descriptor = makeDescriptor({ moduleId: "mod.removable" });
    const { registry } = createMockRegistryWithCallbacks();
    (registry.getDefinition as ReturnType<typeof vi.fn>).mockReturnValue(
      descriptor,
    );
    const factory = new MCPServerFactory();
    const listener = new RegistryListener(registry, factory);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // [A-D-011] _onUnregister now gates on `_active` (Python+Rust parity).
    // Direct invocation requires start() to set the flag first.
    listener.start();

    // First register the tool
    listener._onRegister("mod.removable");
    expect(listener.tools.has("mod.removable")).toBe(true);

    // Now unregister it
    listener._onUnregister("mod.removable");
    expect(listener.tools.has("mod.removable")).toBe(false);

    logSpy.mockRestore();
  });

  // TC-LISTENER-EVENT-REGISTER: Register callback triggered via event system
  it("register callback triggered via registry events adds the tool", () => {
    const descriptor = makeDescriptor({ moduleId: "evented.module" });
    const { registry, callbacks } = createMockRegistryWithCallbacks();
    (registry.getDefinition as ReturnType<typeof vi.fn>).mockReturnValue(
      descriptor,
    );
    const factory = new MCPServerFactory();
    const listener = new RegistryListener(registry, factory);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    listener.start();

    // Trigger the register callback via the event system
    const registerCb = callbacks["register"][0];
    registerCb("evented.module");

    expect(listener.tools.has("evented.module")).toBe(true);
    logSpy.mockRestore();
  });

  // TC-LISTENER-EVENT-UNREGISTER: Unregister callback triggered via event system
  it("unregister callback triggered via registry events removes the tool", () => {
    const descriptor = makeDescriptor({ moduleId: "evented.remove" });
    const { registry, callbacks } = createMockRegistryWithCallbacks();
    (registry.getDefinition as ReturnType<typeof vi.fn>).mockReturnValue(
      descriptor,
    );
    const factory = new MCPServerFactory();
    const listener = new RegistryListener(registry, factory);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    listener.start();

    // Register first
    callbacks["register"][0]("evented.remove");
    expect(listener.tools.has("evented.remove")).toBe(true);

    // Trigger unregister via event
    callbacks["unregister"][0]("evented.remove");
    expect(listener.tools.has("evented.remove")).toBe(false);

    logSpy.mockRestore();
  });

  // TC-LISTENER-007
  it("tools getter returns a snapshot copy - modifying it does not affect internal state", () => {
    const descriptor = makeDescriptor({ moduleId: "mod.snapshot" });
    const { registry } = createMockRegistryWithCallbacks();
    (registry.getDefinition as ReturnType<typeof vi.fn>).mockReturnValue(
      descriptor,
    );
    const factory = new MCPServerFactory();
    const listener = new RegistryListener(registry, factory);
    listener.start(); // [D11-001] _onRegister requires _active = true

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    listener._onRegister("mod.snapshot");

    // Get a snapshot and modify it
    const snapshot = listener.tools;
    snapshot.delete("mod.snapshot");
    snapshot.set("mod.injected", { name: "injected" } as any);

    // Internal state should be unaffected
    const freshSnapshot = listener.tools;
    expect(freshSnapshot.has("mod.snapshot")).toBe(true);
    expect(freshSnapshot.has("mod.injected")).toBe(false);

    logSpy.mockRestore();
  });
});

// D11-001: _onRegister must respect the _active guard after stop()
describe("D11-001: _onRegister _active guard", () => {
  it("_onRegister does NOT register tool after stop() is called", () => {
    const { registry, callbacks } = createMockRegistryWithCallbacks();
    const factory = new MCPServerFactory();
    const listener = new RegistryListener(registry, factory);

    // Give registry a module to define
    (registry.getDefinition as ReturnType<typeof vi.fn>).mockReturnValue(
      makeDescriptor({ moduleId: "test.module" }),
    );

    listener.start();
    listener.stop();

    // Directly invoke _onRegister after stop() — should be a no-op
    listener._onRegister("test.module");

    // The tool should NOT have been registered
    expect(listener.tools.size).toBe(0);
  });

  it("_onRegister registers tool when _active (before stop)", () => {
    const { registry } = createMockRegistryWithCallbacks();
    const factory = new MCPServerFactory();
    const listener = new RegistryListener(registry, factory);

    (registry.getDefinition as ReturnType<typeof vi.fn>).mockReturnValue(
      makeDescriptor({ moduleId: "test.module" }),
    );

    listener.start();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    listener._onRegister("test.module");
    logSpy.mockRestore();

    expect(listener.tools.size).toBe(1);
    expect(listener.tools.has("test.module")).toBe(true);
  });
});

describe("[A-D-RL-5] listener never logs to stdout", () => {
  // The MCP stdio transport frames JSON-RPC on process.stdout
  // (@modelcontextprotocol/sdk server/stdio.js writes JSON there), so every
  // listener message must go to stderr. Asserting on console.log/console.error
  // rather than on process.stdout.write is deliberate: vitest intercepts console
  // output, so a process.stdout.write spy never observes console.log at all.
  it("_onRegister logs the success message to stderr, not stdout", () => {
    const { registry } = createMockRegistryWithCallbacks();
    (registry.getDefinition as ReturnType<typeof vi.fn>).mockReturnValue(
      makeDescriptor({ moduleId: "mod.stdout" }),
    );
    const listener = new RegistryListener(registry, new MCPServerFactory());
    listener.start();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    listener._onRegister("mod.stdout");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("mod.stdout"));
    expect(listener.tools.has("mod.stdout")).toBe(true);

    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("_onUnregister logs the removal message to stderr, not stdout", () => {
    const { registry } = createMockRegistryWithCallbacks();
    (registry.getDefinition as ReturnType<typeof vi.fn>).mockReturnValue(
      makeDescriptor({ moduleId: "mod.stdout" }),
    );
    const listener = new RegistryListener(registry, new MCPServerFactory());
    listener.start();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    listener._onRegister("mod.stdout");
    errSpy.mockClear();
    listener._onUnregister("mod.stdout");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("mod.stdout"));
    expect(listener.tools.has("mod.stdout")).toBe(false);

    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});
