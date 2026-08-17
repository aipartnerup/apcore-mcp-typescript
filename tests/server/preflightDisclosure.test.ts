/**
 * `__apcore_module_preview` must not disclose module introspection to a caller
 * the ACL denied — apcore PROTOCOL_SPEC §12.8.5.1 (spec v1.13.0, apcore#96).
 *
 * `Module.preflight()` and `Module.preview()` are module-authored code, and what
 * they return names what the call would do: for a command-wrapping module the
 * resolved binary and its argv, for a writer the target of the side effect. This
 * bridge serialises `Executor.validate()`'s `PreflightResult` verbatim, so
 * whatever `validate()` puts in `checks` / `predictedChanges` reaches the MCP
 * caller. Before apcore-js 0.27.0 `validate()` gated those hooks on module
 * lookup alone — Step 3 — while the ACL check is Step 4, so a denied caller ran
 * module code and got back what it said.
 *
 * These tests drive a REAL `Executor` over a REAL `Registry` and a REAL `ACL`.
 * A mocked executor would assert nothing: the gate lives inside `validate()`.
 *
 * Two of the six cases are deliberately not denial cases. The allowed-caller
 * control exists because without it a bridge that never surfaced introspection
 * at all would pass every denial case for entirely the wrong reason; the
 * schema-failure case exists because the rule is about AUTHORIZATION, not
 * validity — a caller the ACL permits is entitled to the module's account of
 * what would happen even when its inputs are malformed, which is what it needs
 * in order to fix the call.
 *
 * Mirrors `conformance/fixtures/preflight_disclosure.json` in the apcore spec
 * repo, which pins the same four shapes on the SDKs themselves.
 */

import { describe, expect, it } from "vitest";
import {
  AsyncTaskBridge,
  META_TOOL_NAMES,
  type AsyncTaskManagerLike,
  type ExecutorLike,
} from "../../src/server/async-task-bridge.js";

// Sentinels chosen so that a plain substring search over the serialised
// envelope is a sufficient leak assertion: neither string can arise from any
// value the Executor computes on its own.
const SENTINEL_BINARY = "/opt/apcore-sentinel-9f2c/bin/rm";
const SENTINEL_TARGET = "/srv/customer-data-9f2c1e";

const MODULE_ID = "danger.wipe";

/**
 * A destructive module whose introspection hooks name the binary and the path.
 *
 * `hooksInvoked` is recorded inside the hook bodies rather than inferred from
 * the absent check entries: an implementation that runs the hooks and then
 * discards their output has still run module-authored code on behalf of a
 * caller the ACL denied, which is the side-effect half of the requirement.
 */
class SentinelModule {
  readonly hooksInvoked: string[] = [];

  readonly description = "Deletes a directory tree";
  // Annotated so the `requires_approval` case below has something to report.
  // Governance annotations are metadata the ACL never reads, which is exactly
  // why they survive a denial — see that test.
  readonly annotations = {
    requiresApproval: true,
    destructive: true,
    readonly: false,
    idempotent: false,
    openWorld: false,
    streaming: false,
    extra: {},
  };
  readonly inputSchema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  } as unknown as never;
  readonly outputSchema = {
    type: "object",
    properties: { removed: { type: "boolean" } },
  } as unknown as never;

  execute(): Record<string, unknown> {
    throw new Error("validate() must never execute the module body");
  }

  preflight(): string[] {
    this.hooksInvoked.push("preflight");
    return [`would run ${SENTINEL_BINARY} -rf ${SENTINEL_TARGET}`];
  }

  preview(): { changes: Array<Record<string, unknown>> } {
    this.hooksInvoked.push("preview");
    return {
      changes: [
        {
          action: "delete",
          target: SENTINEL_TARGET,
          summary: `${SENTINEL_BINARY} -rf ${SENTINEL_TARGET}`,
        },
      ],
    };
  }
}

/** The bridge's meta-tools other than PREVIEW are unused here. */
function stubManager(): AsyncTaskManagerLike {
  return {
    submit: async () => "unused",
    getStatus: () => null,
    getResult: () => ({}),
    cancel: async () => false,
    listTasks: () => [],
  };
}

interface PreviewEnvelope {
  valid: boolean;
  requires_approval: boolean;
  predicted_changes: Array<Record<string, unknown>>;
  checks: Array<{ check: string; passed: boolean; warnings?: string[] }>;
}

/**
 * Drive the preview meta-tool over a real Executor.
 *
 * The rule's `effect` is what separates a permitted caller from a denied one,
 * matching the spec fixture: a bridge-built `Context` is always top-level, and
 * apcore-js reserves `Context.callerId` for `child()`, so every MCP caller
 * reaches the ACL as `@external` and `callers: ["*"]` is what a real deployment
 * matches on.
 */
