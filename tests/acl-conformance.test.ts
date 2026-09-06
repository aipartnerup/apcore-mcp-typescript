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
    expected_error_substring?: string;
    expected_error_substrings?: string[];
    expected_error_names_field?: string;
    must_not_contain?: string;
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
      let message: string | null = null;
      try {
        await buildAclFromConfig(c.input);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, `${c.id}: expected a rejection`).not.toBeNull();

      // contract_version 1.2 accepts `expected_error_substring` (a single
      // string, as in 1.0/1.1) and/or `expected_error_substrings` (an array);
      // every fragment present must appear.
      const expected = [
        ...(c.expected_error_substring ? [c.expected_error_substring] : []),
        ...(c.expected_error_substrings ?? []),
      ];
      expect(expected.length, `${c.id}: fixture case carries no expectation`).toBeGreaterThan(0);
      for (const fragment of expected) {
        expect(message!, `${c.id}: missing ${fragment}`).toContain(fragment);
      }

      // The fixture pins the offending FIELD rather than a reason phrase: the
      // reason is apcore's, and apcore-js and apcore-python word the same
      // fault entirely differently.
      if (c.expected_error_names_field) {
        // The BARE name, not the quoted form: apcore-python and apcore-js
        // write `'callers'` while apcore-rust writes `'callers[1]'`, naming
        // the offending element. The bare token is what all three share.
        expect(message!, `${c.id}: does not name the field`).toContain(
          c.expected_error_names_field,
        );
      }

      // `must_not_contain` separates "named the right axis" from "rejected
      // something" — it is how the §6.2.1 ordering case is checked.
      if (c.must_not_contain) {
        expect(message!, `${c.id}: reported the wrong validation axis`).not.toContain(
          c.must_not_contain,
        );
      }
    });
  }
});
