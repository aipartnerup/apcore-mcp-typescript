/**
 * FR-ACL-004 / PROTOCOL_SPEC §6.2.1 tier 2: rules that load cleanly and can
 * protect nothing.
 *
 * Two failures existed before this fix, found in the same sync pass:
 *
 * 1. `formatAclNeverMatchesWarnings` was exported but never called from
 *    `serve()`/`asyncServe()` — dead code, zero test coverage anywhere.
 * 2. Its `AclRuleFindingLike` field names (`path`/`reason`/`message`) did not
 *    match apcore-js's real `ACL.validateRules()` finding shape
 *    (`conditionPath`/no reason field at all) — even once wired, every
 *    finding would have rendered as `'?': `.
 *
 * These tests pin the real shape (verified against a live `apcore-js` `ACL`
 * instance) and the actual `asyncServe()` wiring, not just the formatter in
 * isolation — which is exactly the gap that let #1 ship unnoticed.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { formatAclNeverMatchesWarnings, asyncServe } from "../src/index.js";
import type { AclRuleFindingLike } from "../src/index.js";

describe("formatAclNeverMatchesWarnings()", () => {
  it("returns null for no findings", () => {
    expect(formatAclNeverMatchesWarnings(null)).toBeNull();
    expect(formatAclNeverMatchesWarnings(undefined)).toBeNull();
    expect(formatAclNeverMatchesWarnings([])).toBeNull();
  });

  it("formats a finding using apcore-js's real field names", () => {
    // Exact shape returned by a live `apcore-js` ACL.validateRules() call —
    // ruleIndex/conditionPath/effect, no reason/message field.
    const finding: AclRuleFindingLike = {
      ruleIndex: 0,
      conditionPath: "targets",
      conditionKey: null,
      effect: "deny",
      syncResolvable: false,
      asyncResolvable: false,
    };
    const message = formatAclNeverMatchesWarnings([finding]);
    expect(message).toContain("mcp.acl.rules[0]");
    expect(message).toContain("'targets'");
    expect(message).toContain("'deny' rule protects nothing");
  });

  it("includes the condition key when present", () => {
    const finding: AclRuleFindingLike = {
      ruleIndex: 2,
      conditionPath: "conditions.roles",
      conditionKey: "admin",
      effect: "allow",
    };
    expect(formatAclNeverMatchesWarnings([finding])).toContain("(admin)");
  });
});

describe("asyncServe() wires ACL.validateRules() into a startup warning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the tier-2 warning for a real inert ACL rule", async () => {
    const apcore = await import("apcore-js");
    const registry = new apcore.Registry();
    const acl = new apcore.ACL(
      // ["$not", "*"] has legal §6.2.1 arity — exactly one operand — and
      // matches nothing: the identical fail-open the shape closure does not
      // catch, which is exactly what tier 2 exists to report.
      [{ callers: ["*"], targets: ["$not", "*"], effect: "deny", description: "" }] as never,
      "allow",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await asyncServe(registry as never, { acl: acl as never });
    try {
      const calls = warnSpy.mock.calls.map((args) => String(args[0]));
      const tier2 = calls.find((c) => c.includes("mcp.acl.rules[0]"));
      expect(tier2, `expected a tier-2 warning; got calls: ${JSON.stringify(calls)}`).toBeDefined();
      expect(tier2).toContain("'targets'");
      expect(tier2).toContain("protects nothing");
    } finally {
      await app.close();
    }
  });

  it("logs nothing when every rule is well-formed and matches something", async () => {
    const apcore = await import("apcore-js");
    const registry = new apcore.Registry();
    const acl = new apcore.ACL(
      [{ callers: ["*"], targets: ["*"], effect: "allow", description: "" }] as never,
      "deny",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await asyncServe(registry as never, { acl: acl as never });
    try {
      const calls = warnSpy.mock.calls.map((args) => String(args[0]));
      expect(calls.some((c) => c.includes("mcp.acl.rules"))).toBe(false);
    } finally {
      await app.close();
    }
  });
});
