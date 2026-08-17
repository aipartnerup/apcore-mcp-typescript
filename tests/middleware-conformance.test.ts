/**
 * Cross-language conformance: middleware Config Bus loading.
 *
 * Drives the TypeScript builder from the shared fixture at
 * `apcore-mcp/conformance/fixtures/middleware_config.json`. The Python and
 * Rust bridges run the same fixture through their own builders; all three
 * implementations must agree on the resulting middleware names and on which
 * inputs are rejected.
 */

import { describe, it, expect } from "vitest";
import { loadFixture, skipMessage } from "./conformance-fixtures.js";
import { buildMiddlewareFromConfig } from "../src/middleware-builder.js";

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

interface Fixture {
  test_cases: Array<{
    id: string;
    description: string;
    input_entries: unknown;
    expected_middleware_names: string[];
  }>;
  error_cases: Array<{
    id: string;
    description: string;
    input_entries: unknown;
    expected_error_substring: string;
  }>;
}

const FIXTURE = loadFixture<Fixture>("middleware_config.json");

// ---------------------------------------------------------------------------
// Class-name → conformance-label mapping
// ---------------------------------------------------------------------------

const CLASS_TO_LABEL: Record<string, string> = {
  // In apcore-js 0.19.0, RetryMiddleware is a deprecated alias for RetryHintMiddleware.
  // Accept both names so the conformance label mapping tolerates either version.
  RetryMiddleware: "retry",
  RetryHintMiddleware: "retry",
  LoggingMiddleware: "logging",
  ErrorHistoryMiddleware: "error_history",
};

function labels(instances: unknown[]): string[] {
  return instances.map((mw) => {
    const cls = (mw as { constructor: { name: string } }).constructor.name;
    const label = CLASS_TO_LABEL[cls];
    if (!label) {
      throw new Error(`Unexpected middleware class '${cls}'`);
    }
    return label;
  });
}

// ---------------------------------------------------------------------------
// Test suites (parameterised over fixture cases)
// ---------------------------------------------------------------------------

describe("conformance: buildMiddlewareFromConfig success cases", () => {
  if (!FIXTURE) {
    it.skip(skipMessage("middleware_config.json"), () => {});
    return;
  }
  for (const c of FIXTURE.test_cases) {
    it(c.id, async () => {
      const result = await buildMiddlewareFromConfig(
        c.input_entries as Parameters<typeof buildMiddlewareFromConfig>[0],
      );
      expect(labels(result)).toEqual(c.expected_middleware_names);
    });
  }
});

describe("conformance: buildMiddlewareFromConfig error cases", () => {
  if (!FIXTURE) {
    it.skip(skipMessage("middleware_config.json"), () => {});
    return;
  }
  for (const c of FIXTURE.error_cases) {
    it(c.id, async () => {
      await expect(
        buildMiddlewareFromConfig(
          c.input_entries as Parameters<typeof buildMiddlewareFromConfig>[0],
        ),
      ).rejects.toThrow(c.expected_error_substring);
    });
  }
});
