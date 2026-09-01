import { describe, it, expect, vi } from "vitest";
import { MCPServerFactory } from "../../src/server/factory.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ModuleDescriptor, Registry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRegistry(
  descriptors: Record<string, ModuleDescriptor>,
): Registry {
  return {
    list: (opts?: { tags?: string[] | null; prefix?: string | null }) =>
      Object.keys(descriptors),
    getDefinition: (id: string) => descriptors[id] ?? null,
    on: () => {},
  };
}

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
    documentation: overrides.documentation !== undefined
      ? overrides.documentation
      : undefined,
    metadata: overrides.metadata,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCPServerFactory", () => {
  const factory = new MCPServerFactory();

  // TC-FACTORY-001
  it("createServer returns a Server with a connect method", () => {
    const server = factory.createServer("test-server", "1.0.0");

    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });

  // [D10-002] Cross-language parity: spec mandates non-empty, max 255 chars.
  // Python (apcore_mcp/server/factory.py) and Rust both throw on violation.
  it("D10-002: createServer throws on empty name", () => {
    expect(() => factory.createServer("", "1.0.0")).toThrow();
  });

  it("D10-002: createServer throws when name exceeds 255 chars", () => {
    expect(() => factory.createServer("x".repeat(256), "1.0.0")).toThrow();
  });

  it("D10-002: createServer accepts a 255-char name", () => {
    const server = factory.createServer("x".repeat(255), "1.0.0");
    expect(server).toBeDefined();
  });

  // TC-FACTORY-002
  it("buildTool creates a correct Tool with name, description, inputSchema, and annotations", () => {
    const descriptor = makeDescriptor({
      moduleId: "text.analyze",
      description: "Analyze text content",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
      annotations: {
        readonly: true,
        destructive: false,
        idempotent: true,
        requiresApproval: false,
        openWorld: false,
      },
    });

    const tool = factory.buildTool(descriptor);

    expect(tool.name).toBe("text.analyze");
    expect(tool.description).toBe("Analyze text content");
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.annotations).toBeDefined();
  });

  // TC-FACTORY-003
  it("buildTool maps annotations correctly to MCP hint format", () => {
    const descriptor = makeDescriptor({
      annotations: {
        readonly: true,
        destructive: false,
        idempotent: true,
        requiresApproval: false,
        openWorld: true,
      },
    });

    const tool = factory.buildTool(descriptor);

    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  // TC-FACTORY-004
  it("buildTool with null annotations uses defaults", () => {
    const descriptor = makeDescriptor({ annotations: null });

    const tool = factory.buildTool(descriptor);

    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  // TC-FACTORY-005
  it("buildTools iterates registry and returns correct number of tools", () => {
    const registry = createMockRegistry({
      "mod.a": makeDescriptor({ moduleId: "mod.a", description: "Module A" }),
      "mod.b": makeDescriptor({ moduleId: "mod.b", description: "Module B" }),
      "mod.c": makeDescriptor({ moduleId: "mod.c", description: "Module C" }),
    });

    const tools = factory.buildTools(registry);

    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toContain("mod.a");
    expect(names).toContain("mod.b");
    expect(names).toContain("mod.c");
  });

  // TC-FACTORY-006
  it("buildTools skips null definitions and logs a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const descriptors: Record<string, ModuleDescriptor> = {
      "mod.a": makeDescriptor({ moduleId: "mod.a" }),
    };

    // Create a registry where one module returns null
    const registry: Registry = {
      list: () => ["mod.a", "mod.missing"],
      getDefinition: (id: string) => descriptors[id] ?? null,
      on: () => {},
    };

    const tools = factory.buildTools(registry);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("mod.a");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("mod.missing"),
    );

    warnSpy.mockRestore();
  });

  // TC-FACTORY-007
  it("buildTools skips modules that throw errors and logs a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const registry: Registry = {
      list: () => ["mod.ok", "mod.broken"],
      getDefinition: (id: string) => {
        if (id === "mod.broken") {
          throw new Error("Descriptor retrieval failed");
        }
        return makeDescriptor({ moduleId: "mod.ok" });
      },
      on: () => {},
    };

    const tools = factory.buildTools(registry);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("mod.ok");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("mod.broken"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Descriptor retrieval failed"),
    );

    warnSpy.mockRestore();
  });

  // TC-FACTORY-HANDLERS: registerHandlers registers list_tools and call_tool
  describe("registerHandlers", () => {
    it("registers handlers that return tools on list and route calls", async () => {
      const descriptor = makeDescriptor({
        moduleId: "test.handler",
        description: "Handler test",
      });
      const tools = [factory.buildTool(descriptor)];

      // Create a mock server that captures handlers using a Map keyed by schema object
      const handlers = new Map<unknown, Function>();
      const mockServer = {
        setRequestHandler: (schema: unknown, handler: Function) => {
          handlers.set(schema, handler);
        },
      };

      // Create a mock router
      const mockRouter = {
        handleCall: vi.fn().mockResolvedValue([
          [{ type: "text", text: '{"result":"ok"}' }],
          false,
          "trace-abc",
        ]),
      };

      factory.registerHandlers(mockServer as any, tools, mockRouter as any);

      // Test tools/list handler
      const listHandler = handlers.get(ListToolsRequestSchema);
      expect(listHandler).toBeDefined();
      const listResult = await listHandler!({});
      expect(listResult.tools).toHaveLength(1);
      expect(listResult.tools[0].name).toBe("test.handler");

      // Test tools/call handler - success path
      const callHandler = handlers.get(CallToolRequestSchema);
      expect(callHandler).toBeDefined();
      const callResult = await callHandler!({
        params: { name: "test.handler", arguments: { input: "hello" } },
      });
      expect(callResult.content).toEqual([
        { type: "text", text: '{"result":"ok"}' },
      ]);
      // Success path: isError should not be set
      expect(callResult.isError).toBeUndefined();
    });

    it("throws error when router returns isError=true so MCP SDK sets isError", async () => {
      const tools = [factory.buildTool(makeDescriptor())];

      const handlers = new Map<unknown, Function>();
      const mockServer = {
        setRequestHandler: (schema: unknown, handler: Function) => {
          handlers.set(schema, handler);
        },
      };

      const mockRouter = {
        handleCall: vi.fn().mockResolvedValue([
          [{ type: "text", text: "Module not found" }],
          true,
          undefined,
        ]),
      };

      factory.registerHandlers(mockServer as any, tools, mockRouter as any);

      const callHandler = handlers.get(CallToolRequestSchema)!;
      await expect(
        callHandler({
          params: { name: "bad.module", arguments: {} },
        }),
      ).rejects.toThrow("Module not found");
    });

    it("handles null arguments in tools/call", async () => {
      const tools = [factory.buildTool(makeDescriptor())];

      const handlers = new Map<unknown, Function>();
      const mockServer = {
        setRequestHandler: (schema: unknown, handler: Function) => {
          handlers.set(schema, handler);
        },
      };

      const mockRouter = {
        handleCall: vi.fn().mockResolvedValue([
          [{ type: "text", text: "{}" }],
          false,
          undefined,
        ]),
      };

      factory.registerHandlers(mockServer as any, tools, mockRouter as any);

      // Call with null arguments
      const callHandler = handlers.get(CallToolRequestSchema)!;
      await callHandler({
        params: { name: "test.module", arguments: null },
      });

      expect(mockRouter.handleCall).toHaveBeenCalledWith(
        "test.module",
        {},
        expect.objectContaining({ sendNotification: undefined, _meta: undefined }),
      );
    });
  });

  // TC-FACTORY-DISPLAY-001: MCP alias used as tool name when present
  it("uses MCP display alias as tool name when present", () => {
    const descriptor = makeDescriptor({
      moduleId: "original.id",
      description: "Original description",
      metadata: {
        display: {
          mcp: {
            alias: "custom_alias",
          },
        },
      },
    });

    const tool = factory.buildTool(descriptor);

    expect(tool.name).toBe("custom_alias");
  });

  // TC-FACTORY-DISPLAY-002: MCP description used when present
  it("uses MCP display description when present", () => {
    const descriptor = makeDescriptor({
      moduleId: "test.display",
      description: "Original description",
      metadata: {
        display: {
          mcp: {
            description: "Custom MCP description",
          },
        },
      },
    });

    const tool = factory.buildTool(descriptor);

    expect(tool.description).toBe("Custom MCP description");
  });

  // TC-FACTORY-DISPLAY-003: Guidance appended to description when present
  it("appends guidance to description when present in MCP display", () => {
    const descriptor = makeDescriptor({
      moduleId: "test.guidance",
      description: "Base description",
      metadata: {
        display: {
          mcp: {
            guidance: "Use this tool for X, not Y",
          },
        },
      },
    });

    const tool = factory.buildTool(descriptor);

    expect(tool.description).toBe("Base description\n\nGuidance: Use this tool for X, not Y");
  });

  // TC-FACTORY-DISPLAY-004: Fallback to descriptor values when no overlay
  it("falls back to descriptor values when no display overlay present", () => {
    const descriptor = makeDescriptor({
      moduleId: "test.fallback",
      description: "Fallback description",
    });

    const tool = factory.buildTool(descriptor);

    expect(tool.name).toBe("test.fallback");
    expect(tool.description).toBe("Fallback description");
  });

  // TC-FACTORY-DISPLAY-005: All display overlay fields together
  it("applies alias, description, and guidance together", () => {
    const descriptor = makeDescriptor({
      moduleId: "original.name",
      description: "Original desc",
      metadata: {
        display: {
          mcp: {
            alias: "better_name",
            description: "Better description",
            guidance: "Always provide the id field",
          },
        },
      },
    });

    const tool = factory.buildTool(descriptor);

    expect(tool.name).toBe("better_name");
    expect(tool.description).toBe("Better description\n\nGuidance: Always provide the id field");
  });

  // TC-FACTORY-DISPLAY-006: Empty display.mcp falls back to descriptor
  it("falls back to descriptor when display.mcp is empty object", () => {
    const descriptor = makeDescriptor({
      moduleId: "test.empty.mcp",
      description: "Original",
      metadata: {
        display: {
          mcp: {},
        },
      },
    });

    const tool = factory.buildTool(descriptor);

    expect(tool.name).toBe("test.empty.mcp");
    expect(tool.description).toBe("Original");
  });

  // TC-FACTORY-AI-INTENT-001: AI intent metadata appended to description
  it("appends AI intent metadata to tool description", () => {
    const descriptor = makeDescriptor({
      moduleId: "test.intent",
      description: "A test module",
      metadata: {
        "x-when-to-use": "When you need to test things",
        "x-when-not-to-use": "When testing is not needed",
        "x-common-mistakes": "Forgetting to pass arguments",
        "x-workflow-hints": "Run after setup",
      },
    });

    const tool = factory.buildTool(descriptor);

    expect(tool.description).toContain("A test module");
    expect(tool.description).toContain("When To Use: When you need to test things");
    expect(tool.description).toContain("When Not To Use: When testing is not needed");
    expect(tool.description).toContain("Common Mistakes: Forgetting to pass arguments");
    expect(tool.description).toContain("Workflow Hints: Run after setup");
  });

  // TC-FACTORY-AI-INTENT-002: no metadata -> description unchanged
  it("leaves description unchanged when no AI intent metadata present", () => {
    const descriptor = makeDescriptor({
      moduleId: "test.plain",
      description: "A plain module",
    });

    const tool = factory.buildTool(descriptor);

    expect(tool.description).toBe("A plain module");
  });

  // TC-FACTORY-AI-INTENT-003: partial metadata
  it("appends only present AI intent keys", () => {
    const descriptor = makeDescriptor({
      moduleId: "test.partial",
      description: "Partial test",
      metadata: {
        "x-when-to-use": "When needed",
        "other-key": "ignored",
      },
    });

    const tool = factory.buildTool(descriptor);

    expect(tool.description).toContain("When To Use: When needed");
    expect(tool.description).not.toContain("other-key");
    expect(tool.description).not.toContain("When Not To Use");
  });

  // TC-FACTORY-AI-INTENT-004: non-string metadata values are ignored
  it("ignores non-string AI intent metadata values", () => {
    const descriptor = makeDescriptor({
      moduleId: "test.nonstring",
      description: "Base description",
      metadata: {
        "x-when-to-use": 42,
        "x-common-mistakes": null,
      },
    });

    const tool = factory.buildTool(descriptor);

    expect(tool.description).toBe("Base description");
  });

  // TC-FACTORY-008
  it("buildTools with empty registry returns an empty array", () => {
    const registry = createMockRegistry({});

    const tools = factory.buildTools(registry);

    expect(tools).toEqual([]);
  });

  // TC-FACTORY-RESOURCES: registerResourceHandlers
  describe("registerResourceHandlers", () => {
    it("includes modules with documentation in resource list", async () => {
      const registry = createMockRegistry({
        "mod.documented": makeDescriptor({
          moduleId: "mod.documented",
          documentation: "Some docs",
        }),
      });

      const handlers = new Map<unknown, Function>();
      const mockServer = {
        setRequestHandler: (schema: unknown, handler: Function) => {
          handlers.set(schema, handler);
        },
      };

      factory.registerResourceHandlers(mockServer as any, registry);

      const listHandler = handlers.get(ListResourcesRequestSchema);
      expect(listHandler).toBeDefined();
      const listResult = await listHandler!({});
      expect(listResult.resources).toHaveLength(1);
      expect(listResult.resources[0].uri).toBe("docs://mod.documented");
      expect(listResult.resources[0].name).toBe("mod.documented documentation");
      expect(listResult.resources[0].mimeType).toBe("text/plain");
    });

    it("excludes modules with null documentation from resource list", async () => {
      const registry = createMockRegistry({
        "mod.nodocs": makeDescriptor({
          moduleId: "mod.nodocs",
          documentation: null,
        }),
      });

      const handlers = new Map<unknown, Function>();
      const mockServer = {
        setRequestHandler: (schema: unknown, handler: Function) => {
          handlers.set(schema, handler);
        },
      };

      factory.registerResourceHandlers(mockServer as any, registry);

      const listHandler = handlers.get(ListResourcesRequestSchema);
      expect(listHandler).toBeDefined();
      const listResult = await listHandler!({});
      expect(listResult.resources).toHaveLength(0);
    });

    it("excludes modules without documentation field from resource list", async () => {
      const registry = createMockRegistry({
        "mod.plain": makeDescriptor({
          moduleId: "mod.plain",
        }),
      });

      const handlers = new Map<unknown, Function>();
      const mockServer = {
        setRequestHandler: (schema: unknown, handler: Function) => {
          handlers.set(schema, handler);
        },
      };

      factory.registerResourceHandlers(mockServer as any, registry);

      const listHandler = handlers.get(ListResourcesRequestSchema);
      const listResult = await listHandler!({});
      expect(listResult.resources).toHaveLength(0);
    });

    it("returns documentation text for valid resource read", async () => {
      const registry = createMockRegistry({
        "mod.documented": makeDescriptor({
          moduleId: "mod.documented",
          documentation: "Some docs about this module",
        }),
      });

      const handlers = new Map<unknown, Function>();
      const mockServer = {
        setRequestHandler: (schema: unknown, handler: Function) => {
          handlers.set(schema, handler);
        },
      };

      factory.registerResourceHandlers(mockServer as any, registry);

      const readHandler = handlers.get(ReadResourceRequestSchema);
      expect(readHandler).toBeDefined();
      const readResult = await readHandler!({
        params: { uri: "docs://mod.documented" },
      });
      expect(readResult.contents).toHaveLength(1);
      expect(readResult.contents[0].uri).toBe("docs://mod.documented");
      expect(readResult.contents[0].text).toBe("Some docs about this module");
      expect(readResult.contents[0].mimeType).toBe("text/plain");
    });

    it("throws error for unknown module in resource read", async () => {
      const registry = createMockRegistry({});

      const handlers = new Map<unknown, Function>();
      const mockServer = {
        setRequestHandler: (schema: unknown, handler: Function) => {
          handlers.set(schema, handler);
        },
      };

      factory.registerResourceHandlers(mockServer as any, registry);

      const readHandler = handlers.get(ReadResourceRequestSchema)!;
      await expect(
        readHandler({
          params: { uri: "docs://mod.unknown" },
        }),
      ).rejects.toThrow("Resource not found: docs://mod.unknown");
    });
  });
});

