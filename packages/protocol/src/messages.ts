import { z } from "zod";
import { agentProcessOperationSchema } from "./process-operations.js";
import { workspaceFailureCodeSchema } from "./workspace-failures.js";
import { workspaceOperationSchema } from "./workspace-operations.js";

export const MAX_NODE_MESSAGE_BYTES = 1024 * 1024;
/** Process and workspace reconciliation share a wire capacity of records per page. */
export const MAX_NODE_RECEIPTS_PER_PAGE = 100;

export const NodeRequestIdSchema = z.string().uuid();
const nodeIdSchema = z.string().uuid();
const signatureSchema = z.string().min(1).max(256);
export const AgentProvisionStageSchema = z.enum([
  "checking_account",
  "preparing_workspace",
  "verifying_workspace",
]);
const agentIdSchema = z.string().uuid();
const workspaceReadOperationSchema = workspaceOperationSchema.refine((operation) =>
  ["workspace_list", "workspace_stat", "workspace_read_chunk"].includes(operation.kind),
);
const agentWorkspaceReadOperationSchema = workspaceOperationSchema.refine((operation) =>
  ["read", "workspace_list", "workspace_stat", "workspace_read_chunk"].includes(operation.kind),
);
const workspaceExecutionResultSchema = z
  .object({
    code: z.number().int(),
    errorCode: workspaceFailureCodeSchema.optional(),
    stdout: z.string().max(12_000),
    stderr: z.string().max(12_000),
    truncated: z.boolean(),
    revision: z.number().int().positive().optional(),
  })
  .strict();

/** The existing host account and Agent workspace; Mate never creates users or switches identities. */
export const agentWorkspaceIdentitySchema = z
  .object({
    username: z.string().min(1).max(255),
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    workspace: z.string().regex(/^\//).max(4096),
    workspaceMarker: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const nodeAgentProvisionResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      type: z.literal("node.agent.provision.result"),
      requestId: NodeRequestIdSchema,
      agentId: agentIdSchema,
      ok: z.literal(true),
      identity: agentWorkspaceIdentitySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("node.agent.provision.result"),
      requestId: NodeRequestIdSchema,
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
]);

const nodeWorkspaceOperationResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      type: z.literal("node.workspace.operation.result"),
      requestId: NodeRequestIdSchema,
      operationId: NodeRequestIdSchema,
      agentId: agentIdSchema,
      ok: z.literal(true),
      revision: z.number().int().positive().optional(),
      result: workspaceExecutionResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("node.workspace.operation.result"),
      requestId: NodeRequestIdSchema,
      operationId: NodeRequestIdSchema,
      agentId: agentIdSchema,
      ok: z.literal(false),
      error: z.string().min(1).max(240),
    })
    .strict(),
]);

const nodeProcessReceiptSchema = z
  .object({
    operationId: NodeRequestIdSchema,
    agentId: agentIdSchema,
    state: z.enum(["succeeded", "failed", "unknown"]),
    receipt: z.json().nullable(),
    revision: z.number().int().positive().optional(),
  })
  .strict();

const nodeWorkspaceReceiptSchema = z
  .object({
    operationId: NodeRequestIdSchema,
    agentId: agentIdSchema,
    result: workspaceExecutionResultSchema,
  })
  .strict();

/** The same validated local-operation shapes are used by the control plane and node. */
const NodeRequestShapeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("node.authenticate"),
    requestId: NodeRequestIdSchema,
    nodeId: nodeIdSchema,
    signature: signatureSchema,
  }),
  z.object({
    type: z.literal("node.pair"),
    requestId: NodeRequestIdSchema,
    nodeId: nodeIdSchema,
    pairingToken: z.string().min(32).max(256),
    publicKey: z.string().min(1).max(4096),
    signature: signatureSchema,
  }),
  z.object({
    type: z.literal("node.ping"),
    requestId: NodeRequestIdSchema,
    sentAt: z.number().int().nonnegative(),
  }),
  z
    .object({
      type: z.literal("node.agent.provision.progress"),
      requestId: NodeRequestIdSchema,
      agentId: agentIdSchema,
      stage: AgentProvisionStageSchema,
    })
    .strict(),
  nodeAgentProvisionResultSchema,
  nodeWorkspaceOperationResultSchema,
  z
    .object({
      type: z.literal("node.process.operation.result"),
      requestId: NodeRequestIdSchema,
      operationId: NodeRequestIdSchema,
      agentId: agentIdSchema,
      state: z.enum(["succeeded", "failed", "unknown"]),
      receipt: z.json().nullable(),
      revision: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("node.process.reconcile.result"),
      requestId: NodeRequestIdSchema,
      receipts: z.array(nodeProcessReceiptSchema).max(MAX_NODE_RECEIPTS_PER_PAGE),
    })
    .strict(),
  z
    .object({
      type: z.literal("node.workspace.reconcile.result"),
      requestId: NodeRequestIdSchema,
      receipts: z.array(nodeWorkspaceReceiptSchema).max(MAX_NODE_RECEIPTS_PER_PAGE),
    })
    .strict(),
]);
export const NodeRequestSchema = NodeRequestShapeSchema.refine(
  (request) => Buffer.byteLength(JSON.stringify(request), "utf8") <= MAX_NODE_MESSAGE_BYTES,
  "Node WebSocket request exceeds the 1 MiB complete-frame limit",
);

