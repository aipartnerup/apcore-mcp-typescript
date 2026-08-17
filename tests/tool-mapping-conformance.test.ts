/**
 * Cross-language conformance: apcore Module -> MCP Tool.
 *
 * Drives `MCPServerFactory.buildTool` from the shared fixture at
 * `apcore-mcp/conformance/fixtures/tool_mapping.json`. The Python and Rust
 * bridges run the same fixture through their own factories; all three must
 * agree on the tool name, input schema and annotation hints.
 *
 * The fixture pins SRS section 7.1: the MCP tool name keeps the module id's
 * dot notation. Hyphenation, `x-llm-description` promotion and `x-` stripping
 * belong to the OpenAI converter and are covered by
 * `openai-tool-mapping-conformance.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { MCPServerFactory } from "../src/server/factory.js";
import { loadFixture, skipMessage } from "./conformance-fixtures.js";
import { toDescriptor, type FixtureModule } from "./conformance-descriptor.js";

interface Case {
  id: string;
  input_module: FixtureModule;
  expected_mcp_tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: Record<string, unknown>;
  };
}

const FIXTURE = loadFixture<{ test_cases: Case[] }>("tool_mapping.json");

describe("conformance: module to MCP tool", () => {
  if (!FIXTURE) {
    it.skip(skipMessage("tool_mapping.json"), () => {});
    return;
  }
  for (const c of FIXTURE.test_cases) {
    it(c.id, () => {
      const tool = new MCPServerFactory().buildTool(toDescriptor(c.input_module));
      const expected = c.expected_mcp_tool;

      expect(tool.name).toBe(expected.name);
      expect(tool.description).toBe(expected.description);
      expect(tool.inputSchema).toEqual(expected.inputSchema);

      const got = (tool.annotations ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(expected.annotations)) {
        expect(got[key], `annotation ${key}`).toBe(value);
      }
    });
  }
});
