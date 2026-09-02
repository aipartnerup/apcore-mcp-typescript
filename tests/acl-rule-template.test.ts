/**
 * Tests for the ACL rule template shipped in `src/acl-builder.ts`'s doc
 * comment (aiperceivable/apcore-mcp#14) and the `approval` rule field
 * (apcore 0.28.0, PROTOCOL_SPEC §6.1.6).
 *
 * The template asserts against module ids produced by a REAL
 * `registerSysModules()` call (apcore-js), not a hand-written list — so a
 * future rename of a `system.*` module id fails this test instead of
 * silently drifting from the template again (the exact failure mode
 * aiperceivable/apcore-mcp#14 exists to close).
 */

import { describe, expect, it } from "vitest";
import { buildAclFromConfig } from "../src/acl-builder.js";

// ---------------------------------------------------------------------------
// The template's `targets` patterns, kept in sync with the doc comment in
// src/acl-builder.ts and the copy in aiperceivable/apcore-mcp#14's issue body.
// ---------------------------------------------------------------------------

const TEMPLATE_TARGET_PATTERNS = [
  "system.health.*",
  "system.usage.*",
  "system.manifest.*",
  "system.control.*",
];

describe("ACL rule template targets match registered system.* module ids", () => {
  it("every targets pattern in the shipped template matches at least one id registerSysModules() actually registers", async () => {
    const apcore = (await import("apcore-js")) as unknown as {
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

    const registry = new apcore.Registry();
    const executor = new apcore.Executor({ registry });
    // sys_modules.events.enabled=true so the three system.control.* write
    // modules register too (registration.ts gates them behind the events
    // branch) — otherwise only the six read modules would exist and the
    // "system.control.*" pattern would match nothing, silently.
    const config = new apcore.Config({
      sys_modules: { enabled: true, events: { enabled: true } },
    });
    apcore.registerSysModules(registry, executor, config, null);

    const registeredIds: string[] = registry.list({ visibility: ["public", "hidden"] });
    expect(registeredIds.length).toBeGreaterThan(0);

    for (const pattern of TEMPLATE_TARGET_PATTERNS) {
      expect(pattern.endsWith("*"), `pattern "${pattern}" must be a prefix pattern`).toBe(true);
      const prefix = pattern.slice(0, -1);
      const matched = registeredIds.some((id) => id.startsWith(prefix));
      expect(
        matched,
        `targets pattern "${pattern}" matched none of the registered module ` +
          `ids [${registeredIds.join(", ")}]`,
      ).toBe(true);
    }
  });

  it("documents no bare sys.* pattern, which would match nothing", () => {
    for (const pattern of TEMPLATE_TARGET_PATTERNS) {
      expect(pattern.startsWith("system.")).toBe(true);
      expect(pattern.startsWith("sys.")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// approval rule field (apcore 0.28.0 argument-scoped approval)
// ---------------------------------------------------------------------------

describe("buildAclFromConfig() approval field", () => {
  it("accepts a rule with approval: 'required' without throwing", async () => {
    const apcore = await import("apcore-js");
    const acl = await buildAclFromConfig({
      default_effect: "deny",
      rules: [
        {
          callers: ["@external"],
          targets: ["system.control.*"],
          effect: "allow",
          approval: "required",
          conditions: { identity_types: ["human"] },
        },
      ],
    });
    expect(acl).toBeInstanceOf(apcore.ACL);
  });

  it("omitting approval still builds an ACL (unchanged default behaviour)", async () => {
    const apcore = await import("apcore-js");
    const acl = await buildAclFromConfig({
      rules: [{ callers: ["*"], targets: ["public.*"], effect: "allow" }],
    });
    expect(acl).toBeInstanceOf(apcore.ACL);
  });

  it("accepts approval: 'not_required' — the same closed set apcore-js accepts", async () => {
    // Rejecting this was a real portability break: `not_required` is
    // spec-sanctioned (PROTOCOL_SPEC §6.1.6) and is apcore-js's own default,
    // so a rule that loads from apcore's `acl/` directory MUST also load
    // through the Config Bus. The bridge must not narrow its upstream schema.
    const apcore = await import("apcore-js");
    const acl = await buildAclFromConfig({
      rules: [
        {
          callers: ["*"],
          targets: ["public.*"],
          effect: "allow",
          approval: "not_required",
        },
      ],
    });
    expect(acl).toBeInstanceOf(apcore.ACL);
  });

  it("rejects an approval value outside the closed set", async () => {
    await expect(
      buildAclFromConfig({
        rules: [
          {
            callers: ["*"],
            targets: ["public.*"],
            effect: "allow",
            approval: "sometimes",
          },
        ],
      }),
    ).rejects.toThrow(/'approval' must be 'required' or 'not_required'/);
  });

  it("no longer rejects the 'approval' key as unknown", async () => {
    // Before the fix, ALLOWED_RULE_KEYS lacked "approval" and this threw
    // "got unexpected keys: approval".
    await expect(
      buildAclFromConfig({
        rules: [
          {
            callers: ["@external"],
            targets: ["system.control.*"],
            effect: "allow",
            approval: "required",
          },
        ],
      }),
    ).resolves.not.toBeNull();
  });
});
