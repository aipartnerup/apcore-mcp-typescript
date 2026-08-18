import { describe, it, expect } from "vitest";
import { OpenAIConverter } from "../../src/converters/openai.js";
import type { ModuleDescriptor, Registry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRegistry(
  descriptors: Record<string, ModuleDescriptor>,
): Registry {
  return {
    list: (opts?: { tags?: string[] | null; prefix?: string | null }) => {
      let ids = Object.keys(descriptors);
      if (opts?.prefix) {
        ids = ids.filter((id) => id.startsWith(opts.prefix!));
      }
      return ids;
    },
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
        name: { type: "string" },
      },
      required: ["name"],
    },
    outputSchema: overrides.outputSchema ?? {
      type: "object",
      properties: {
        result: { type: "string" },
      },
    },
    annotations: overrides.annotations !== undefined
      ? overrides.annotations
      : null,
    tags: overrides.tags,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAIConverter", () => {
  const converter = new OpenAIConverter();

  // TC-OPENAI-001
  it("converts a single descriptor to an OpenAI tool definition", () => {
    const descriptor = makeDescriptor({
      moduleId: "text.summarize",
      description: "Summarize text",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Input text" },
        },
        required: ["text"],
      },
    });

    const tool = converter.convertDescriptor(descriptor);

    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("text-summarize");
    expect(tool.function.description).toBe("Summarize text");
    expect(tool.function.parameters).toEqual(
      expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          text: { type: "string", description: "Input text" },
        }),
      }),
    );
  });

  // TC-OPENAI-002
  it("converts an empty registry to an empty array", () => {
    const registry = createMockRegistry({});
    const tools = converter.convertRegistry(registry);

    expect(tools).toEqual([]);
  });

  // TC-OPENAI-003
  it("normalizes module IDs by replacing dots with dashes", () => {
    const descriptor = makeDescriptor({
      moduleId: "image.resize",
    });

    const tool = converter.convertDescriptor(descriptor);

    expect(tool.function.name).toBe("image-resize");
  });

  // TC-OPENAI-004
  it("embeds annotations in description when embedAnnotations is true", () => {
    const descriptor = makeDescriptor({
      annotations: {
        readonly: true,
        destructive: false,
        idempotent: true,
        requiresApproval: false,
        openWorld: false,
      },
    });

    const tool = converter.convertDescriptor(descriptor, {
      embedAnnotations: true,
    });

    expect(tool.function.description).toContain("[Annotations:");
    // Only non-default values should appear
    expect(tool.function.description).toContain("readonly=true");
    expect(tool.function.description).toContain("idempotent=true");
    expect(tool.function.description).toContain("open_world=false");
    // Default values should NOT appear
    expect(tool.function.description).not.toContain("destructive=false");
    expect(tool.function.description).not.toContain("requires_approval=false");
  });

  // TC-OPENAI-005
  it("does not embed annotations by default", () => {
    const descriptor = makeDescriptor({
      annotations: {
        readonly: true,
        destructive: false,
        idempotent: true,
        requiresApproval: false,
        openWorld: false,
      },
    });

    const tool = converter.convertDescriptor(descriptor);

    expect(tool.function.description).not.toContain("[Annotations:");
  });

  // TC-OPENAI-006
  it("applies strict mode: adds strict flag, additionalProperties false, all props required", () => {
    const descriptor = makeDescriptor({
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
        },
        required: ["name", "age"],
      },
    });

    const tool = converter.convertDescriptor(descriptor, { strict: true });

    expect(tool.function.strict).toBe(true);
    expect(tool.function.parameters["additionalProperties"]).toBe(false);
    expect(tool.function.parameters["required"]).toEqual(
      expect.arrayContaining(["name", "age"]),
    );
  });

  // TC-OPENAI-007
  it("strict mode makes optional fields nullable with [type, 'null']", () => {
    const descriptor = makeDescriptor({
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          nickname: { type: "string" },
        },
        required: ["name"],
      },
    });

    const tool = converter.convertDescriptor(descriptor, { strict: true });

    const properties = tool.function.parameters["properties"] as Record<
      string,
      Record<string, unknown>
    >;

    // name was already required, so its type stays as-is
    expect(properties["name"]["type"]).toBe("string");

    // nickname was optional, so it becomes nullable
    expect(properties["nickname"]["type"]).toEqual(["string", "null"]);

    // All properties are now required
    expect(tool.function.parameters["required"]).toEqual(
      expect.arrayContaining(["name", "nickname"]),
    );
  });

  // TC-OPENAI-008
  it("strict mode removes default values", () => {
    const descriptor = makeDescriptor({
      inputSchema: {
        type: "object",
        properties: {
          count: { type: "integer", default: 10 },
        },
        required: ["count"],
      },
    });

    const tool = converter.convertDescriptor(descriptor, { strict: true });

    const properties = tool.function.parameters["properties"] as Record<
      string,
      Record<string, unknown>
    >;

    expect(properties["count"]["default"]).toBeUndefined();
  });

  // TC-OPENAI-009
  it("converts a registry with multiple modules", () => {
    const registry = createMockRegistry({
      "mod.a": makeDescriptor({ moduleId: "mod.a", description: "Module A" }),
      "mod.b": makeDescriptor({ moduleId: "mod.b", description: "Module B" }),
      "mod.c": makeDescriptor({ moduleId: "mod.c", description: "Module C" }),
    });

    const tools = converter.convertRegistry(registry);

    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("mod-a");
    expect(names).toContain("mod-b");
    expect(names).toContain("mod-c");
  });

  // TC-OPENAI-010
  it("skips null definitions returned by the registry", () => {
    const descriptors: Record<string, ModuleDescriptor> = {
      "mod.a": makeDescriptor({ moduleId: "mod.a" }),
      "mod.b": makeDescriptor({ moduleId: "mod.b" }),
    };

    // Override getDefinition to return null for mod.b
    const registry = createMockRegistry(descriptors);
    const originalGetDef = registry.getDefinition.bind(registry);
    registry.getDefinition = (id: string) => {
      if (id === "mod.b") return null;
      return originalGetDef(id);
    };

    const tools = converter.convertRegistry(registry);

    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("mod-a");
  });

  // TC-OPENAI-011
  it("filters modules by prefix", () => {
    const registry = createMockRegistry({
      "image.resize": makeDescriptor({ moduleId: "image.resize" }),
      "image.crop": makeDescriptor({ moduleId: "image.crop" }),
      "text.summarize": makeDescriptor({ moduleId: "text.summarize" }),
    });

    const tools = converter.convertRegistry(registry, { prefix: "image" });

    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("image-resize");
    expect(names).toContain("image-crop");
    expect(names).not.toContain("text-summarize");
  });

  // TC-OPENAI-012
  it("passes tags filter to registry.list()", () => {
    let capturedTags: string[] | null | undefined;

    const registry: Registry = {
      list: (opts?: { tags?: string[] | null; prefix?: string | null }) => {
        capturedTags = opts?.tags;
        return [];
      },
      getDefinition: () => null,
      on: () => {},
    };

    converter.convertRegistry(registry, { tags: ["ml", "vision"] });

    expect(capturedTags).toEqual(["ml", "vision"]);
  });

  // ---------------------------------------------------------------------------
  // [OC-1] Strict-mode walker parity with Python+Rust
  // ---------------------------------------------------------------------------

  describe("OC-1: strict-mode walker parity", () => {
    it("promotes x-llm-description into description", () => {
      const descriptor = makeDescriptor({
        moduleId: "test.module",
        inputSchema: {
          type: "object",
          properties: {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            ts: { type: "string", "x-llm-description": "agent-friendly hint" },
          },
          required: ["ts"],
        },
      });

      const tool = converter.convertDescriptor(descriptor, { strict: true });
      const params = tool.function.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, Record<string, unknown>>;
      expect(props.ts.description).toBe("agent-friendly hint");
      expect(props.ts["x-llm-description"]).toBeUndefined();
    });

    it("strips all x-* extension keys after promotion", () => {
      const descriptor = makeDescriptor({
        moduleId: "test.module",
        inputSchema: {
          type: "object",
          properties: {
            ts: {
              type: "string",
              // eslint-disable-next-line @typescript-eslint/naming-convention
              "x-llm-description": "hint",
              // eslint-disable-next-line @typescript-eslint/naming-convention
              "x-internal-tag": "should-be-stripped",
            },
          },
          required: ["ts"],
        },
      });

      const tool = converter.convertDescriptor(descriptor, { strict: true });
      const params = tool.function.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, Record<string, unknown>>;
      expect(Object.keys(props.ts).filter((k) => k.startsWith("x-"))).toEqual([]);
    });

    it("recurses into oneOf branches", () => {
      const descriptor = makeDescriptor({
        moduleId: "test.module",
        inputSchema: {
          type: "object",
          properties: {
            payload: {
              oneOf: [
                {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                },
                {
                  type: "object",
                  properties: { code: { type: "integer" } },
                  required: ["code"],
                },
              ],
            },
          },
          required: ["payload"],
        },
      });

      const tool = converter.convertDescriptor(descriptor, { strict: true });
      const params = tool.function.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, Record<string, unknown>>;
      const branches = (props.payload.oneOf as Array<Record<string, unknown>>);
      expect(branches[0].additionalProperties).toBe(false);
      expect(branches[1].additionalProperties).toBe(false);
    });

    it("recurses into $defs subschemas", () => {
      // The walker is exercised directly because the SchemaConverter inlines
      // $defs/refs before strict mode runs. The contract under test is that
      // when strict mode encounters $defs (e.g. caller-provided schemas that
      // still use them), it transforms each definition.
      const schema = {
        type: "object",
        $defs: {
          Address: {
            type: "object",
            properties: {
              street: { type: "string" },
              city: { type: "string" },
            },
            required: ["street"],
          },
        },
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      };

      const transformed = converter._applyStrictMode(schema) as Record<string, unknown>;
      const defs = transformed.$defs as Record<string, Record<string, unknown>>;
      expect(defs.Address.additionalProperties).toBe(false);
      // Both nested properties become required (alphabetically sorted).
      expect(defs.Address.required).toEqual(["city", "street"]);
    });

    it("sorts property names alphabetically for cross-SDK output parity", () => {
      const descriptor = makeDescriptor({
        moduleId: "test.module",
        inputSchema: {
          type: "object",
          properties: {
            zeta: { type: "string" },
            alpha: { type: "string" },
            beta: { type: "string" },
          },
          required: [],
        },
      });

      const tool = converter.convertDescriptor(descriptor, { strict: true });
      const params = tool.function.parameters as Record<string, unknown>;
      expect(params.required).toEqual(["alpha", "beta", "zeta"]);
    });

    it("removes default values from properties", () => {
      const descriptor = makeDescriptor({
        moduleId: "test.module",
        inputSchema: {
          type: "object",
          properties: {
            count: { type: "integer", default: 10 },
          },
          required: [],
        },
      });

      const tool = converter.convertDescriptor(descriptor, { strict: true });
      const params = tool.function.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, Record<string, unknown>>;
      expect(props.count.default).toBeUndefined();
    });

    // D11-003: _applyStrictMode pipeline steps
    it("D11-003: promotes x-llm-description to description", () => {
      const descriptor = makeDescriptor({
        moduleId: "test.module",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", "x-llm-description": "custom desc" } as Record<string, unknown>,
          },
          required: ["name"],
        },
      });
      const tool = converter.convertDescriptor(descriptor, { strict: true });
      const params = tool.function.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, Record<string, unknown>>;
      expect(props.name.description).toBe("custom desc");
    });

    it("D11-003: strips x-* extension keys", () => {
      const descriptor = makeDescriptor({
        moduleId: "test.module",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", "x-internal": "strip me", "x-llm-description": "custom" } as Record<string, unknown>,
          },
          required: ["name"],
        },
      });
      const tool = converter.convertDescriptor(descriptor, { strict: true });
      const params = tool.function.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, Record<string, unknown>>;
      expect(props.name["x-internal"]).toBeUndefined();
      expect(props.name["x-llm-description"]).toBeUndefined();
    });

    it("D11-003: sorts required alphabetically and strips default", () => {
      const descriptor = makeDescriptor({
        moduleId: "test.module",
        inputSchema: {
          type: "object",
          properties: {
            z: { type: "string", default: "last" } as Record<string, unknown>,
            a: { type: "number" },
            m: { type: "boolean" },
          },
          required: ["z", "a", "m"],
        },
      });
      const tool = converter.convertDescriptor(descriptor, { strict: true });
      const params = tool.function.parameters as Record<string, unknown>;
      expect(params.required).toEqual(["a", "m", "z"]);
      const props = params.properties as Record<string, Record<string, unknown>>;
      expect(props.z.default).toBeUndefined();
    });

    // TS-C1: _applyStrictRecursive must recurse into prefixItems
    it("_applyStrictRecursive recurses into prefixItems", () => {
      // Call _applyStrictMode directly (bypassing SchemaConverter) so we test
      // _applyStrictRecursive in isolation — the same pattern used by the $defs test.
      const schema = {
        type: "object",
        properties: {
          args: {
            type: "array",
            prefixItems: [
              { type: "object", properties: { x: { type: "string" } } },
            ],
          },
        },
        required: ["args"],
      };

      const result = converter._applyStrictMode(schema) as Record<string, unknown>;
      const props = result.properties as Record<string, Record<string, unknown>>;
      const tupleItem = (props.args.prefixItems as Array<Record<string, unknown>>)[0];
      expect(tupleItem.additionalProperties).toBe(false);
    });

    // [A-D-OC-2] The strict walker must enter composition branches. Called
    // directly because SchemaConverter's own _applyStrict already hardens
    // additionalProperties; what is missing here is the rest of strict mode
    // (required hardening, sorting, default stripping) inside oneOf/anyOf/allOf.
    it("[A-D-OC-2] hardens object branches inside anyOf", () => {
      const schema = {
        type: "object",
        properties: {
          // The shape a Pydantic Optional[Model] takes after $ref inlining.
          payload: {
            anyOf: [
              {
                type: "object",
                properties: { z: { type: "string" }, a: { type: "integer" } },
              },
              { type: "null" },
            ],
          },
        },
        required: ["payload"],
      };

      const result = converter._applyStrictMode(schema) as Record<string, unknown>;
      const props = result.properties as Record<string, Record<string, unknown>>;
      const branch = (props.payload.anyOf as Array<Record<string, unknown>>)[0];

      expect(branch.additionalProperties).toBe(false);
      expect(branch.required).toEqual(["a", "z"]);
    });

    it("[A-D-OC-2] hardens object branches inside oneOf and allOf", () => {
      const schema = {
        type: "object",
        properties: {
          one: {
            oneOf: [{ type: "object", properties: { b: { type: "string" } } }],
          },
          all: {
            allOf: [{ type: "object", properties: { c: { type: "string" } } }],
          },
        },
        required: ["one", "all"],
      };

      const result = converter._applyStrictMode(schema) as Record<string, unknown>;
      const props = result.properties as Record<string, Record<string, unknown>>;

      const oneBranch = (props.one.oneOf as Array<Record<string, unknown>>)[0];
      const allBranch = (props.all.allOf as Array<Record<string, unknown>>)[0];
      expect(oneBranch.additionalProperties).toBe(false);
      expect(oneBranch.required).toEqual(["b"]);
      expect(allBranch.additionalProperties).toBe(false);
      expect(allBranch.required).toEqual(["c"]);
    });

    it("[A-D-OC-2] recurses into legacy `definitions` as well as $defs", () => {
      const schema = {
        type: "object",
        definitions: {
          Address: {
            type: "object",
            properties: { street: { type: "string" }, city: { type: "string" } },
            required: ["street"],
          },
        },
        properties: { name: { type: "string" } },
        required: ["name"],
      };

      const result = converter._applyStrictMode(schema) as Record<string, unknown>;
      const defs = result.definitions as Record<string, Record<string, unknown>>;
      expect(defs.Address.additionalProperties).toBe(false);
      expect(defs.Address.required).toEqual(["city", "street"]);
    });

    // [A-D-OC-4] Rust drops `default` in one pass over every node
    // (openai.rs:527) and Python's _strip_extensions does the same; TypeScript
    // only deleted it from direct entries of a `properties` map.
    it("[A-D-OC-4] strips `default` from every schema node", () => {
      const schema = {
        type: "object",
        default: "root-default",
        properties: {
          list: { type: "array", items: { type: "string", default: "x" } },
          payload: {
            anyOf: [
              {
                type: "object",
                properties: { k: { type: "string", default: "inner" } },
              },
              { type: "null" },
            ],
          },
        },
        required: ["list", "payload"],
      };

      const result = converter._applyStrictMode(schema) as Record<string, unknown>;
      const props = result.properties as Record<string, Record<string, unknown>>;
      const items = props.list.items as Record<string, unknown>;
      const branch = (props.payload.anyOf as Array<Record<string, unknown>>)[0];
      const inner = (branch.properties as Record<string, Record<string, unknown>>).k;

      expect(result.default).toBeUndefined();
      expect(items.default).toBeUndefined();
      expect(inner.default).toBeUndefined();
    });

    // D11-012: Missing oneOf nullable wrap for $ref properties
    it("D11-012: wraps optional $ref property in oneOf nullable", () => {
      // Call _applyStrictMode directly because SchemaConverter inlines $refs
      // before the converter sees the schema. The raw schema here simulates
      // what a caller might pass directly to _applyStrictMode.
      const schema = {
        type: "object",
        properties: {
          id: { "$ref": "#/$defs/ID" },
        },
        required: [],  // id is optional
      };
      const result = converter._applyStrictMode(schema) as Record<string, unknown>;
      const props = result.properties as Record<string, unknown>;
      expect(props.id).toEqual({
        oneOf: [{ "$ref": "#/$defs/ID" }, { type: "null" }],
      });
    });
  });

  // apcore-toolkit 0.6+: rich Markdown tool descriptions
  describe("richDescription", () => {
    it("renders Markdown via apcore-toolkit when primed", async () => {
      const { primeMarkdownToolkit } = await import("../../src/markdown.js");
      const primed = await primeMarkdownToolkit();
      // apcore-toolkit ships in node_modules in this repo (optional dep
      // installed). If for some reason it isn't available, skip the
      // assertion rather than fail.
      if (!primed) return;
      const descriptor = makeDescriptor({
        moduleId: "image.resize",
        description: "Resize an image",
        tags: ["image"],
      });
      const tool = converter.convertDescriptor(descriptor, { richDescription: true });
      expect(tool.function.description).toMatch(/^# /);
      expect(tool.function.description).toContain("Resize an image");
      expect(tool.function.description).toContain("## Parameters");
    });

    it("returns plain description when richDescription is disabled", () => {
      // The actual "toolkit unavailable" fallback path is hard to test
      // in isolation because the toolkit loader caches the import
      // result module-wide. This test verifies the orthogonal path:
      // with richDescription=false, the plain `descriptor.description`
      // is always returned regardless of toolkit availability.
      const descriptor = makeDescriptor({ description: "Plain description" });
      const tool = converter.convertDescriptor(descriptor, { richDescription: false });
      expect(tool.function.description).toBe("Plain description");
    });

    it("convertRegistry propagates richDescription to every tool", async () => {
      const { primeMarkdownToolkit } = await import("../../src/markdown.js");
      const primed = await primeMarkdownToolkit();
      if (!primed) return;
      const registry = createMockRegistry({
        "demo.one": makeDescriptor({
          moduleId: "demo.one",
          description: "First demo",
        }),
      });
      const tools = converter.convertRegistry(registry, { richDescription: true });
      expect(tools).toHaveLength(1);
      expect(tools[0].function.description).toMatch(/^# /);
    });
  });
});
