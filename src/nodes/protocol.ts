import { z } from "zod";

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
const provisionIdentitySchema = z
  .object({
    username: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    uid: z.number().int().positive(),
    gid: z.number().int().positive(),
    home: z.string().regex(/^\//).max(4096),
  })
  .strict();

/** The same validated request and response shapes are used by the control plane and node. */
export const NodeRequestSchema = z.discriminatedUnion("type", [
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
  z
    .object({
      type: z.literal("node.agent.run.journal"),
      requestId: requestIdSchema,
      runId: requestIdSchema,
      agentId: agentIdSchema,
      text: z.string().min(1).max(20_000),
    })
    .strict(),
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
        code: z.enum(["model_unavailable", "model_failed", "worker_failed", "aborted"]),
      })
      .strict(),
  ]),
]);

export const NodeControlMessageSchema = z.discriminatedUnion("type", [
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
    })
    .strict(),
  z
    .object({
      type: z.literal("control.agent.run"),
      requestId: requestIdSchema,
      runId: requestIdSchema,
      agentId: agentIdSchema,
      sessionId: requestIdSchema,
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
      reason: z.enum(["timeout", "credentials_changed"]),
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
  z
    .object({
      type: z.literal("control.agent.run.journal_ack"),
      requestId: requestIdSchema,
      runId: requestIdSchema,
      accepted: z.boolean(),
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

export type NodeRequest = z.infer<typeof NodeRequestSchema>;
export type NodeControlMessage = z.infer<typeof NodeControlMessageSchema>;
export type AgentProvisionStage = z.infer<typeof AgentProvisionStageSchema>;
export type NodeAgentProvisionResult = Extract<
  NodeRequest,
  { type: "node.agent.provision.result" }
>;
export type NodeAgentRunResult = Extract<NodeRequest, { type: "node.agent.run.result" }>;
