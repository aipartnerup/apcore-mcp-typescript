/**
 * Cross-language conformance: F-038 tool output redaction.
 *
 * Drives the router's redaction step from the shared fixture at
 * `apcore-mcp/conformance/fixtures/output_redaction.json`. All three bridges
 * delegate the masking to apcore's `redactSensitive`; what this pins is their
 * side of it — that the router applies it, applies it with the module's output
 * schema, and does not post-process the result.
 */

import { describe, it, expect } from "vitest";
import { ExecutionRouter } from "../src/server/router.js";
import { loadFixture, skipMessage } from "./conformance-fixtures.js";

interface Case {
  id: string;
  output_schema: Record<string, unknown>;
  output: Record<string, unknown>;
  expected_redacted_output: Record<string, unknown>;
}

const FIXTURE = loadFixture<{ test_cases: Case[] }>("output_redaction.json");
const TOOL = "conformance.subject";

/** Redaction never reaches the executor; this stands in for one. */
const unusedExecutor = {
  call: () => {
    throw new Error("redaction must not execute the module");
  },
  callAsync: () => {
    throw new Error("redaction must not execute the module");
  },
} as never;

describe("conformance: output redaction", () => {
  if (!FIXTURE) {
    it.skip(skipMessage("output_redaction.json"), () => {});
    return;
  }
  for (const c of FIXTURE.test_cases) {
    it(c.id, async () => {
      const router = new ExecutionRouter(unusedExecutor, {
        outputSchemaMap: { [TOOL]: c.output_schema },
      });
      const original = JSON.stringify(c.output);

      // `_maybeRedact` is private; conformance asserts the behaviour, and the
      // three bridges each keep this step internal to the router.
      const redacted = await (
        router as unknown as {
          _maybeRedact(tool: string, result: unknown): Promise<unknown>;
        }
      )._maybeRedact(TOOL, { ...c.output });

      expect(redacted).toEqual(c.expected_redacted_output);
      expect(JSON.stringify(c.output), "the fixture input was mutated in place").toBe(original);
    });
  }
});
