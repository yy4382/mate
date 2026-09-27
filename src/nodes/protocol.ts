import { z } from "zod";
import { agentProcessOperationSchema } from "./process-operations.js";
import { privilegedCommandSchema } from "../control-plane/privileged-approvals.js";
import { operationSchema } from "../execution/backend.js";

export const MAX_NODE_MESSAGE_BYTES = 1024 * 1024;

export const NodeRequestIdSchema = z.string().uuid();
const requestIdSchema = NodeRequestIdSchema;
const nodeIdSchema = z.string().uuid();
const signatureSchema = z.string().min(1).max(256);
export const AgentProvisionStageSchema = z.enum([
  "checking_account",
  "creating_account",
  "preparing_home",
  "verifying_identity",
]);
const agentIdSchema = z.string().uuid();
const workspaceOperationSchema = operationSchema.refine((operation) => operation.kind !== "exec");
const workspaceReadOperationSchema = workspaceOperationSchema.refine((operation) =>
  ["workspace_list", "workspace_stat", "workspace_read_chunk"].includes(operation.kind),
);
const agentWorkspaceReadOperationSchema = workspaceOperationSchema.refine((operation) =>
  ["read", "workspace_list", "workspace_stat", "workspace_read_chunk"].includes(operation.kind),
);
const workspaceExecutionResultSchema = z
  .object({
    code: z.number().int(),
    stdout: z.string().max(12_000),
    stderr: z.string().max(12_000),
    truncated: z.boolean(),
    revision: z.number().int().positive().optional(),
  })
  .strict();