async function preview(options: {
  effect: "allow" | "deny";
  inputs: Record<string, unknown>;
}): Promise<{ envelope: PreviewEnvelope; module: SentinelModule }> {
  const apcore = await import("apcore-js");

  const registry = new apcore.Registry();
  const module = new SentinelModule();
  registry.register(MODULE_ID, module);

  const acl = new apcore.ACL(
    [{ callers: ["*"], targets: [MODULE_ID], effect: options.effect }],
    options.effect === "deny" ? "allow" : "deny",
  );
  const executor = new apcore.Executor({ registry, acl });
  const context = apcore.Context.create(
    apcore.createIdentity("mcp.caller", "module"),
  );

  const bridge = new AsyncTaskBridge(stubManager(), {
    executor: executor as unknown as ExecutorLike,
  });
  const envelope = (await bridge.handleMetaTool(
    META_TOOL_NAMES.PREVIEW,
    { module_id: MODULE_ID, arguments: options.inputs },
    context,
  )) as unknown as PreviewEnvelope;

  return { envelope, module };
}

const previewDenied = (): ReturnType<typeof preview> =>
  preview({ effect: "deny", inputs: { path: SENTINEL_TARGET } });

function checkNames(envelope: PreviewEnvelope): string[] {
  return envelope.checks.map((c) => c.check);
}

function failedCheckNames(envelope: PreviewEnvelope): string[] {
  return envelope.checks.filter((c) => !c.passed).map((c) => c.check);
}

describe("__apcore_module_preview disclosure gate (PROTOCOL_SPEC §12.8.5.1)", () => {
  it("withholds predicted_changes from a caller the ACL denied", async () => {
    const { envelope } = await previewDenied();

    expect(envelope.valid).toBe(false);
    expect(envelope.predicted_changes).toEqual([]);
  });

  it("emits no module_preflight / module_preview check to a denied caller", async () => {
    const { envelope } = await previewDenied();

    // Absent entirely, not present-and-empty: the presence of the entry is
    // itself the disclosure that the module implements the hook.
    expect(checkNames(envelope)).not.toContain("module_preflight");
    expect(checkNames(envelope)).not.toContain("module_preview");
  });

  it("leaks no substring of the binary or argv to a denied caller", async () => {
    const { envelope } = await previewDenied();

    // The whole envelope, not just the fields checked above: a leak through a
    // check's `warnings` or an ACL diagnostic is the same leak.
    const wire = JSON.stringify(envelope);
    expect(wire).not.toContain(SENTINEL_BINARY);
    expect(wire).not.toContain(SENTINEL_TARGET);
  });

  it("never runs the module's hooks for a denied caller", async () => {
    const { module } = await previewDenied();

    expect(module.hooksInvoked).toEqual([]);
  });

  it("still tells a denied caller that the acl check is the only failure", async () => {
    const { envelope } = await previewDenied();

    // §12.8.5.1 withholds introspection, not the denial reason. Exactly one
    // failure, because a second failed check could itself carry module detail.
    expect(failedCheckNames(envelope)).toEqual(["acl"]);
  });

  it("CONTROL: an allowed caller still receives the full preview", async () => {
    // Without this case the five above are satisfiable by a bridge that never
    // surfaces introspection at all.
    const { envelope, module } = await preview({
      effect: "allow",
      inputs: { path: SENTINEL_TARGET },
    });

    expect(envelope.valid).toBe(true);
    expect(module.hooksInvoked).toEqual(["preflight", "preview"]);
    expect(checkNames(envelope)).toContain("module_preflight");
    expect(checkNames(envelope)).toContain("module_preview");
    expect(envelope.predicted_changes).toHaveLength(1);
    expect(envelope.predicted_changes[0]?.target).toBe(SENTINEL_TARGET);
    expect(JSON.stringify(envelope)).toContain(SENTINEL_BINARY);
  });

  it("reports requires_approval=true to a denied caller (cross-SDK divergence)", async () => {
    // Deliberate, and pinned because apcore-mcp-rust diverges here.
    //
    // §12.8.5.1 withholds MODULE-AUTHORED introspection — what `preflight()`
    // and `preview()` computed. `requires_approval` is neither: apcore-js
    // resolves it from the module's declared annotations (or the
    // ExecutionPolicy) at a point before the disclosure gate, and the fixture
    // `preflight_disclosure.json` deliberately asserts nothing about it.
    //
    // It is also not much of a disclosure: it says the module is
    // approval-gated, not what the call would touch. Zeroing it would cost a
    // denied caller the ability to distinguish "denied" from "denied AND would
    // have needed approval anyway".
    const { envelope } = await previewDenied();

    expect(envelope.requires_approval).toBe(true);
    // ...while still disclosing nothing the module computed.
    expect(envelope.predicted_changes).toEqual([]);
  });

  it("a schema failure alone does NOT withhold the preview", async () => {
    // The gate is scoped to authorization. A permitted caller whose inputs are
    // malformed still gets the module's account of what would happen.
    const { envelope, module } = await preview({
      effect: "allow",
      inputs: {},
    });

    expect(envelope.valid).toBe(false);
    expect(failedCheckNames(envelope)).toEqual(["schema"]);
    expect(module.hooksInvoked).toEqual(["preflight", "preview"]);
    expect(checkNames(envelope)).toContain("module_preview");
    expect(envelope.predicted_changes).toHaveLength(1);
  });
});
