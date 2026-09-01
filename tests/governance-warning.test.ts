/**
 * Tests for `formatUnprotectedControlSurfaceWarning()` — the startup
 * warning for aiperceivable/apcore-mcp#15(b): `system.control.*` write
 * modules registered and reachable via `tools/call` with no recognised
 * gate in front of them.
 *
 * `Executor.governanceState()` itself (apcore-js>=0.28.0,
 * `unprotectedControlSurface`) is apcore-typescript's responsibility — this
 * only tests the pure, side-effect-free formatting function that consumes
 * its result.
 */

import { describe, expect, it } from "vitest";
import { formatUnprotectedControlSurfaceWarning } from "../src/index.js";

interface GovernanceStateLike {
  controlModulesRegistered: boolean;
  readModulesRegistered: boolean;
  aclConfigured: boolean;
  builtinAclGateWired: boolean;
  approvalHandlerConfigured: boolean;
  builtinApprovalGateWired: boolean;
  policyStrict: boolean;
  allControlModulesRequireApproval: boolean;
  unprotectedControlSurface: boolean;
}

function fullyProtectedState(overrides: Partial<GovernanceStateLike> = {}): GovernanceStateLike {
  return {
    controlModulesRegistered: true,
    readModulesRegistered: true,
    aclConfigured: true,
    builtinAclGateWired: true,
    approvalHandlerConfigured: true,
    builtinApprovalGateWired: true,
    policyStrict: false,
    allControlModulesRequireApproval: true,
    unprotectedControlSurface: false,
    ...overrides,
  };
}

describe("formatUnprotectedControlSurfaceWarning()", () => {
  it("returns null when unprotectedControlSurface is false", () => {
    expect(formatUnprotectedControlSurfaceWarning(fullyProtectedState())).toBeNull();
  });

  it("returns null when no control modules are registered at all, even if other flags are false", () => {
    // governanceState() itself only sets unprotectedControlSurface=true when
    // controlModulesRegistered is true — mirror that invariant here.
    expect(
      formatUnprotectedControlSurfaceWarning(
        fullyProtectedState({
          controlModulesRegistered: false,
          aclConfigured: false,
          unprotectedControlSurface: false,
        }),
      ),
    ).toBeNull();
  });

  it("names 'no ACL configured' when aclConfigured is false", () => {
    const warning = formatUnprotectedControlSurfaceWarning(
      fullyProtectedState({
        aclConfigured: false,
        builtinAclGateWired: false,
        unprotectedControlSurface: true,
      }),
    );
    expect(warning).not.toBeNull();
    expect(warning).toContain("No ACL is configured");
  });

  it("names 'ACL configured but built-in gate not wired' when aclConfigured but not builtinAclGateWired", () => {
    const warning = formatUnprotectedControlSurfaceWarning(
      fullyProtectedState({
        aclConfigured: true,
        builtinAclGateWired: false,
        unprotectedControlSurface: true,
      }),
    );
    expect(warning).toContain("does not include the built-in ACL gate");
  });

  it("names 'built-in approval gate not wired' when builtinApprovalGateWired is false", () => {
    const warning = formatUnprotectedControlSurfaceWarning(
      fullyProtectedState({
        builtinApprovalGateWired: false,
        unprotectedControlSurface: true,
      }),
    );
    expect(warning).toContain("does not include the built-in approval gate");
  });

  it("names 'not all control modules require approval' when allControlModulesRequireApproval is false", () => {
    const warning = formatUnprotectedControlSurfaceWarning(
      fullyProtectedState({
        allControlModulesRequireApproval: false,
        unprotectedControlSurface: true,
      }),
    );
    expect(warning).toContain("Not every registered system.control.* module declares requiresApproval");
  });

  it("names 'no approval handler and not strict' when neither approvalHandlerConfigured nor policyStrict", () => {
    const warning = formatUnprotectedControlSurfaceWarning(
      fullyProtectedState({
        approvalHandlerConfigured: false,
        policyStrict: false,
        unprotectedControlSurface: true,
      }),
    );
    expect(warning).toContain("No ApprovalHandler is configured");
  });

  it("does not flag the approval-handler gap when policyStrict is true even without a handler", () => {
    const warning = formatUnprotectedControlSurfaceWarning(
      fullyProtectedState({
        approvalHandlerConfigured: false,
        policyStrict: true,
        unprotectedControlSurface: true,
        // Force a different gap to be true so unprotectedControlSurface's
        // truthiness is internally consistent with *some* gap existing.
        aclConfigured: false,
      }),
    );
    expect(warning).not.toContain("No ApprovalHandler is configured");
  });

  it("includes concrete remediation guidance (ACL, ApprovalHandler, strict policy)", () => {
    const warning = formatUnprotectedControlSurfaceWarning(
      fullyProtectedState({ aclConfigured: false, unprotectedControlSurface: true }),
    );
    expect(warning).toContain("acl");
    expect(warning).toContain("ApprovalHandler");
    expect(warning).toContain("ExecutionPolicy({ strict: true })");
  });

  it("names system.control.* explicitly", () => {
    const warning = formatUnprotectedControlSurfaceWarning(
      fullyProtectedState({ aclConfigured: false, unprotectedControlSurface: true }),
    );
    expect(warning).toContain("system.control.update_config");
  });

  it("states the server will still start (warning only)", () => {
    const warning = formatUnprotectedControlSurfaceWarning(
      fullyProtectedState({ aclConfigured: false, unprotectedControlSurface: true }),
    );
    expect(warning).toMatch(/warning only/i);
  });
});
