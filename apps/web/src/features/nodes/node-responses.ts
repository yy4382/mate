import { z } from "zod";
import { nodeSummarySchema } from "@mate/protocol/owner";

export const nodeSchema = nodeSummarySchema.partial({ lastConnectedAt: true }).loose();
export const nodesResponseSchema = z.looseObject({ nodes: z.array(nodeSchema) });
export const pairingTokenSchema = z.looseObject({
  pairingToken: z.string(),
  expiresAt: z.string(),
});
export type NodeSummary = z.infer<typeof nodeSchema>;
export type PairingToken = z.infer<typeof pairingTokenSchema>;