// D11-014: registerHandlers should accept optional asyncTaskBridge parameter
describe("D11-014: registerHandlers asyncTaskBridge parameter", () => {
  it("adds meta-tools to the tools list when asyncTaskBridge is provided", async () => {
    const factory = new MCPServerFactory();

    const handlers = new Map<unknown, Function>();
    const mockServer = {
      setRequestHandler: (schema: unknown, handler: Function) => {
        handlers.set(schema, handler);
      },
    };

    const mockBridge = {
      enabled: true,
      buildMetaTools: vi.fn().mockReturnValue([
        {
          name: "__apcore_task_submit",
          description: "Submit async task",
          inputSchema: { type: "object" },
        },
      ]),
      handleMetaTool: vi.fn().mockResolvedValue({ task_id: "t1", status: "pending" }),
    };

    const tools: any[] = [];
    factory.registerHandlers(mockServer as any, tools, {} as any, {
      asyncTaskBridge: mockBridge as any,
    });

    const listHandler = handlers.get(ListToolsRequestSchema)!;
    const result = await listHandler({});
    // Meta-tools should be appended
    expect(result.tools.some((t: any) => t.name === "__apcore_task_submit")).toBe(true);
    expect(mockBridge.buildMetaTools).toHaveBeenCalled();
  });

  it("works without asyncTaskBridge (backward compat)", async () => {
    const factory = new MCPServerFactory();

    const handlers = new Map<unknown, Function>();
    const mockServer = {
      setRequestHandler: (schema: unknown, handler: Function) => {
        handlers.set(schema, handler);
      },
    };

    const tools: any[] = [{ name: "my.tool", description: "d", inputSchema: {} }];
    factory.registerHandlers(mockServer as any, tools, {} as any);

    const listHandler = handlers.get(ListToolsRequestSchema)!;
    const result = await listHandler({});
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("my.tool");
  });
});

