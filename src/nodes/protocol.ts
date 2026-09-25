import { z } from "zod";

export const NodeRequestIdSchema = z.string().uuid();
const requestIdSchema = NodeRequestIdSchema;
const nodeIdSchema = z.string().uuid();
const signatureSchema = z.string().min(1).max(256);

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
