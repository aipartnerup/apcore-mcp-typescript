/**
 * End-to-end: an ACL-sourced approval requirement gates a real MCP tools/call.
 *
 * Every other `approval` test in this repo stops at the Config Bus parsing
 * layer — they prove the key is *accepted*, not that it *does* anything. This
 * file closes that gap by driving a real `apcore-js` `Executor` (real `ACL`,
 * real approval handler, real module) through `ExecutionRouter.handleCall`,
 * which is the exact path a `tools/call` takes.
 *
 * What is pinned here is the claim this bridge's 0.19.0 CHANGELOG makes —
 * "gating the call on a human decision even though the ACL itself allows it" —
 * at the MCP boundary rather than inside apcore:
 *
 * - the module's own `requiresApproval` annotation is **false**, so the ACL
 *   rule is the only possible source of an approval requirement;
 * - the rule is argument-scoped (`conditions.arguments.has_key`), so the same
 *   module is gated or not depending on what the call carries.
 *
 * Cross-language counterparts: `tests/test_acl_approval_gating_e2e.py`
 * (Python) and `tests/acl_approval_gating_e2e.rs` (Rust).
 */

import { describe, expect, it } from "vitest";
import { ExecutionRouter } from "../src/server/router.js";

const MODULE_ID = "files.delete";

/** A module that asks for no approval on its own account. */
class DeleteModule {
  readonly description = "Delete a path";
  // Deliberately false: any approval requirement observed in these tests can
  // only have come from the ACL rule, which is the whole point.
  readonly annotations = {
    requiresApproval: false,
    destructive: true,
    readonly: false,
    idempotent: false,
    openWorld: false,
    streaming: false,
    extra: {},
  };
  readonly inputSchema = {
    type: "object",
    properties: { path: { type: "string" }, recursive: { type: "boolean" } },
    required: ["path"],
  } as unknown as never;
  readonly outputSchema = {
    type: "object",
    properties: { deleted: { type: "string" } },
  } as unknown as never;

  execute(inputs: Record<string, unknown>): Record<string, unknown> {
    return { deleted: String(inputs.path) };
  }
}

/** Approves everything, but records what it was asked about. */
class RecordingApprovalHandler {
  readonly requests: Array<{ moduleId: string }> = [];

  async requestApproval(request: { moduleId: string }): Promise<unknown> {
    this.requests.push({ moduleId: request.moduleId });
    return { status: "approved", approvedBy: "test", approvalId: "test-approval" };
  }

  async checkApproval(approvalId: string): Promise<unknown> {
    return { status: "approved", approvedBy: "test", approvalId };
  }
}

/** A real executor whose only approval source is an argument-scoped ACL rule. */
async function buildRouter(): Promise<{
  router: ExecutionRouter;
  handler: RecordingApprovalHandler;
}> {
  const apcore = await import("apcore-js");

  const registry = new apcore.Registry();
  registry.register(MODULE_ID, new DeleteModule() as never);

  const acl = new apcore.ACL(
    [
      // Narrow rule first (first-match-wins, PROTOCOL_SPEC §6.3): a recursive
      // delete is allowed but must be put to a human.
      {
        callers: ["*"],
        targets: [MODULE_ID],
        effect: "allow",
        approval: "required",
        conditions: { arguments: { has_key: ["recursive"] } },
      },
      // Broad rule: everything else this caller does is allowed outright.
      { callers: ["*"], targets: ["*"], effect: "allow" },
    ] as never,
    "deny",
  );

  const handler = new RecordingApprovalHandler();
  const executor = new apcore.Executor({
    registry,
    acl,
    approvalHandler: handler as never,
  });

  return { router: new ExecutionRouter(executor as never), handler };
}

describe("ACL-sourced approval gating over a real tools/call", () => {
  it("gates a call that matches the argument-scoped rule", async () => {
    const { router, handler } = await buildRouter();

    const [content, isError] = await router.handleCall(MODULE_ID, {
      path: "/tmp/x",
      recursive: true,
    });

    expect(isError, `approved call should succeed, got: ${JSON.stringify(content)}`).toBe(false);
    expect(
      handler.requests.length,
      "a call carrying `recursive` matches the rule's conditions.arguments.has_key and MUST reach the approval handler",
    ).toBe(1);
    expect(handler.requests[0].moduleId).toBe(MODULE_ID);
  });

  it("does not gate a call that does not match the rule", async () => {
    const { router, handler } = await buildRouter();

    const [content, isError] = await router.handleCall(MODULE_ID, { path: "/tmp/x" });

    expect(isError, `ungated call should succeed, got: ${JSON.stringify(content)}`).toBe(false);
    expect(
      handler.requests,
      "a call without `recursive` does not match the approval rule and MUST NOT be put to a human — gating it would be the over-refusal §6.1.7 exists to prevent",
    ).toEqual([]);
  });
});