// apcore-toolkit 0.6+: rich Markdown tool descriptions
describe("MCPServerFactory richDescription", () => {
  it("renders Markdown via apcore-toolkit when prepared", async () => {
    const primed = await MCPServerFactory.prepare();
    if (!primed) return; // toolkit not installed — skip
    const factory = new MCPServerFactory({ richDescription: true });
    const tool = factory.buildTool(
      makeDescriptor({
        moduleId: "image.resize",
        description: "Resize an image",
      }),
    );
    expect(tool.description).toMatch(/^# /);
    expect(tool.description).toContain("Resize an image");
    expect(tool.description).toContain("## Parameters");
  });

  it("display.mcp.description override wins over richDescription", async () => {
    const primed = await MCPServerFactory.prepare();
    if (!primed) return;
    const factory = new MCPServerFactory({ richDescription: true });
    const descriptor = makeDescriptor({
      moduleId: "image.resize",
      description: "Resize an image",
      metadata: {
        display: { mcp: { description: "Operator override — keep verbatim" } },
      },
    });
    const tool = factory.buildTool(descriptor);
    expect(tool.description).toBe("Operator override — keep verbatim");
  });

  it("falls back to plain description when richDescription is off", () => {
    const factory = new MCPServerFactory();
    const descriptor = makeDescriptor({ description: "Plain text" });
    const tool = factory.buildTool(descriptor);
    expect(tool.description).toBe("Plain text");
  });
});

// ---------------------------------------------------------------------------
// aiperceivable/apcore-mcp#15(a) / apcore-mcp-typescript#9: system.* modules
// are projected as resources (read) / tools (write), not all as tools.
// ---------------------------------------------------------------------------

describe("buildTools() excludes read-only system.* management modules", () => {
  const factory = new MCPServerFactory();

  it("excludes system.health.*, system.usage.*, system.manifest.* but keeps system.control.*", () => {
    const registry = createMockRegistry({
      "system.health.summary": makeDescriptor({ moduleId: "system.health.summary" }),
      "system.health.module": makeDescriptor({ moduleId: "system.health.module" }),
      "system.usage.summary": makeDescriptor({ moduleId: "system.usage.summary" }),
      "system.usage.module": makeDescriptor({ moduleId: "system.usage.module" }),
      "system.manifest.full": makeDescriptor({ moduleId: "system.manifest.full" }),
      "system.manifest.module": makeDescriptor({ moduleId: "system.manifest.module" }),
      "system.control.update_config": makeDescriptor({ moduleId: "system.control.update_config" }),
      "system.control.reload_module": makeDescriptor({ moduleId: "system.control.reload_module" }),
      "system.control.toggle_feature": makeDescriptor({ moduleId: "system.control.toggle_feature" }),
      "text.analyze": makeDescriptor({ moduleId: "text.analyze" }),
    });

    const tools = factory.buildTools(registry);
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        "system.control.update_config",
        "system.control.reload_module",
        "system.control.toggle_feature",
        "text.analyze",
      ].sort(),
    );
  });

  it("with sys_modules disabled (nothing registered), tools/list has no system.* at all", () => {
    const registry = createMockRegistry({
      "text.analyze": makeDescriptor({ moduleId: "text.analyze" }),
    });
    const tools = factory.buildTools(registry);
    expect(tools.map((t) => t.name)).toEqual(["text.analyze"]);
  });
});

