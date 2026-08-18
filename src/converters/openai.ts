/**
 * OpenAIConverter - Converts apcore Registry modules to OpenAI-compatible tool definitions.
 *
 * Uses SchemaConverter, AnnotationMapper, and ModuleIDNormalizer internally
 * to produce function-calling tool definitions that conform to the OpenAI
 * chat completions API.
 */

import { SchemaConverter } from "../adapters/schema.js";
import { AnnotationMapper } from "../adapters/annotations.js";
import { ModuleIDNormalizer } from "../adapters/id-normalizer.js";
import type { Registry, ModuleDescriptor, OpenAIToolDef, JsonSchema } from "../types.js";
import { isMarkdownAvailable, renderModuleMarkdownSync } from "../markdown.js";

/** Options shared by convertRegistry and convertDescriptor. */
export interface ConvertOptions {
  /** If true, append annotation hints to the tool description. */
  embedAnnotations?: boolean;
  /** If true, apply OpenAI strict-mode transformations to the schema. */
  strict?: boolean;
  /**
   * If true, replace the plain `description` with apcore-toolkit
   * Markdown rendering (`formatModule({ style: "markdown" })`). LLMs
   * select tools primarily from this field — Markdown packs more
   * decision-relevant signal per token. Requires apcore-toolkit;
   * the caller must `await primeMarkdownToolkit()` (or
   * `MCPServerFactory.prepare()`) before this synchronous path can
   * find the toolkit. Falls back to plain description when toolkit
   * is unavailable.
   */
  richDescription?: boolean;
}

/** Extended options accepted by convertRegistry (adds filtering). */
export interface ConvertRegistryOptions extends ConvertOptions {
  /** Optional tag filter forwarded to registry.list(). */
  tags?: string[];
  /** Optional prefix filter forwarded to registry.list(). */
  prefix?: string;
}

/**
 * Converts apcore Registry modules to OpenAI-compatible tool definitions.
 *
 * Each tool definition has the shape:
 * ```
 * {
 *   type: "function",
 *   function: {
 *     name: string,
 *     description: string,
 *     parameters: JsonSchema,
 *     strict?: boolean
 *   }
 * }
 * ```
 */
export class OpenAIConverter {
  private readonly _schemaConverter: SchemaConverter;
  private readonly _annotationMapper: AnnotationMapper;
  private readonly _idNormalizer: ModuleIDNormalizer;
  // One-shot flag: warn about missing apcore-toolkit at most once per
  // converter instance (mirrors MCPServerFactory._warnedToolkitMissing).
  private _warnedToolkitMissing = false;

  constructor() {
    this._schemaConverter = new SchemaConverter();
    this._annotationMapper = new AnnotationMapper();
    this._idNormalizer = new ModuleIDNormalizer();
  }

  /**
   * Convert all modules in a Registry to OpenAI tool definitions.
   *
   * Iterates registry.list() with optional tag/prefix filtering,
   * calls registry.getDefinition() for each module ID, skips null
   * definitions (race-condition guard), and converts each descriptor.
   *
   * @param registry - apcore Registry with list() and getDefinition() methods.
   * @param options  - Optional filtering and conversion options.
   * @returns Array of OpenAI-compatible tool definition objects.
   */
  convertRegistry(
    registry: Registry,
    options?: ConvertRegistryOptions,
  ): OpenAIToolDef[] {
    const tags = options?.tags;
    const prefix = options?.prefix;
    const embedAnnotations = options?.embedAnnotations;
    // [D10-005 / OC-1] TS default for `strict` is `true` (changed in 0.14.0 spec).
    const strict = options?.strict ?? true;
    const richDescription = options?.richDescription;

    const moduleIds = registry.list({
      tags: tags ?? null,
      prefix: prefix ?? null,
    });

    const tools: OpenAIToolDef[] = [];
    // [OC-3] Track normalized names so we can detect collisions.
    // OpenAI function names must be unique post-normalization
    // (dot→hyphen). E.g. `a.b` and `a-b` both normalize to `a-b`;
    // without this guard two tools with identical function.name would
    // be emitted silently, producing undefined OpenAI behavior.
    const seenNames = new Map<string, string>();

    for (const moduleId of moduleIds) {
      const descriptor = registry.getDefinition(moduleId);
      if (descriptor === null) {
        continue;
      }
      const tool = this.convertDescriptor(descriptor, {
        embedAnnotations,
        strict,
        richDescription,
      });
      const toolName = tool.function.name;
      const existing = seenNames.get(toolName);
      if (existing !== undefined && existing !== moduleId) {
        throw new Error(
          `OpenAI function-name collision: module ids "${existing}" and "${moduleId}" both ` +
            `normalize to "${toolName}". OpenAI requires unique function names; rename ` +
            `one of the modules to avoid the collision.`,
        );
      }
      seenNames.set(toolName, moduleId);
      tools.push(tool);
    }

    return tools;
  }

