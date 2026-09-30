import { z } from "zod";
import { agentProcessOperationSchema } from "./process-operations.js";
import { operationSchema } from "./workspace-operations.js";

export const MAX_NODE_MESSAGE_BYTES = 1024 * 1024;

export const NodeRequestIdSchema = z.string().uuid();
const requestIdSchema = NodeRequestIdSchema;
const nodeIdSchema = z.string().uuid();
const signatureSchema = z.string().min(1).max(256);
export const AgentProvisionStageSchema = z.enum([
  "checking_account",
  "preparing_workspace",
  "verifying_workspace",
]);
const agentIdSchema = z.string().uuid();
const workspaceReadOperationSchema = operationSchema.refine((operation) =>
  ["workspace_list", "workspace_stat", "workspace_read_chunk"].includes(operation.kind),
);
const agentWorkspaceReadOperationSchema = operationSchema.refine((operation) =>
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

/** The existing host account and Agent workspace; Mate never creates users or switches identities. */
export const provisionIdentitySchema = z
  .object({
    username: z.string().min(1).max(255),
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    workspace: z.string().regex(/^\//).max(4096),
    workspaceMarker: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** The same validated local-operation shapes are used by the control plane and node. */
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
  }),
  z.object({
    type: z.literal("control.authenticated"),
    requestId: requestIdSchema,
    nodeId: nodeIdSchema,
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
        mode: z.literal("agent_action"),
        operation: operationSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("control.workspace.operation"),
        requestId: requestIdSchema,
        operationId: requestIdSchema,
        agentId: agentIdSchema,
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
        .array(
          z
            .object({
              operationId: requestIdSchema,
              agentId: agentIdSchema,
              requestHash: z.string().optional(),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("control.workspace.reconcile"),
      requestId: requestIdSchema,
      operations: z
        .array(
          z
            .object({
              operationId: requestIdSchema,
              agentId: agentIdSchema,
              requestHash: z.string().optional(),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
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
export type NodeWorkspaceOperationResult = Extract<
  NodeRequest,
  { type: "node.workspace.operation.result" }
>;
export type ControlWorkspaceOperation = Extract<
  NodeControlMessage,
  { type: "control.workspace.operation" }
>;

export type AgentWorkspaceIdentity = z.infer<typeof provisionIdentitySchema>;
