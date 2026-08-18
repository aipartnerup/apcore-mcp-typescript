/**
 * ElicitationApprovalHandler: bridges MCP elicitation to apcore's approval system.
 *
 * Uses the MCP elicit callback (injected into Context.data) to present
 * approval requests to the human user via the MCP client.
 */

import { randomUUID } from "crypto";
import { MCP_ELICIT_KEY } from "../helpers.js";
import type { ApprovalStore } from "../approval-store.js";

export interface ApprovalRequest {
  moduleId: string;
  description?: string | null;
  arguments: Record<string, unknown>;
  context?: { data?: Record<string, unknown> } | null;
}

export interface ApprovalResult {
  status: "approved" | "rejected" | "timeout" | "pending";
  /** Human-readable explanation. Never used to carry the approval id. */
  reason?: string | null;
  /**
   * Identifier of a pending approval, echoed back by the agent as
   * `_meta.approvalId` and polled via `__apcore_approval_check`.
   *
   * [A-D-AP-1] Matches apcore-js `ApprovalResult.approvalId`, Python's
   * `ApprovalResult(approval_id=...)` and Rust's `result.approval_id`. It was
   * previously smuggled through `reason`, which left the field this repo's own
   * ApprovalBridge reads (`{status; reason?; approvalId?}`) undefined.
   */
  approvalId?: string;
}

/**
 * JSON Schema (MCP elicitation requestedSchema) for a yes/no approval prompt.
 * A boolean gives form-rendering clients (Cursor, Codex, ...) a concrete control
 * to display; an empty schema is tolerated by minimal SDK clients but
 * ignored/rejected by form-rendering clients, so the request returns no response
 * and the gate fails closed.
 */
const APPROVAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  title: "Approval required",
  properties: {
    approve: {
      type: "boolean",
      title: "Approve this action?",
      description: "Select yes to allow the operation to proceed.",
    },
  },
  required: ["approve"],
};

export class ElicitationApprovalHandler {
  /**
   * Request approval via MCP elicitation.
   *
   * Extracts the elicit callback from request.context.data, builds
   * an approval message, and maps the elicit response to an ApprovalResult.
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    const data = request.context?.data ?? null;
    if (data === null) {
      return { status: "rejected", reason: "No context available for elicitation" };
    }

    const elicitCallback = data[MCP_ELICIT_KEY] as
      | ((
          message: string,
          requestedSchema?: Record<string, unknown>,
        ) => Promise<{ action: string; content?: Record<string, unknown> } | null>)
      | undefined;

    if (!elicitCallback) {
      return { status: "rejected", reason: "No elicitation callback available" };
    }

    const message =
      `Approval required for tool: ${request.moduleId}\n\n` +
      `${request.description ?? ""}\n\n` +
      `Arguments: ${JSON.stringify(request.arguments)}`;

    let result: { action: string; content?: Record<string, unknown> } | null;
    try {
      // Send a non-empty schema so form-rendering clients can display an
      // approve/deny control; an empty schema is silently dropped by them.
      result = await elicitCallback(message, APPROVAL_SCHEMA);
    } catch {
      return { status: "rejected", reason: "Elicitation request failed" };
    }

    if (result === null || result === undefined) {
      return { status: "rejected", reason: "Elicitation returned no response" };
    }

    if (result.action !== "accept") {
      return { status: "rejected", reason: `User action: ${result.action}` };
    }

    // action === "accept": honor an explicit approve=false from the form;
    // clients that render no field send none, so accept itself means approval.
    const content = result.content;
    const approve =
      content && typeof content.approve !== "undefined" ? Boolean(content.approve) : true;
    if (!approve) {
      return { status: "rejected", reason: "User declined approval" };
    }
    return { status: "approved" };
  }

  /**
   * Check status of an existing approval.
   *
   * Phase B (async polling) is not supported via MCP elicitation since
   * elicitation is stateless.
   */
  async checkApproval(_approvalId: string): Promise<ApprovalResult> {
    return { status: "rejected", reason: "Phase B not supported via MCP elicitation" };
  }
}

/**
 * Phase B approval handler backed by a pluggable ApprovalStore.
 *
 * requestApproval() saves a pending record and returns a pending ApprovalResult
 * causing apcore to raise ApprovalPendingError → APPROVAL_PENDING in MCP envelope.
 * checkApproval() reads the store; called by apcore when client retries with
 * _meta.approvalId set.
 *
 * notifyCallback lets callers fan out to Slack/email/webhooks.
 * Signature: (approvalId: string, moduleId: string, arguments: Record<string, unknown>) => Promise<void>
 */
export class StorageBackedApprovalHandler {
  private readonly store: ApprovalStore;
  private readonly notifyCallback?: (approvalId: string, moduleId: string, args: Record<string, unknown>) => Promise<void>;

  constructor(
    store: ApprovalStore,
    options: {
      notifyCallback?: (approvalId: string, moduleId: string, args: Record<string, unknown>) => Promise<void>;
    } = {}
  ) {
    this.store = store;
    this.notifyCallback = options.notifyCallback;
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    const approvalId = randomUUID();
    const moduleId = request.moduleId ?? "unknown";
    const args = request.arguments ?? {};

    await this.store.savePending(approvalId, moduleId, args);

    if (this.notifyCallback) {
      try {
        await this.notifyCallback(approvalId, moduleId, args);
      } catch (err) {
        // log but don't fail the approval request
        console.warn(`[apcore-mcp] notifyCallback raised for approval ${approvalId}:`, err);
      }
    }

    return { status: "pending", approvalId };
  }

  async checkApproval(approvalId: string): Promise<ApprovalResult> {
    const record = await this.store.getResult(approvalId);
    if (!record) {
      return { status: "rejected", reason: "approval_id not found" };
    }
    if (record.status === "approved") {
      return { status: "approved" };
    }
    if (record.status === "rejected") {
      return { status: "rejected", reason: record.reason ?? undefined };
    }
    // [A-D-AP-1] Echo the id on the pending path, matching Python
    // (approval.py: ApprovalResult(status="pending", approval_id=approval_id)).
    return { status: "pending", approvalId };
  }
}