// ---------------------------------------------------------------------------
// aiperceivable/apcore-mcp#16 phase A: com.aiperceivable/management extension
// ---------------------------------------------------------------------------

describe("createServer() management extension capability", () => {
  const factory = new MCPServerFactory();

  it("advertises no extensions field when managementSurfaces is omitted", () => {
    const server = factory.createServer("test", "1.0.0");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = (server as any).getCapabilities?.() ?? (server as any)._capabilities;
    expect(caps.extensions).toBeUndefined();
  });

  it("advertises no extensions field when all surfaces are false", () => {
    const server = factory.createServer("test", "1.0.0", {
      health: false,
      usage: false,
      manifest: false,
      control: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = (server as any).getCapabilities?.() ?? (server as any)._capabilities;
    expect(caps.extensions).toBeUndefined();
  });

  it("advertises com.aiperceivable/management with only the true surfaces listed", () => {
    const server = factory.createServer("test", "1.0.0", {
      health: true,
      usage: false,
      manifest: true,
      control: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = (server as any).getCapabilities?.() ?? (server as any)._capabilities;
    expect(caps.extensions).toBeDefined();
    const ext = caps.extensions["com.aiperceivable/management"];
    expect(ext.surfaces).toEqual(["health", "manifest"]);
    expect(typeof ext.protocolVersion).toBe("string");
    expect(ext.protocolVersion.length).toBeGreaterThan(0);
  });

  it("advertises all four surfaces when all are true", () => {
    const server = factory.createServer("test", "1.0.0", {
      health: true,
      usage: true,
      manifest: true,
      control: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = (server as any).getCapabilities?.() ?? (server as any)._capabilities;
    expect(caps.extensions["com.aiperceivable/management"].surfaces).toEqual([
      "health",
      "usage",
      "manifest",
      "control",
    ]);
  });

  it("still sets tools/resources capabilities unchanged regardless of managementSurfaces", () => {
    const server = factory.createServer("test", "1.0.0", { health: true, usage: false, manifest: false, control: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = (server as any).getCapabilities?.() ?? (server as any)._capabilities;
    expect(caps.tools).toEqual({ listChanged: true });
    expect(caps.resources).toEqual({ listChanged: true });
  });
});

// ---------------------------------------------------------------------------
// aiperceivable/apcore-mcp-typescript#9: registerResourceHandlers() serves
// the system.* management surface as resources/resource-templates, dispatched
// through the ExecutionRouter (never bypassing ACL/approval/audit).
// ---------------------------------------------------------------------------

describe("registerResourceHandlers() system.* management surface", () => {
  function setup(registeredModuleIds: string[]) {
    const descriptors: Record<string, ModuleDescriptor> = {};
    for (const id of registeredModuleIds) {
      descriptors[id] = makeDescriptor({ moduleId: id });
    }
    const registry = createMockRegistry(descriptors);

    const handlers = new Map<unknown, Function>();
    const mockServer = {
      setRequestHandler: (schema: unknown, handler: Function) => {
        handlers.set(schema, handler);
      },
    };

    const mockRouter = {
      handleCall: vi.fn().mockResolvedValue([
        [{ type: "text", text: '{"status":"ok"}' }],
        false,
        undefined,
      ]),
    };

    return { registry, handlers, mockServer, mockRouter };
  }

  const ALL_SYSTEM_READ_IDS = [
    "system.health.summary",
    "system.health.module",
    "system.usage.summary",
    "system.usage.module",
    "system.manifest.full",
    "system.manifest.module",
  ];

  it("lists the three static system resources alongside docs:// resources", async () => {
    const descriptors: Record<string, ModuleDescriptor> = {};
    for (const id of ALL_SYSTEM_READ_IDS) {
      descriptors[id] = makeDescriptor({ moduleId: id });
    }
    descriptors["mod.documented"] = makeDescriptor({
      moduleId: "mod.documented",
      documentation: "docs",
    });
    const registry = createMockRegistry(descriptors);
    const handlers = new Map<unknown, Function>();
    const mockServer = {
      setRequestHandler: (schema: unknown, handler: Function) => {
        handlers.set(schema, handler);
      },
    };
    const mockRouter = {
      handleCall: vi.fn().mockResolvedValue([
        [{ type: "text", text: '{"status":"ok"}' }],
        false,
        undefined,
      ]),
    };

    const factory = new MCPServerFactory();
    factory.registerResourceHandlers(mockServer as any, registry, mockRouter as any);

    const listHandler = handlers.get(ListResourcesRequestSchema)!;
    const result = await listHandler({});
    const uris = result.resources.map((r: { uri: string }) => r.uri).sort();

    expect(uris).toEqual(
      [
        "docs://mod.documented",
        "apcore://system.health.summary",
        "apcore://system.usage.summary",
        "apcore://system.manifest.full",
      ].sort(),
    );
    const staticEntry = result.resources.find(
      (r: { uri: string }) => r.uri === "apcore://system.health.summary",
    );
    expect(staticEntry.mimeType).toBe("application/json");
  });

  it("registers resources/templates/list only when at least one template module is present", async () => {
    const withTemplates = setup(ALL_SYSTEM_READ_IDS);
    const factory1 = new MCPServerFactory();
    factory1.registerResourceHandlers(withTemplates.mockServer as any, withTemplates.registry, withTemplates.mockRouter as any);
    const templatesHandler = withTemplates.handlers.get(ListResourceTemplatesRequestSchema);
    expect(templatesHandler).toBeDefined();
    const result = await templatesHandler!({});
    const templates = result.resourceTemplates.map((t: { uriTemplate: string }) => t.uriTemplate).sort();
    expect(templates).toEqual(
      [
        "apcore://system.health.module/{module_id}",
        "apcore://system.manifest.module/{module_id}",
        "apcore://system.usage.module/{module_id}{?period}",
      ].sort(),
    );

    const withoutSystemModules = setup(["mod.plain"]);
    const factory2 = new MCPServerFactory();
    factory2.registerResourceHandlers(
      withoutSystemModules.mockServer as any,
      withoutSystemModules.registry,
      withoutSystemModules.mockRouter as any,
    );
    expect(withoutSystemModules.handlers.get(ListResourceTemplatesRequestSchema)).toBeUndefined();
  });

  it("with sys_modules disabled (nothing registered), neither resources/list nor templates contains system.*", async () => {
    const { registry, handlers, mockServer, mockRouter } = setup(["mod.plain"]);
    const factory = new MCPServerFactory();
    factory.registerResourceHandlers(mockServer as any, registry, mockRouter as any);

    const listHandler = handlers.get(ListResourcesRequestSchema)!;
    const result = await listHandler({});
    expect(result.resources.some((r: { uri: string }) => r.uri.includes("system."))).toBe(false);
    expect(handlers.get(ListResourceTemplatesRequestSchema)).toBeUndefined();
  });

  it("resources/read for a static resource dispatches through router.handleCall with {} args", async () => {
    const { registry, handlers, mockServer, mockRouter } = setup(ALL_SYSTEM_READ_IDS);
    const factory = new MCPServerFactory();
    factory.registerResourceHandlers(mockServer as any, registry, mockRouter as any);

    const readHandler = handlers.get(ReadResourceRequestSchema)!;
    const result = await readHandler({ params: { uri: "apcore://system.health.summary" } });

    expect(mockRouter.handleCall).toHaveBeenCalledWith(
      "system.health.summary",
      {},
      expect.anything(),
    );
    expect(result.contents).toEqual([
      { uri: "apcore://system.health.summary", text: '{"status":"ok"}', mimeType: "application/json" },
    ]);
  });

  it("resources/read for a static resource forwards a query parameter (period)", async () => {
    const { registry, handlers, mockServer, mockRouter } = setup(ALL_SYSTEM_READ_IDS);
    const factory = new MCPServerFactory();
    factory.registerResourceHandlers(mockServer as any, registry, mockRouter as any);

    const readHandler = handlers.get(ReadResourceRequestSchema)!;
    await readHandler({ params: { uri: "apcore://system.usage.summary?period=24h" } });

    expect(mockRouter.handleCall).toHaveBeenCalledWith(
      "system.usage.summary",
      { period: "24h" },
      expect.anything(),
    );
  });

  it("resources/read for a template resource extracts module_id from the path", async () => {
    const { registry, handlers, mockServer, mockRouter } = setup(ALL_SYSTEM_READ_IDS);
    const factory = new MCPServerFactory();
    factory.registerResourceHandlers(mockServer as any, registry, mockRouter as any);

    const readHandler = handlers.get(ReadResourceRequestSchema)!;
    await readHandler({ params: { uri: "apcore://system.health.module/text.analyze" } });

    expect(mockRouter.handleCall).toHaveBeenCalledWith(
      "system.health.module",
      { module_id: "text.analyze" },
      expect.anything(),
    );
  });

  it("resources/read for system.usage.module combines module_id and period", async () => {
    const { registry, handlers, mockServer, mockRouter } = setup(ALL_SYSTEM_READ_IDS);
    const factory = new MCPServerFactory();
    factory.registerResourceHandlers(mockServer as any, registry, mockRouter as any);

    const readHandler = handlers.get(ReadResourceRequestSchema)!;
    await readHandler({
      params: { uri: "apcore://system.usage.module/text.analyze?period=7d" },
    });

    expect(mockRouter.handleCall).toHaveBeenCalledWith(
      "system.usage.module",
      { module_id: "text.analyze", period: "7d" },
      expect.anything(),
    );
  });

  it("resources/read throws for an unregistered system.* module id", async () => {
    const { registry, handlers, mockServer, mockRouter } = setup(["system.health.summary"]);
    const factory = new MCPServerFactory();
    factory.registerResourceHandlers(mockServer as any, registry, mockRouter as any);

    const readHandler = handlers.get(ReadResourceRequestSchema)!;
    await expect(
      readHandler({ params: { uri: "apcore://system.usage.summary" } }),
    ).rejects.toThrow(/Resource not found/);
  });

  it("resources/read throws when a template module is read without its module_id segment", async () => {
    const { registry, handlers, mockServer, mockRouter } = setup(ALL_SYSTEM_READ_IDS);
    const factory = new MCPServerFactory();
    factory.registerResourceHandlers(mockServer as any, registry, mockRouter as any);

    const readHandler = handlers.get(ReadResourceRequestSchema)!;
    await expect(
      readHandler({ params: { uri: "apcore://system.health.module" } }),
    ).rejects.toThrow(/missing the required "module_id"/);
  });

  it("resources/read throws when a static module is read with an unsupported module_id segment", async () => {
    const { registry, handlers, mockServer, mockRouter } = setup(ALL_SYSTEM_READ_IDS);
    const factory = new MCPServerFactory();
    factory.registerResourceHandlers(mockServer as any, registry, mockRouter as any);

    const readHandler = handlers.get(ReadResourceRequestSchema)!;
    await expect(
      readHandler({ params: { uri: "apcore://system.health.summary/oops" } }),
    ).rejects.toThrow(/does not accept a module_id/);
  });

  it("resources/read throws for an unsupported query parameter", async () => {
    const { registry, handlers, mockServer, mockRouter } = setup(ALL_SYSTEM_READ_IDS);
    const factory = new MCPServerFactory();
    factory.registerResourceHandlers(mockServer as any, registry, mockRouter as any);

    const readHandler = handlers.get(ReadResourceRequestSchema)!;
    await expect(
      readHandler({ params: { uri: "apcore://system.health.summary?bogus=1" } }),
    ).rejects.toThrow(/unsupported parameter/);
  });

  it("resources/read throws a clear error when no router was supplied", async () => {
    const { registry, handlers, mockServer } = setup(ALL_SYSTEM_READ_IDS);
    const factory = new MCPServerFactory();
    factory.registerResourceHandlers(mockServer as any, registry); // no router

    const readHandler = handlers.get(ReadResourceRequestSchema)!;
    await expect(
      readHandler({ params: { uri: "apcore://system.health.summary" } }),
    ).rejects.toThrow(/was not given an ExecutionRouter/);
  });

  it("surfaces an ACL-denied router result as a thrown MCP error (never bypasses the router)", async () => {
    const { registry, handlers, mockServer } = setup(ALL_SYSTEM_READ_IDS);
    const denyingRouter = {
      handleCall: vi.fn().mockResolvedValue([
        [{ type: "text", text: "ACL denied: caller not authorized" }],
        true,
        undefined,
      ]),
    };
    const factory = new MCPServerFactory();
    factory.registerResourceHandlers(mockServer as any, registry, denyingRouter as any);

    const readHandler = handlers.get(ReadResourceRequestSchema)!;
    await expect(
      readHandler({ params: { uri: "apcore://system.health.summary" } }),
    ).rejects.toThrow(/ACL denied/);
    expect(denyingRouter.handleCall).toHaveBeenCalled();
  });

  it("docs:// resources keep working unchanged alongside the system.* handler", async () => {
    const descriptors: Record<string, ModuleDescriptor> = {
      "mod.documented": makeDescriptor({ moduleId: "mod.documented", documentation: "Some docs" }),
    };
    const registry = createMockRegistry(descriptors);
    const handlers = new Map<unknown, Function>();
    const mockServer = {
      setRequestHandler: (schema: unknown, handler: Function) => handlers.set(schema, handler),
    };
    const factory = new MCPServerFactory();
    factory.registerResourceHandlers(mockServer as any, registry);

    const readHandler = handlers.get(ReadResourceRequestSchema)!;
    const result = await readHandler({ params: { uri: "docs://mod.documented" } });
    expect(result.contents[0].text).toBe("Some docs");
  });
});

// ---------------------------------------------------------------------------
// aiperceivable/apcore-mcp#16 phase A acceptance: a client that does not
// declare/inspect the extension still reaches every tool and resource.
// ---------------------------------------------------------------------------

describe("extension-unaware client still reaches tools and resources (#16 regression)", () => {
  it("tools/list, tools/call, resources/list and resources/read all work when the client never looks at capabilities.extensions", async () => {
    const descriptor = makeDescriptor({ moduleId: "system.control.reload_module" });
    const registry = createMockRegistry({
      "system.health.summary": makeDescriptor({ moduleId: "system.health.summary" }),
      "system.control.reload_module": descriptor,
    });

    const factory = new MCPServerFactory();
    // The server advertises the extension...
    const server = factory.createServer("test", "1.0.0", {
      health: true,
      usage: false,
      manifest: false,
      control: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = (server as any).getCapabilities?.() ?? (server as any)._capabilities;
    expect(caps.extensions).toBeDefined();

    // ...but a client that never reads `caps.extensions` still reaches
    // everything through the ordinary primitives.
    const tools = factory.buildTools(registry);
    const handlers = new Map<unknown, Function>();
    const mockServer = {
      setRequestHandler: (schema: unknown, handler: Function) => handlers.set(schema, handler),
    };
    const mockRouter = {
      handleCall: vi.fn().mockResolvedValue([
        [{ type: "text", text: '{"ok":true}' }],
        false,
        undefined,
      ]),
    };
    factory.registerHandlers(mockServer as any, tools, mockRouter as any);
    factory.registerResourceHandlers(mockServer as any, registry, mockRouter as any);

    const toolsList = await handlers.get(ListToolsRequestSchema)!({});
    expect(toolsList.tools.map((t: { name: string }) => t.name)).toEqual([
      "system.control.reload_module",
    ]);

    const callResult = await handlers.get(CallToolRequestSchema)!({
      params: { name: "system.control.reload_module", arguments: {} },
    });
    expect(callResult.content[0].text).toBe('{"ok":true}');

    const resourcesList = await handlers.get(ListResourcesRequestSchema)!({});
    expect(resourcesList.resources.some((r: { uri: string }) => r.uri === "apcore://system.health.summary")).toBe(true);

    const readResult = await handlers.get(ReadResourceRequestSchema)!({
      params: { uri: "apcore://system.health.summary" },
    });
    expect(readResult.contents[0].text).toBe('{"ok":true}');
  });
});
