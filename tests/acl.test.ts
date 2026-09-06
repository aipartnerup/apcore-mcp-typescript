/**
 * Tests for ACL exposure — builder + resolveExecutor wiring.
 *
 * Mirrors tests/test_acl.py in the Python bridge.
 */

import { describe, expect, it, vi } from "vitest";
import { resolveExecutor } from "../src/index.js";
import { buildAclFromConfig } from "../src/acl-builder.js";
import type { Executor, Registry } from "../src/types.js";

// ---------------------------------------------------------------------------
// buildAclFromConfig — unit tests
// ---------------------------------------------------------------------------

describe("buildAclFromConfig()", () => {
  it("returns null for null/undefined/empty", async () => {
    await expect(buildAclFromConfig(null)).resolves.toBeNull();
    await expect(buildAclFromConfig(undefined)).resolves.toBeNull();
    await expect(buildAclFromConfig({})).resolves.toBeNull();
  });

  it("builds an ACL with rules and default_effect=deny", async () => {
    const apcore = await import("apcore-js");
    const acl = await buildAclFromConfig({
      default_effect: "deny",
      rules: [
        { callers: ["role:admin"], targets: ["sys.*"], effect: "allow" },
      ],
    });
    expect(acl).toBeInstanceOf(apcore.ACL);
  });

  it("logs at INFO on success — cross-language parity with Python (A-004)", async () => {
    // The spec's `## Contract: build_acl_from_config` Properties row states
    // "logs at INFO on success" as a cross-language guarantee. Before this
    // fix, only the Python bridge did — TypeScript and Rust were both
    // silent, so an operator debugging via logs saw confirmation on Python
    // only despite an identical config on all three bridges.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await buildAclFromConfig({
        default_effect: "deny",
        rules: [{ callers: ["*"], targets: ["public.*"], effect: "allow" }],
      });
      expect(infoSpy).toHaveBeenCalledTimes(1);
      const message = String(infoSpy.mock.calls[0]?.[0]);
      expect(message).toContain("Built ACL with 1 rule(s)");
      expect(message).toContain("default_effect=deny");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("does not log at INFO when the section is absent (no ACL built)", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await buildAclFromConfig(null);
      expect(infoSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("builds an ACL with default_effect=allow", async () => {
    const apcore = await import("apcore-js");
    const acl = await buildAclFromConfig({
      default_effect: "allow",
      rules: [],
    });
    expect(acl).toBeInstanceOf(apcore.ACL);
  });

  it("defaults default_effect to 'deny' when omitted", async () => {
    const acl = await buildAclFromConfig({
      rules: [{ callers: ["*"], targets: ["public.*"], effect: "allow" }],
    });
    expect(acl).not.toBeNull();
  });

  it("accepts description and conditions on a rule", async () => {
    const apcore = await import("apcore-js");
    const acl = await buildAclFromConfig({
      rules: [
        {
          callers: ["role:admin"],
          targets: ["sys.*"],
          effect: "allow",
          description: "admin access",
          conditions: { identity_types: ["human"] },
        },
      ],
    });
    expect(acl).toBeInstanceOf(apcore.ACL);
  });

  it("throws on invalid default_effect", async () => {
    await expect(
      buildAclFromConfig({ default_effect: "maybe", rules: [] }),
    ).rejects.toThrow(/default_effect must be/);
  });

  it("throws when rule is missing callers", async () => {
    await expect(
      buildAclFromConfig({
        rules: [{ targets: ["x.*"], effect: "allow" }],
      }),
    ).rejects.toThrow(/'callers' must be a non-empty list/);
  });

  it("throws when rule is missing targets", async () => {
    await expect(
      buildAclFromConfig({
        rules: [{ callers: ["*"], effect: "allow" }],
      }),
    ).rejects.toThrow(/'targets' must be a non-empty list/);
  });

  it("throws on invalid effect value", async () => {
    await expect(
      buildAclFromConfig({
        rules: [{ callers: ["*"], targets: ["*"], effect: "maybe" }],
      }),
    ).rejects.toThrow(/'effect' must be 'allow' or 'deny'/);
  });

  it("throws on unknown rule keys", async () => {
    await expect(
      buildAclFromConfig({
        rules: [
          {
            callers: ["*"],
            targets: ["*"],
            effect: "allow",
            bogus: true,
          },
        ],
      }),
    ).rejects.toThrow(/unexpected keys/);
  });

  it("throws when top-level is not an object", async () => {
    await expect(buildAclFromConfig("deny")).rejects.toThrow(
      /mcp\.acl must be a mapping/,
    );
  });

  it("throws when rules is not an array", async () => {
    await expect(
      buildAclFromConfig({ rules: "oops" }),
    ).rejects.toThrow(/mcp\.acl\.rules must be a list/);
  });
});

// ---------------------------------------------------------------------------
// resolveExecutor — acl wiring
// ---------------------------------------------------------------------------

describe("resolveExecutor() acl option", () => {
  function makeExecutor(registry: Registry): Executor & {
    installedAcl: unknown | null;
    setAcl: (acl: unknown) => void;
    used: unknown[];
    use: (mw: unknown) => unknown;
  } {
    return {
      registry,
      call: vi.fn().mockResolvedValue({}),
      used: [] as unknown[],
      installedAcl: null as unknown | null,
      use(mw: unknown) {
        (this as unknown as { used: unknown[] }).used.push(mw);
        return this;
      },
      setAcl(acl: unknown) {
        (this as unknown as { installedAcl: unknown }).installedAcl = acl;
      },
    } as unknown as Executor & {
      installedAcl: unknown | null;
      setAcl: (acl: unknown) => void;
      used: unknown[];
      use: (mw: unknown) => unknown;
    };
  }

  it("installs ACL on a pre-existing Executor", async () => {
    const registry: Registry = {
      list: () => [],
      getDefinition: () => null,
      on: vi.fn(),
    };
    const executor = makeExecutor(registry);
    const acl = { __marker: "acl" };

    await resolveExecutor(executor, { acl });

    expect(executor.installedAcl).toBe(acl);
  });

  it("leaves ACL alone when omitted", async () => {
    const registry: Registry = {
      list: () => [],
      getDefinition: () => null,
      on: vi.fn(),
    };
    const executor = makeExecutor(registry);
    await resolveExecutor(executor);
    expect(executor.installedAcl).toBeNull();
  });

  it("throws when executor lacks .setAcl()", async () => {
    const registry: Registry = {
      list: () => [],
      getDefinition: () => null,
      on: vi.fn(),
    };
    const executor: Executor = {
      registry,
      call: vi.fn(),
    };

    await expect(
      resolveExecutor(executor, { acl: { __marker: "acl" } }),
    ).rejects.toThrow(/does not support \.setAcl\(\)/);
  });
});