const provisionIdentitySchema = z
  .object({
    username: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    uid: z.number().int().positive(),
    gid: z.number().int().positive(),
    home: z.string().regex(/^\//).max(4096),
    homeMarker: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** The same validated request and response shapes are used by the control plane and node. */
const NodeRequestShapeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("node.authenticate"),
    requestId: requestIdSchema,
    nodeId: nodeIdSchema,
    signature: signatureSchema,
  }),
  z.object({
    type: z.literal("node.pair"),
    requestId: requestIdSchema,
    nodeId: nodeIdSchema,
    pairingToken: z.string().min(32).max(256),
    publicKey: z.string().min(1).max(4096),
    signature: signatureSchema,
  }),
  z.object({
    type: z.literal("node.ping"),
    requestId: requestIdSchema,
    sentAt: z.number().int().nonnegative(),
  }),
  z
    .object({
      type: z.literal("node.agent.provision.progress"),
      requestId: requestIdSchema,
      agentId: agentIdSchema,
      stage: AgentProvisionStageSchema,
    })
    .strict(),
  z.discriminatedUnion("ok", [
    z
      .object({
        type: z.literal("node.agent.provision.result"),
        requestId: requestIdSchema,
        agentId: agentIdSchema,
        ok: z.literal(true),
        identity: provisionIdentitySchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("node.agent.provision.result"),
        requestId: requestIdSchema,
        agentId: agentIdSchema,
        ok: z.literal(false),
        code: z.enum([
          "unsupported_host",
          "permission_denied",
          "account_conflict",
          "identity_mismatch",
          "filesystem_error",
        ]),
        message: z.string().min(1).max(240),
      })
      .strict(),
  ]),
  z
    .object({
      type: z.literal("node.agent.run.context"),
      requestId: requestIdSchema,
      runId: requestIdSchema,
      agentId: agentIdSchema,
      cursor: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(100),
    })
    .strict(),
  /**
   * Run transcript: the model's plain assistant text for one run. It is recorded in the Agent's
   * own session record and never published to a conversation; speaking requires an explicit
   * `messages.send` tool call through `node.agent.run.tool`.
   */
  z
    .object({
      type: z.literal("node.agent.run.transcript"),
      requestId: requestIdSchema,
      runId: requestIdSchema,
      agentId: agentIdSchema,
      text: z.string().min(1).max(20_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("node.agent.run.tool"),
      requestId: requestIdSchema,
      runId: requestIdSchema,
      agentId: agentIdSchema,
      toolCallId: z.string().min(1).max(500),
      operation: z.string().min(1).max(128),
      input: z.record(z.string(), z.json()),
    })
    .strict(),
  z.discriminatedUnion("ok", [
    z
      .object({
        type: z.literal("node.workspace.operation.result"),
        requestId: requestIdSchema,
        operationId: requestIdSchema,
        agentId: agentIdSchema,
        ok: z.literal(true),
        revision: z.number().int().positive().optional(),
        result: workspaceExecutionResultSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("node.workspace.operation.result"),
        requestId: requestIdSchema,
        operationId: requestIdSchema,
        agentId: agentIdSchema,
        ok: z.literal(false),
        error: z.string().min(1).max(240),
      })
      .strict(),
  ]),
  z.discriminatedUnion("ok", [
    z
      .object({
        type: z.literal("node.agent.run.result"),
        requestId: requestIdSchema,
        runId: requestIdSchema,
        agentId: agentIdSchema,
        ok: z.literal(true),
      })
      .strict(),
    z
      .object({
        type: z.literal("node.agent.run.result"),
        requestId: requestIdSchema,
        runId: requestIdSchema,
        agentId: agentIdSchema,
        ok: z.literal(false),
        code: z.enum([
          "model_unavailable",
          "model_failed",
          "worker_failed",
          "credentials_invalid",
          "aborted",
        ]),
      })
      .strict(),
  ]),
  z
    .object({
      type: z.literal("node.process.operation.result"),
      requestId: requestIdSchema,
      operationId: requestIdSchema,
      agentId: agentIdSchema,
      state: z.enum(["succeeded", "failed", "unknown"]),
      receipt: z.json().nullable(),
      revision: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("node.privileged.started"),
      requestId: requestIdSchema,
      operationId: requestIdSchema,
      agentId: agentIdSchema,
      startedAt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("node.privileged.result"),
      requestId: requestIdSchema,
      operationId: requestIdSchema,
      agentId: agentIdSchema,
      startedAt: z.number().int().positive(),
      state: z.enum(["succeeded", "failed", "unknown"]),
      receipt: z.json().nullable(),
      revision: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("node.privileged.reconcile.result"),
      requestId: requestIdSchema,
      receipts: z
        .array(
          z
            .object({
              requestId: requestIdSchema,
              operationId: requestIdSchema,
              agentId: agentIdSchema,
              startedAt: z.number().int().positive(),
              state: z.enum(["succeeded", "failed", "unknown"]),
              receipt: z.json().nullable(),
              revision: z.number().int().positive().optional(),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("node.process.reconcile.result"),
      requestId: requestIdSchema,
      receipts: z
        .array(
          z
            .object({
              operationId: requestIdSchema,
              agentId: agentIdSchema,
              state: z.enum(["succeeded", "failed", "unknown"]),
              receipt: z.json().nullable(),
              revision: z.number().int().positive().optional(),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("node.workspace.reconcile.result"),
      requestId: requestIdSchema,
      receipts: z
        .array(
          z
            .object({
              operationId: requestIdSchema,
              agentId: agentIdSchema,
              result: workspaceExecutionResultSchema,
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
]);
export const NodeRequestSchema = NodeRequestShapeSchema.refine(
  (request) => Buffer.byteLength(JSON.stringify(request), "utf8") <= MAX_NODE_MESSAGE_BYTES,
  "Node WebSocket request exceeds the 1 MiB complete-frame limit",
);

const NodeControlMessageShapeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("control.challenge"),
    nonce: z.string().min(32).max(64),
  }),
  z.object({
    type: z.literal("control.paired"),
    requestId: requestIdSchema,
    nodeId: nodeIdSchema,
    privilegedPublicKey: z.string().min(1).max(4096).optional(),
  }),
  z.object({
    type: z.literal("control.authenticated"),
    requestId: requestIdSchema,
    nodeId: nodeIdSchema,
    privilegedPublicKey: z.string().min(1).max(4096).optional(),
  }),
  z.object({
    type: z.literal("control.pong"),
    requestId: requestIdSchema,
    acceptedAt: z.number().int().nonnegative(),
  }),
  z
    .object({
      type: z.literal("control.agent.provision"),
      requestId: requestIdSchema,
      agentId: agentIdSchema,
      verifyOnly: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("control.agent.run"),
      requestId: requestIdSchema,
      runId: requestIdSchema,
      agentId: agentIdSchema,
      sessionId: requestIdSchema,
      actionScopeId: requestIdSchema,
      provider: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
      modelId: z.string().min(1).max(200),
      apiKey: z.string().min(1).max(8192),
      channelId: requestIdSchema,
      channelVisibility: z.enum(["public", "private"]),
      prompt: z
        .object({
          name: z.string().min(1).max(80),
          role: z.string().min(1).max(160),
          description: z.string().max(1000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("control.agent.run.cancel"),
      requestId: requestIdSchema,
      runId: requestIdSchema,
      agentId: agentIdSchema,
      reason: z.enum(["timeout", "credentials_changed", "manual_pause"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("control.agent.activate"),
      requestId: requestIdSchema,
      agentId: agentIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("control.process.operation"),
      requestId: requestIdSchema,
      operationId: requestIdSchema,
      agentId: agentIdSchema,
      operation: agentProcessOperationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("control.privileged.operation"),
      requestId: requestIdSchema,
      command: privilegedCommandSchema,
      signature: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      type: z.literal("control.privileged.reconcile"),
      requestId: requestIdSchema,
      operations: z
        .array(z.object({ requestId: requestIdSchema, agentId: agentIdSchema }).strict())
        .max(100),
    })
    .strict(),
  z.discriminatedUnion("mode", [
    z
      .object({
        type: z.literal("control.workspace.operation"),
        requestId: requestIdSchema,
        operationId: requestIdSchema,
        agentId: agentIdSchema,
        mode: z.literal("owner_read"),
        operation: workspaceReadOperationSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("control.workspace.operation"),
        requestId: requestIdSchema,
        operationId: requestIdSchema,
        agentId: agentIdSchema,
        runId: requestIdSchema,
        mode: z.literal("agent_read"),
        operation: agentWorkspaceReadOperationSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("control.workspace.operation"),
        requestId: requestIdSchema,
        operationId: requestIdSchema,
        agentId: agentIdSchema,
        runId: requestIdSchema,
        mode: z.literal("agent_action"),
        operation: workspaceOperationSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("control.workspace.operation"),
        requestId: requestIdSchema,
        operationId: requestIdSchema,
        agentId: agentIdSchema,
        runId: requestIdSchema,
        mode: z.literal("agent_publish"),
        operation: workspaceReadOperationSchema,
      })
      .strict(),
  ]),
  z
    .object({
      type: z.literal("control.process.reconcile"),
      requestId: requestIdSchema,
      operations: z
        .array(z.object({ operationId: requestIdSchema, agentId: agentIdSchema }).strict())
        .max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("control.workspace.reconcile"),
      requestId: requestIdSchema,
      operations: z
        .array(z.object({ operationId: requestIdSchema, agentId: agentIdSchema }).strict())
        .max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("control.agent.run.context"),
      requestId: requestIdSchema,
      runId: requestIdSchema,
      messages: z.array(
        z
          .object({
            sequence: z.number().int().positive(),
            role: z.enum(["user", "assistant"]),
            text: z.string().min(1).max(20_000),
            sourceChannelId: requestIdSchema,
            sourceVisibility: z.enum(["public", "private"]),
            currentRunInput: z.boolean(),
          })
          .strict(),
      ),
      nextCursor: z.number().int().positive().nullable(),
    })
    .strict(),
  /** Durable, idempotent acknowledgement of one run transcript entry. */
  z
    .object({
      type: z.literal("control.agent.run.transcript_ack"),
      requestId: requestIdSchema,
      runId: requestIdSchema,
      accepted: z.boolean(),
    })
    .strict(),
  z.discriminatedUnion("ok", [
    z
      .object({
        type: z.literal("control.agent.run.tool_result"),
        requestId: requestIdSchema,
        runId: requestIdSchema,
        toolCallId: z.string().min(1).max(500),
        ok: z.literal(true),
        result: z.json(),
      })
      .strict(),
    z
      .object({
        type: z.literal("control.agent.run.tool_result"),
        requestId: requestIdSchema,
        runId: requestIdSchema,
        toolCallId: z.string().min(1).max(500),
        ok: z.literal(false),
        error: z.string().min(1).max(240),
      })
      .strict(),
  ]),
  z.object({
    type: z.literal("control.error"),
    requestId: requestIdSchema.optional(),
    code: z.enum([
      "malformed_request",
      "pairing_rejected",
      "invalid_identity",
      "unknown_identity",
      "not_authenticated",
    ]),
    message: z.string().min(1).max(160),
  }),
]);
export const NodeControlMessageSchema = NodeControlMessageShapeSchema.refine(
  (message) => Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_NODE_MESSAGE_BYTES,
  "Node WebSocket control message exceeds the 1 MiB complete-frame limit",
);

export type NodeRequest = z.infer<typeof NodeRequestSchema>;
export type NodeControlMessage = z.infer<typeof NodeControlMessageSchema>;
export type AgentProvisionStage = z.infer<typeof AgentProvisionStageSchema>;
export type NodeAgentProvisionResult = Extract<
  NodeRequest,
  { type: "node.agent.provision.result" }
>;
export type NodeAgentRunResult = Extract<NodeRequest, { type: "node.agent.run.result" }>;
export type NodeWorkspaceOperationResult = Extract<
  NodeRequest,
  { type: "node.workspace.operation.result" }
>;
export type ControlWorkspaceOperation = Extract<
  NodeControlMessage,
  { type: "control.workspace.operation" }
>;
