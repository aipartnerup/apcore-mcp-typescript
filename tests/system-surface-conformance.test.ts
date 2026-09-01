/**
 * Cross-language conformance: the nine canonical system.* modules -> exact MCP primitive.
 *
 * Drives `MCPServerFactory.buildTools` / `registerResourceHandlers` from the
 * shared fixture at `apcore-mcp/conformance/fixtures/system_surface.json`,
 * against a registry built by a REAL `apcore-js` `registerSysModules()` call
 * (the same pattern `tests/acl-rule-template.test.ts` uses for
 * aiperceivable/apcore-mcp#14). The Python and Rust bridges run the
 * identical fixture through their own factories against their own real
 * `register_sys_modules`; all three must agree byte-for-byte on which module
 * ids become tools, which become resources, which become resource
 * templates, and the exact name/URI each one gets
 * (aiperceivable/apcore-mcp#15's "byte-identical tools/list, resources/list,
 * resources/templates/list" acceptance criterion).
 */

import { describe, expect, it } from "vitest";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MCPServerFactory } from "../src/server/factory.js";
import { ExecutionRouter } from "../src/server/router.js";
import { loadFixture, skipMessage } from "./conformance-fixtures.js";

interface Fixture {
  setup: { config: Record<string, unknown> };
  tools: { module_id: string; name: string }[];
  not_tools: string[];
  resources: { module_id: string; uri: string }[];
  resource_templates: { module_id: string; uri_template: string }[];
}

const FIXTURE = loadFixture<Fixture>("system_surface.json");

type ApcoreJsModule = {
  Registry: new () => { list: (opts?: { visibility?: string[] }) => string[] };
  Executor: new (opts: { registry: unknown }) => unknown;
  Config: new (data?: Record<string, unknown>) => unknown;
  registerSysModules: (
    registry: unknown,
    executor: unknown,
    config: unknown,
    metricsCollector: unknown,
  ) => void;
};

async function realRegistryAndExecutor(): Promise<{ registry: unknown; executor: unknown }> {
  const apcore = (await import("apcore-js")) as unknown as ApcoreJsModule;
  const registry = new apcore.Registry();
  const executor = new apcore.Executor({ registry });
  const config = new apcore.Config(FIXTURE!.setup.config);
  apcore.registerSysModules(registry, executor, config, null);
  return { registry, executor };
}

function mockServer(): { server: { setRequestHandler: (schema: unknown, handler: Function) => void }; handlers: Map<unknown, Function> } {
  const handlers = new Map<unknown, Function>();
  return {
    server: {
      setRequestHandler: (schema: unknown, handler: Function) => {
        handlers.set(schema, handler);
      },
    },
    handlers,
  };
}

describe("conformance: system.* module -> exact MCP primitive", () => {
  if (!FIXTURE) {
    it.skip(skipMessage("system_surface.json"), () => {});
    return;
  }

  it("system.control.* modules are tools", async () => {
    const { registry } = await realRegistryAndExecutor();
    const factory = new MCPServerFactory();
    const tools = factory.buildTools(registry as any);
    const toolNames = new Set(tools.map((t) => t.name));

    for (const expected of FIXTURE.tools) {
      expect(toolNames.has(expected.name), `${expected.module_id} missing from tools/list`).toBe(true);
    }
  });

  it("read-only system.* modules are NOT tools", async () => {
    const { registry } = await realRegistryAndExecutor();
    const factory = new MCPServerFactory();
    const tools = factory.buildTools(registry as any);
    const toolNames = new Set(tools.map((t) => t.name));

    for (const moduleId of FIXTURE.not_tools) {
      expect(toolNames.has(moduleId), `${moduleId} must not be projected as a tool`).toBe(false);
    }
  });

  it("read-only system.* modules are resources and resource templates", async () => {
    const { registry, executor } = await realRegistryAndExecutor();
    const router = new ExecutionRouter(executor as any);
    const factory = new MCPServerFactory();
    const { server, handlers } = mockServer();

    factory.registerResourceHandlers(server as any, registry as any, router);

    const listResources = handlers.get(ListResourcesRequestSchema);
    expect(listResources).toBeDefined();
    const resourcesResult = await listResources!({});
    const resourceUris = new Set(resourcesResult.resources.map((r: { uri: string }) => r.uri));

    for (const expected of FIXTURE.resources) {
      expect(resourceUris.has(expected.uri), `${expected.module_id} missing from resources/list`).toBe(true);
    }

    const listTemplates = handlers.get(ListResourceTemplatesRequestSchema);
    expect(listTemplates, "resources/templates/list handler must be registered").toBeDefined();
    const templatesResult = await listTemplates!({});
    const templateUris = new Set(
      templatesResult.resourceTemplates.map((t: { uriTemplate: string }) => t.uriTemplate),
    );

    for (const expected of FIXTURE.resource_templates) {
      expect(
        templateUris.has(expected.uri_template),
        `${expected.module_id} missing from resources/templates/list (got ${[...templateUris].join(", ")})`,
      ).toBe(true);
    }
  });
});
