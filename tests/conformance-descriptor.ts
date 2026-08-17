/** Shared: turn a fixture `input_module` into a `ModuleDescriptor`. */
import type { JsonSchema, ModuleAnnotations, ModuleDescriptor } from "../src/types.js";

export interface FixtureModule {
  module_id: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** apcore annotation defaults, so a fixture only states what it cares about. */
function annotations(raw: Record<string, unknown> | undefined): ModuleAnnotations | null {
  if (!raw) return null;
  return {
    readonly: (raw.readonly as boolean) ?? false,
    destructive: (raw.destructive as boolean) ?? false,
    idempotent: (raw.idempotent as boolean) ?? false,
    requiresApproval: (raw.requires_approval as boolean) ?? false,
    openWorld: (raw.open_world as boolean) ?? true,
    streaming: (raw.streaming as boolean) ?? false,
    ...(raw.cacheable !== undefined ? { cacheable: raw.cacheable as boolean } : {}),
    ...(raw.extra !== undefined ? { extra: raw.extra as Record<string, unknown> } : {}),
  };
}

export function toDescriptor(module: FixtureModule): ModuleDescriptor {
  return {
    moduleId: module.module_id,
    name: null,
    description: module.description ?? "",
    documentation: null,
    inputSchema: (module.input_schema ?? {}) as JsonSchema,
    outputSchema: (module.output_schema ?? {}) as JsonSchema,
    version: "1.0.0",
    annotations: annotations(module.annotations),
  };
}
