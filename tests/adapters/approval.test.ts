import { describe, it, expect, vi } from "vitest";
import {
  ElicitationApprovalHandler,
  StorageBackedApprovalHandler,
} from "../../src/adapters/approval.js";
import { InMemoryApprovalStore } from "../../src/approval-store.js";
import { MCP_ELICIT_KEY } from "../../src/helpers.js";

describe("ElicitationApprovalHandler", () => {
  const handler = new ElicitationApprovalHandler();

  it("returns rejected when context is null", async () => {
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: null,
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("No context");
  });

  it("returns rejected when context.data is missing", async () => {
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: {},
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("No context");
  });

  it("returns rejected when elicit callback is absent", async () => {
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: {} },
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("No elicitation callback");
  });

  it("returns approved when elicit callback returns accept", async () => {
    const elicitFn = vi.fn().mockResolvedValue({ action: "accept" });
    const result = await handler.requestApproval({
      moduleId: "test.module",
      description: "Run the test",
      arguments: { key: "value" },
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("approved");
    expect(elicitFn).toHaveBeenCalledTimes(1);
    const message = elicitFn.mock.calls[0][0] as string;
    expect(message).toContain("test.module");
    expect(message).toContain("Run the test");
    expect(message).toContain("key");
  });

  it("returns rejected when elicit callback returns decline", async () => {
    const elicitFn = vi.fn().mockResolvedValue({ action: "decline" });
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("decline");
  });

  it("returns rejected when elicit callback returns cancel", async () => {
    const elicitFn = vi.fn().mockResolvedValue({ action: "cancel" });
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("cancel");
  });

  it("returns rejected when elicit callback returns null", async () => {
    const elicitFn = vi.fn().mockResolvedValue(null);
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("no response");
  });

  it("returns rejected when elicit callback throws", async () => {
    const elicitFn = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("failed");
  });

  it("sends a non-empty approval schema to the elicit callback", async () => {
    const elicitFn = vi.fn().mockResolvedValue({ action: "accept", content: {} });
    await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(elicitFn).toHaveBeenCalledTimes(1);
    const schema = elicitFn.mock.calls[0][1] as Record<string, unknown>;
    expect(schema).toBeTruthy();
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("approve");
  });

  it("returns rejected when accept carries content.approve=false", async () => {
    const elicitFn = vi.fn().mockResolvedValue({ action: "accept", content: { approve: false } });
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("rejected");
  });

  it("returns approved when accept carries content.approve=true", async () => {
    const elicitFn = vi.fn().mockResolvedValue({ action: "accept", content: { approve: true } });
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("approved");
  });

  it("checkApproval always returns rejected (Phase B not supported)", async () => {
    const result = await handler.checkApproval("some-id");

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("Phase B");
  });
});

describe("StorageBackedApprovalHandler", () => {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it("[A-D-AP-1] returns the approval id in approvalId, not in reason", async () => {
    const store = new InMemoryApprovalStore();
    try {
      const handler = new StorageBackedApprovalHandler(store);

      const result = await handler.requestApproval({
        moduleId: "test.module",
        arguments: { x: 1 },
      });

      expect(result.status).toBe("pending");
      // Python returns ApprovalResult(status="pending", approval_id=...) and Rust
      // sets result.approval_id; `reason` is human-readable text in all three.
      expect(result.approvalId).toMatch(UUID_RE);
      expect(result.reason ?? undefined).toBeUndefined();

      // The id must address the record the handler actually persisted.
      const record = await store.getResult(result.approvalId!);
      expect(record).not.toBeNull();
      expect(record!.moduleId).toBe("test.module");
    } finally {
      store.stop();
    }
  });

  it("[A-D-AP-1] checkApproval echoes approvalId while still pending", async () => {
    const store = new InMemoryApprovalStore();
    try {
      const handler = new StorageBackedApprovalHandler(store);
      const pending = await handler.requestApproval({
        moduleId: "test.module",
        arguments: {},
      });

      const checked = await handler.checkApproval(pending.approvalId!);

      expect(checked.status).toBe("pending");
      expect(checked.approvalId).toBe(pending.approvalId);
    } finally {
      store.stop();
    }
  });

  it("checkApproval carries the rejection reason, not an id", async () => {
    const store = new InMemoryApprovalStore();
    try {
      const handler = new StorageBackedApprovalHandler(store);
      const pending = await handler.requestApproval({
        moduleId: "test.module",
        arguments: {},
      });
      await store.resolve(pending.approvalId!, {
        approved: false,
        reason: "denied by operator",
      });

      const checked = await handler.checkApproval(pending.approvalId!);

      expect(checked.status).toBe("rejected");
      expect(checked.reason).toBe("denied by operator");
    } finally {
      store.stop();
    }
  });
});
