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
