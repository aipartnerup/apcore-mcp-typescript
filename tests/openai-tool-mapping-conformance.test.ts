/**
 * Cross-language conformance: apcore Module -> OpenAI function definition.
 *
 * Drives `OpenAIConverter.convertDescriptor` from the shared fixture at
 * `apcore-mcp/conformance/fixtures/openai_tool_mapping.json`. Assertions are
 * field-level rather than whole-object: the three bridges are known to join
 * annotation sections into the description differently, and pinning that
 * byte-for-byte would assert a formatting accident rather than the mapping rule.
 */

import { describe, it, expect } from "vitest";
import { OpenAIConverter } from "../src/converters/openai.js";
import { loadFixture, skipMessage } from "./conformance-fixtures.js";
import { toDescriptor, type FixtureModule } from "./conformance-descriptor.js";

interface Case {
  id: string;
  options?: { strict?: boolean; embed_annotations?: boolean };
  input_module: FixtureModule;
  expected_function_name: string;
  expected_property_description?: { property: string; value: string };
  expected_absent_property_keys?: string[];
  expected_property_of?: string;
  expected_description_contains?: string[];
  expected_description_not_contains?: string[];
}

const FIXTURE = loadFixture<{ test_cases: Case[] }>("openai_tool_mapping.json");

describe("conformance: module to OpenAI function", () => {
  if (!FIXTURE) {
    it.skip(skipMessage("openai_tool_mapping.json"), () => {});
    return;
  }
  for (const c of FIXTURE.test_cases) {
    it(c.id, () => {
      const result = new OpenAIConverter().convertDescriptor(toDescriptor(c.input_module), {
        embedAnnotations: c.options?.embed_annotations ?? false,
        strict: c.options?.strict ?? true,
      });
      const fn = result.function;

      expect(fn.name).toBe(c.expected_function_name);

      const properties = (fn.parameters?.properties ?? {}) as Record<
        string,
        Record<string, unknown>
      >;

      if (c.expected_property_description) {
        const { property, value } = c.expected_property_description;
        expect(properties[property]?.description, `${property}.description`).toBe(value);
      }

      if (c.expected_absent_property_keys) {
        const scoped = c.expected_property_of
          ? { [c.expected_property_of]: properties[c.expected_property_of] ?? {} }
          : properties;
        for (const [name, schema] of Object.entries(scoped)) {
          for (const forbidden of c.expected_absent_property_keys) {
            expect(schema, `property ${name} still carries ${forbidden}`).not.toHaveProperty(
              forbidden,
            );
          }
        }
      }

      for (const needle of c.expected_description_contains ?? []) {
        expect(fn.description).toContain(needle);
      }
      for (const needle of c.expected_description_not_contains ?? []) {
        expect(fn.description).not.toContain(needle);
      }
    });
  }
});