  /**
   * Convert a single ModuleDescriptor to an OpenAI tool definition.
   *
   * - Normalizes the moduleId via ModuleIDNormalizer (dots -> dashes).
   * - Converts the inputSchema via SchemaConverter.
   * - Optionally appends an annotation suffix to the description.
   * - Optionally applies strict-mode transformations to the schema.
   *
   * @param descriptor - Module descriptor with moduleId, description,
   *                     inputSchema, and optional annotations.
   * @param options    - Optional conversion flags.
   * @returns OpenAI-compatible tool definition object.
   */
  convertDescriptor(
    descriptor: ModuleDescriptor,
    options?: ConvertOptions,
  ): OpenAIToolDef {
    const embedAnnotations = options?.embedAnnotations ?? false;
    // [D10-005 / OC-1] TS default for `strict` is `true` (changed in 0.14.0 spec).
    const strict = options?.strict ?? true;
    const richDescription = options?.richDescription ?? false;

    const name = this._idNormalizer.normalize(descriptor.moduleId);
    let parameters = this._schemaConverter.convertInputSchema(descriptor);

    // Resolve the LLM-facing description. Markdown rendering takes
    // precedence over the plain `descriptor.description`; the
    // annotation suffix is appended last as a strict superset.
    let description = descriptor.description;
    if (richDescription) {
      if (isMarkdownAvailable()) {
        const md = renderModuleMarkdownSync(descriptor);
        if (md !== null) {
          description = md;
        }
      } else if (!this._warnedToolkitMissing) {
        this._warnedToolkitMissing = true;
        console.warn(
          "OpenAIConverter: richDescription=true but apcore-toolkit is not " +
            "available. Call `await primeMarkdownToolkit()` during startup, " +
            "or install `apcore-toolkit`. Falling back to plain descriptions.",
        );
      }
    }
    if (embedAnnotations) {
      const suffix = this._annotationMapper.toDescriptionSuffix(
        descriptor.annotations,
      );
      description += suffix;
    }

    // Apply strict mode transformations if requested
    if (strict) {
      parameters = this._applyStrictMode(parameters);
    }

    // Build the function definition
    const func: OpenAIToolDef["function"] = {
      name,
      description,
      parameters,
    };

    if (strict) {
      func.strict = true;
    }

    return {
      type: "function",
      function: func,
    };
  }

  /**
   * Convert a schema to OpenAI strict mode.
   *
   * Creates a deep copy and then recursively applies:
   * 1. `additionalProperties: false` on all objects with properties
   * 2. All properties become required
   * 3. Optional properties (not in original required) become nullable
   *    (type becomes [original, "null"])
   * 4. `default` values are removed
   * 5. Recurses into nested objects and array items
   *
   * @param schema - JSON Schema to transform.
   * @returns New schema with strict mode applied.
   */
  _applyStrictMode(schema: JsonSchema): JsonSchema {
    const copy = structuredClone(schema);
    // [D11-003] Step 1: promote x-llm-description → description recursively
    this._applyLlmDescriptions(copy);
    // [D11-003] Step 2: strip all x-* extension keys recursively
    this._stripExtensions(copy);
    // [D11-003] Steps 3 & 4 happen inside _applyStrictRecursive:
    //   - delete `default` from every sub-schema
    //   - sort `required` array alphabetically
    // [D11-012] Step 5: wrap optional $ref properties in oneOf nullable
    return this._applyStrictRecursive(copy);
  }

  /**
   * Recursively promote `x-llm-description` → `description` when present.
   * Mirrors Rust's `apply_strict_mode` step 1. [D11-003]
   */
  private _applyLlmDescriptions(schema: JsonSchema): void {
    if (typeof schema !== "object" || schema === null) return;
    const obj = schema as Record<string, unknown>;
    if (typeof obj["x-llm-description"] === "string") {
      obj["description"] = obj["x-llm-description"];
    }
    for (const value of Object.values(obj)) {
      if (typeof value === "object" && value !== null) {
        if (Array.isArray(value)) {
          for (const item of value) {
            this._applyLlmDescriptions(item as JsonSchema);
          }
        } else {
          this._applyLlmDescriptions(value as JsonSchema);
        }
      }
    }
  }

