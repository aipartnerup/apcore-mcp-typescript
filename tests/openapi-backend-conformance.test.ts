/**
 * Cross-language conformance: the OpenAPI backend.
 *
 * Drives the TypeScript implementation from the shared fixture at
 * `apcore-mcp/conformance/fixtures/openapi_backend.json`. The Python and Rust
 * bridges run the same fixture through their own entry points.
 *
 * Three sections, each with its own shape: `test_cases` (document -> modules),
 * `config_cases` (how the `spec` value resolves), `error_cases` (fatal
 * configurations).
 */

import { describe, it, expect } from "vitest";
import { Registry, FunctionModule } from "apcore-js";
import { loadFixture, skipMessage } from "./conformance-fixtures.js";
import { openapiBackend, resolveSpecLocation } from "../src/openapi-backend.js";
import { ModuleIDNormalizer } from "../src/adapters/id-normalizer.js";

interface ExpectedModule {
  module_id: string;
  mcp_tool_name?: string;
  openai_function_name?: string;
  mcp_annotations?: Record<string, boolean>;
  requires_approval?: boolean;
  warnings_contain?: string;
}

interface Fixture {
  test_cases: Array<{
    id: string;
    document: Record<string, unknown>;
    options: Record<string, unknown>;
    expected_modules: ExpectedModule[];
    expected_skipped: Array<{ derived_module_id: string; reason_substring: string }>;
  }>;
  config_cases: Array<{
    id: string;
    spec_value: string;
    spec_value_next_tier?: string;
    project_root: string;
    cwd: string;
    expected_resolved_spec: string;
    expected_warning_substring?: string;
  }>;
  error_cases: Array<{
    id: string;
    document: Record<string, unknown>;
    options: Record<string, unknown>;
    preexisting_registry_module_ids?: string[];
    expected_error_substrings: string[];
    expected_registry_module_ids_after?: string[];
  }>;
}

const FIXTURE = loadFixture<Fixture>("openapi_backend.json");
const NORMALIZER = new ModuleIDNormalizer();

function collector() {
  const messages: string[] = [];
  return {
    messages,
    logger: { warn: (m: string) => messages.push(m), error: (m: string) => messages.push(m) },
  };
}

function toOptions(raw: Record<string, unknown>) {
  const { additional_backend_source, base_url, prefix, include, exclude, include_deprecated } =
    raw as Record<string, never>;
  return {
    hasOtherBackendSource: Boolean(additional_backend_source),
    baseUrl: base_url as string | undefined,
    prefix: prefix as string | undefined,
    include: include as string | undefined,
    exclude: exclude as string | undefined,
    includeDeprecated: (include_deprecated as boolean | undefined) ?? true,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ids(registry: any): string[] {
  return (registry.list({ visibility: ["public", "hidden"] }) as string[]) ?? [];
}

describe("conformance: openapiBackend modules", () => {
  if (!FIXTURE) {
    it.skip(skipMessage("openapi_backend.json"), () => {});
    return;
  }
  for (const c of FIXTURE.test_cases) {
    it(c.id, async () => {
      const { messages, logger } = collector();
      const registry = await openapiBackend(c.document, { ...toOptions(c.options), logger });

      expect(ids(registry).sort()).toEqual(c.expected_modules.map((m) => m.module_id).sort());

      for (const want of c.expected_modules) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const descriptor = await (registry as any).getDefinition(want.module_id);
        if (want.mcp_tool_name) expect(want.module_id).toBe(want.mcp_tool_name);
        if (want.openai_function_name) {
          expect(NORMALIZER.normalize(want.module_id)).toBe(want.openai_function_name);
        }
        if (want.mcp_annotations) {
          const ann = descriptor.annotations ?? {};
          const hints: Record<string, boolean> = {
            readOnlyHint: Boolean(ann.readonly),
            destructiveHint: Boolean(ann.destructive),
            idempotentHint: Boolean(ann.idempotent),
            openWorldHint: ann.openWorld !== false,
          };
          for (const [k, v] of Object.entries(want.mcp_annotations)) {
            expect(hints[k], `${c.id}/${want.module_id}: ${k}`).toBe(v);
          }
        }
        if (want.requires_approval !== undefined) {
          expect(Boolean(descriptor.annotations?.requiresApproval)).toBe(want.requires_approval);
        }
        if (want.warnings_contain) {
          expect(messages.join(" ")).toContain(want.warnings_contain);
        }
      }

      for (const skip of c.expected_skipped ?? []) {
        // A transformModule returning null drops the module SILENTLY — the
        // warning is the bridge's to emit.
        expect(messages.join(" "), `${c.id}: no warning named the skipped operation`).toContain(
          skip.derived_module_id,
        );
        expect(messages.join(" ")).toContain(skip.reason_substring);
      }
    });
  }
});

describe("conformance: openapiBackend spec resolution", () => {
  if (!FIXTURE) {
    it.skip(skipMessage("openapi_backend.json"), () => {});
    return;
  }
  for (const c of FIXTURE.config_cases) {
    it(c.id, () => {
      const { messages, logger } = collector();
      let resolved = resolveSpecLocation(c.spec_value, { projectRoot: c.project_root, logger });
      if (resolved === null) {
        expect(c.spec_value_next_tier, `${c.id}: discarded but no next tier`).toBeDefined();
        resolved = resolveSpecLocation(c.spec_value_next_tier!, {
          projectRoot: c.project_root,
          logger,
        });
      }
      expect(resolved).toBe(c.expected_resolved_spec);
      if (c.expected_warning_substring) {
        expect(messages.join(" ")).toContain(c.expected_warning_substring);
      }
    });
  }
});

describe("conformance: openapiBackend error cases", () => {
  if (!FIXTURE) {
    it.skip(skipMessage("openapi_backend.json"), () => {});
    return;
  }
  for (const c of FIXTURE.error_cases) {
    it(c.id, async () => {
      const { logger } = collector();
      let registry: Registry | undefined;
      if (c.preexisting_registry_module_ids?.length) {
        registry = new Registry();
        for (const mid of c.preexisting_registry_module_ids) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (registry as any).register(
            mid,
            new FunctionModule({
              moduleId: mid,
              description: "stub",
              handler: async () => ({}),
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
            }),
          );
        }
      }

      let message: string | null = null;
      try {
        await openapiBackend(c.document, { ...toOptions(c.options), registry, logger });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, `${c.id}: expected a rejection`).not.toBeNull();
      for (const fragment of c.expected_error_substrings) {
        expect(message!, `${c.id}: missing ${fragment}`).toContain(fragment);
      }
      if (c.expected_registry_module_ids_after && registry) {
        expect(
          ids(registry).sort(),
          `${c.id}: the preflight must register NOTHING`,
        ).toEqual([...c.expected_registry_module_ids_after].sort());
      }
    });
  }
});
