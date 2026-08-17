/**
 * Cross-language conformance: ACL Config Bus loading.
 *
 * Drives the TypeScript builder from the shared fixture at
 * `apcore-mcp/conformance/fixtures/acl_config.json`. The Python and Rust
 * bridges run the same fixture through their own builders; all three
 * implementations must agree on (rule_count, default_effect) and on which
 * inputs are rejected.
 */

import { describe, it, expect } from "vitest";
import { loadFixture, skipMessage } from "./conformance-fixtures.js";
import { buildAclFromConfig } from "../src/acl-builder.js";

interface SuccessExpected {
  rule_count: number;
  default_effect: string;
}

interface Fixture {
  test_cases: Array<{
    id: string;
    description: string;
    input: unknown;
    expected_acl: SuccessExpected | null;
  }>;
  error_cases: Array<{
    id: string;
    description: string;
    input: unknown;
    expected_error_substring: string;
  }>;
}

const FIXTURE = loadFixture<Fixture>("acl_config.json");

describe("conformance: buildAclFromConfig success cases", () => {
  if (!FIXTURE) {
    it.skip(skipMessage("acl_config.json"), () => {});
    return;
  }
  for (const c of FIXTURE.test_cases) {
    it(c.id, async () => {
      const result = await buildAclFromConfig(c.input);
      if (c.expected_acl === null) {
        expect(result).toBeNull();
        return;
      }
      expect(result).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const acl = result as any;
      // Access rule count — TS ACL exposes a `rules()` getter returning ACLRule[].
      const rules: unknown[] =
        typeof acl.rules === "function"
          ? acl.rules()
          : (acl._rules as unknown[] | undefined) ?? [];
      expect(rules).toHaveLength(c.expected_acl.rule_count);
      // default_effect is stored on the instance; read whichever accessor exists.
      const defaultEffect =
        acl.defaultEffect ?? acl._defaultEffect ?? acl.default_effect;
      expect(defaultEffect).toBe(c.expected_acl.default_effect);
    });
  }
});

describe("conformance: buildAclFromConfig error cases", () => {
  if (!FIXTURE) {
    it.skip(skipMessage("acl_config.json"), () => {});
    return;
  }
  for (const c of FIXTURE.error_cases) {
    it(c.id, async () => {
      await expect(buildAclFromConfig(c.input)).rejects.toThrow(
        c.expected_error_substring,
      );
    });
  }
});