  /**
   * Recursively strip all keys starting with `x-`, and all `default` keys, from
   * every schema node.
   *
   * Mirrors Rust's `apply_strict_mode` step 2 (`openai.rs:527` retains on
   * `!k.starts_with("x-") && k != "default"`) and Python's `_strip_extensions`
   * with `strip_defaults=True`. [D11-003]
   *
   * [A-D-OC-4] `default` used to be deleted only from direct entries of a
   * `properties` map inside `_applyStrictRecursive`, so a default on `items`, at
   * the schema root, or inside a oneOf/anyOf/allOf branch survived into the
   * emitted tool while Rust and Python dropped it.
   */
  private _stripExtensions(schema: JsonSchema): void {
    if (typeof schema !== "object" || schema === null) return;
    const obj = schema as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key.startsWith("x-") || key === "default") {
        delete obj[key];
      } else {
        const value = obj[key];
        if (typeof value === "object" && value !== null) {
          if (Array.isArray(value)) {
            for (const item of value) {
              this._stripExtensions(item as JsonSchema);
            }
          } else {
            this._stripExtensions(value as JsonSchema);
          }
        }
      }
    }
  }

  /**
   * Recursively apply strict mode transformations to a schema node (in place).
   *
   * @param schema - Schema node to transform.
   * @returns The transformed schema node.
   */
  private _applyStrictRecursive(schema: JsonSchema): JsonSchema {
    if (typeof schema !== "object" || schema === null) {
      return schema;
    }

    // Process object types that have properties
    if (schema["type"] === "object" && schema["properties"] !== undefined) {
      schema["additionalProperties"] = false;

      const properties = schema["properties"] as Record<string, JsonSchema>;
      const existingRequired = new Set<string>(
        (schema["required"] as string[] | undefined) ?? [],
      );
      // [D11-005] Sort property names alphabetically to match Python+Rust output.
      const allPropertyNames = Object.keys(properties).sort();

      // Make optional properties nullable and add them to required
      for (const propName of allPropertyNames) {
        const propSchema = properties[propName];

        // [A-D-OC-4] `default` is already gone: _stripExtensions removes it from
        // every node before this walker runs.

        // If not already required, make it nullable
        if (!existingRequired.has(propName)) {
          const currentType = propSchema["type"] as
            | string
            | string[]
            | undefined;
          if (currentType !== undefined && currentType !== "null") {
            if (Array.isArray(currentType)) {
              if (!currentType.includes("null")) {
                propSchema["type"] = [...currentType, "null"];
              }
            } else {
              propSchema["type"] = [currentType, "null"];
            }
          } else if (currentType === undefined) {
            // [D11-012] Optional $ref property (no `type`) — wrap in oneOf nullable
            // to match Python+Rust's handling of pure $ref or composition schemas.
            properties[propName] = { oneOf: [structuredClone(propSchema), { type: "null" }] } as JsonSchema;
            continue;
          }
        }

        // Recurse into nested properties
        properties[propName] = this._applyStrictRecursive(propSchema);
      }

      // [D11-003] All properties become required; [D11-005] sort alphabetically
      schema["required"] = allPropertyNames;
    }

    // Recurse into array items
    if (schema["type"] === "array" && schema["items"] !== undefined) {
      schema["items"] = this._applyStrictRecursive(
        schema["items"] as JsonSchema,
      );
    }

    // Recurse into prefixItems (JSON Schema 2020-12 tuple validation)
    if (schema["prefixItems"] !== undefined && Array.isArray(schema["prefixItems"])) {
      schema["prefixItems"] = (schema["prefixItems"] as JsonSchema[]).map(
        (item) => this._applyStrictRecursive(item)
      );
    }

    // [A-D-OC-2] Recurse into composition branches. A Pydantic `Optional[Model]`
    // becomes `anyOf: [{type:"object", ...}, {type:"null"}]` after $ref inlining,
    // so skipping these left the nested object without additionalProperties:
    // false and without hardened `required` — which OpenAI strict mode rejects.
    // Mirrors openai.rs:622-637 and Python's _convert_to_strict.
    for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
      const branches = schema[keyword];
      if (Array.isArray(branches)) {
        schema[keyword] = (branches as JsonSchema[]).map((branch) =>
          this._applyStrictRecursive(branch),
        );
      }
    }

    // Recurse into $defs / definitions (caller-provided schemas that still
    // carry them). `definitions` is the pre-2019-09 spelling and is what
    // Python and Rust both walk alongside `$defs`.
    for (const defsKey of ["$defs", "definitions"] as const) {
      const defs = schema[defsKey];
      if (defs && typeof defs === "object" && !Array.isArray(defs)) {
        const map = defs as Record<string, JsonSchema>;
        for (const [k, v] of Object.entries(map)) {
          map[k] = this._applyStrictRecursive(v);
        }
      }
    }

    return schema;
  }
}