const controlWorkspaceOperationSchema = z.discriminatedUnion("mode", [
  z
    .object({
      type: z.literal("control.workspace.operation"),
      requestId: NodeRequestIdSchema,
      operationId: NodeRequestIdSchema,
      agentId: agentIdSchema,
      mode: z.literal("owner_read"),
      operation: workspaceReadOperationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("control.workspace.operation"),
      requestId: NodeRequestIdSchema,
      operationId: NodeRequestIdSchema,
      agentId: agentIdSchema,
      mode: z.literal("agent_read"),
      operation: agentWorkspaceReadOperationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("control.workspace.operation"),
      requestId: NodeRequestIdSchema,
      operationId: NodeRequestIdSchema,
      agentId: agentIdSchema,
      mode: z.literal("agent_action"),
      operation: workspaceOperationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("control.workspace.operation"),
      requestId: NodeRequestIdSchema,
      operationId: NodeRequestIdSchema,
      agentId: agentIdSchema,
      mode: z.literal("agent_publish"),
      operation: workspaceReadOperationSchema,
    })
    .strict(),
]);

const reconciliationOperationSchema = z
  .object({
    operationId: NodeRequestIdSchema,
    agentId: agentIdSchema,
    requestHash: z.string().optional(),
  })
  .strict();

const NodeControlMessageShapeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("control.challenge"),
    nonce: z.string().min(32).max(64),
  }),
  z.object({
    type: z.literal("control.paired"),
    requestId: NodeRequestIdSchema,
    nodeId: nodeIdSchema,
  }),
  z.object({
    type: z.literal("control.authenticated"),
    requestId: NodeRequestIdSchema,
    nodeId: nodeIdSchema,
  }),
  z.object({
    type: z.literal("control.pong"),
    requestId: NodeRequestIdSchema,
    acceptedAt: z.number().int().nonnegative(),
  }),
  z
    .object({
      type: z.literal("control.agent.provision"),
      requestId: NodeRequestIdSchema,
      agentId: agentIdSchema,
      verifyOnly: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("control.agent.activate"),
      requestId: NodeRequestIdSchema,
      agentId: agentIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("control.process.operation"),
      requestId: NodeRequestIdSchema,
      operationId: NodeRequestIdSchema,
      agentId: agentIdSchema,
      operation: agentProcessOperationSchema,
    })
    .strict(),
  controlWorkspaceOperationSchema,
  z
    .object({
      type: z.literal("control.process.reconcile"),
      requestId: NodeRequestIdSchema,
      operations: z.array(reconciliationOperationSchema).max(MAX_NODE_RECEIPTS_PER_PAGE),
    })
    .strict(),
  z
    .object({
      type: z.literal("control.workspace.reconcile"),
      requestId: NodeRequestIdSchema,
      operations: z.array(reconciliationOperationSchema).max(MAX_NODE_RECEIPTS_PER_PAGE),
    })
    .strict(),
  z.object({
    type: z.literal("control.error"),
    requestId: NodeRequestIdSchema.optional(),
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
export type NodeAgentProvisionResult = z.infer<typeof nodeAgentProvisionResultSchema>;
export type NodeWorkspaceOperationResult = z.infer<typeof nodeWorkspaceOperationResultSchema>;
export type ControlWorkspaceOperation = z.infer<typeof controlWorkspaceOperationSchema>;

export type AgentWorkspaceIdentity = z.infer<typeof agentWorkspaceIdentitySchema>;
