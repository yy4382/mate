import type { WorkspaceOperation } from "@mate/protocol";
import { workspaceReceiptRequestHash } from "@mate/protocol/node";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MessageWriter } from "../../conversations/messages/writer.js";
import type { NodeOperations } from "../../nodes/operations.js";
import { AgentSession } from "../../runtime/session/service.js";
import { defineAgentTool, type AgentToolContext } from "../../runtime/tools/entry.js";
import { operationIdForAction } from "../../runtime/tools/identity.js";
import type { WorkspaceAccess } from "../access/service.js";
import { WorkspaceError } from "../errors.js";
import {
  confirmedFileFailure,
  hashToolRequest,
  isMutatingOperation,
  operationPaths,
  parseOperationReceipt,
  safeError,
} from "../results.js";
import { workspaceToolDefinitions } from "../tool-contracts.js";
import { WorkspaceActionLedger } from "./ledger.js";

/** Persisted file mutation and receipt correction are one lifecycle; unknown effects are not replayed. */
export class WorkspaceActions {
  private readonly actions: WorkspaceActionLedger;
  constructor(
    private readonly db: Database.Database,
    private readonly nodeOperations: Pick<NodeOperations, "setWorkspaceOperationResultHandler">,
    private readonly access: WorkspaceAccess,
    notify: MessageWriter["notifyAgentReceiptCorrection"],
  ) {
    this.actions = new WorkspaceActionLedger(db, notify);
  }
  registerResultHandler(): void {
    this.nodeOperations.setWorkspaceOperationResultHandler((nodeId, result) =>
      this.actions.receive(nodeId, result),
    );
  }
  close(): void {
    this.actions.close();
  }
  agentTools() {
    return {
      "workspace.write": defineAgentTool(
        workspaceToolDefinitions["workspace.write"],
        (identity, input) =>
          this.agentAction({
            ...identity,
            actionId: identity.toolCallId,
            operationName: "workspace.write",
            toolInput: input,
            operation: { kind: "write", ...input },
          }),
        "Agent 文件请求被拒绝。",
      ),
      "workspace.write_bytes": defineAgentTool(
        workspaceToolDefinitions["workspace.write_bytes"],
        (identity, input) =>
          this.agentAction({
            ...identity,
            actionId: identity.toolCallId,
            operationName: "workspace.write_bytes",
            toolInput: input,
            operation: { kind: "write_bytes", ...input },
          }),
        "Agent 文件请求被拒绝。",
      ),
      "workspace.edit": defineAgentTool(
        workspaceToolDefinitions["workspace.edit"],
        (identity, input) =>
          this.agentAction({
            ...identity,
            actionId: identity.toolCallId,
            operationName: "workspace.edit",
            toolInput: input,
            operation: { kind: "edit", ...input },
          }),
        "Agent 文件请求被拒绝。",
      ),
      "workspace.mkdir": defineAgentTool(
        workspaceToolDefinitions["workspace.mkdir"],
        (identity, input) =>
          this.agentAction({
            ...identity,
            actionId: identity.toolCallId,
            operationName: "workspace.mkdir",
            toolInput: input,
            operation: { kind: "mkdir", ...input },
          }),
        "Agent 文件请求被拒绝。",
      ),
      "workspace.move": defineAgentTool(
        workspaceToolDefinitions["workspace.move"],
        (identity, input) =>
          this.agentAction({
            ...identity,
            actionId: identity.toolCallId,
            operationName: "workspace.move",
            toolInput: input,
            operation: { kind: "move", ...input },
          }),
        "Agent 文件请求被拒绝。",
      ),
      "workspace.remove": defineAgentTool(
        workspaceToolDefinitions["workspace.remove"],
        (identity, input) =>
          this.agentAction({
            ...identity,
            actionId: identity.toolCallId,
            operationName: "workspace.remove",
            toolInput: input,
            operation: { kind: "remove", ...input },
          }),
        "Agent 文件请求被拒绝。",
      ),
    };
  }
  /** Persist authorization and the node receipt before returning an Agent file action. */
  async agentAction(
    input: AgentToolContext & {
      actionId: string;
      operationName: string;
      toolInput: Record<string, unknown>;
      operation: WorkspaceOperation;
    },
  ): Promise<unknown> {
    return this.access.withAccessAudit(
      {
        principalKind: "agent",
        principalId: input.agentId,
        agentId: input.agentId,
        runId: input.runId,
        operation: input.operationName,
        paths: operationPaths(input.operation),
      },
      () => this.agentActionUnchecked(input),
    );
  }

  private async agentActionUnchecked(input: Parameters<WorkspaceActions["agentAction"]>[0]) {
    const authorized = input.run;
    if (!isMutatingOperation(input.operation))
      throw new WorkspaceError("workspace_unavailable", "此文件操作不允许修改工作区。", 403);
    if (!input.actionId.startsWith(`mate:${authorized.action_scope_id}:`)) {
      const original = new AgentSession(this.db).toolAction(input.agentId, input.actionId);
      if (
        !original ||
        original.name !== "tools.call" ||
        !isDeepStrictEqual(original.input, { name: input.operationName, input: input.toolInput })
      )
        throw new WorkspaceError("operation_conflict", "文件操作 ID 与已保存调用不匹配。", 403);
    }
    const operationId = operationIdForAction(input.actionId);
    const requestHash = hashToolRequest(input.operationName, input.toolInput);
    const nodeRequestHash = workspaceReceiptRequestHash(input.agentId, input.operation);
    const intent = {
      sessionId: authorized.session_id,
      actionId: input.actionId,
      agentId: input.agentId,
      operation: input.operationName,
      requestHash,
      nodeRequestHash,
      operationId,
      runId: input.runId,
      channelId: authorized.channel_id,
    };
    const recorded = this.actions.prepare(intent, input.toolInput);
    if (recorded.kind === "done") return recorded.result;
    if (recorded.kind === "failed")
      throw confirmedFileFailure(recorded.code, recorded.stderr, recorded.errorCode);
    await input.committed;
    this.actions.track(operationId, {
      sessionId: authorized.session_id,
      actionId: input.actionId,
      agentId: input.agentId,
      nodeId: authorized.node_id,
      runId: input.runId,
      channelId: authorized.channel_id,
      operation: input.operationName,
    });

    try {
      input.requireCurrentRun();
      const result = await this.access.runNodeOperation(
        {
          type: "control.workspace.operation",
          requestId: randomUUID(),
          operationId,
          agentId: input.agentId,
          mode: "agent_action",
          operation: input.operation,
        },
        authorized.node_id,
      );
      const value = parseOperationReceipt(result.stdout);
      const envelope = {
        state: "succeeded" as const,
        operationId,
        runId: input.runId,
        channelId: authorized.channel_id,
        operation: input.operationName,
        nodeRequestHash,
        ...(result.revision !== undefined ? { revision: result.revision } : {}),
        result: value,
      };
      this.actions.complete(intent, envelope);
      this.actions.forget(operationId);
      return value;
    } catch (error) {
      this.actions.markUnknown(intent, safeError(error));
      throw error;
    }
  }
}
