import { agentSummarySchema } from "@mate/protocol/owner";

import { type ServerResponse } from "node:http";

import { z } from "zod";
import type { ProviderRequest } from "../agent/agent-loop.js";
import { ProcessOutput } from "./run-services.js";
import { type NodeLinkEvent } from "./scenario-network.js";
import { createScenarioContainer } from "./scenario-container.js";

export const agentConfigurationSchema = z.object({
  name: z.string().min(1),
  role: z.string().default("持续工作"),
  description: z.string().default("Synthetic scenario Agent"),
  model: z.object({ provider: z.literal("openai"), id: z.string() }).default({
    provider: "openai",
    id: "gpt-4o-mini",
  }),
});

export const configurationSchema = z.object({
  cleanupTimeoutMs: z.number().int().positive().default(5000),
  container: z.object({ image: z.string().min(1) }).optional(),
  agents: z.array(agentConfigurationSchema).default([]),
  controlPlane: z
    .object({
      nodeOperationTimeoutMs: z.number().int().positive().optional(),
      nodeHeartbeatTimeoutMs: z.number().int().positive().optional(),
      modelContextWindow: z.number().int().positive().optional(),
      observePartialTool: z.boolean().default(false),
      commitBoundary: z
        .discriminatedUnion("phase", [
          z.object({
            phase: z.enum(["before", "after"]),
            role: z.enum(["assistant", "toolResult"]),
            toolName: z.string().optional(),
          }),
          z.object({ phase: z.literal("finish") }),
        ])
        .optional(),
    })
    .prefault({}),
  node: z
    .object({
      commandTimeoutMs: z.number().int().positive().default(700),
      heartbeatIntervalMs: z.number().int().positive().default(100),
      heartbeatTimeoutMs: z.number().int().positive().default(2000),
      commandBoundary: z.enum(["before_execute", "before_receipt"]).optional(),
      networkProxy: z.boolean().default(false),
      fileBoundary: z.enum(["before_execute", "before_receipt", "after_receipt"]).optional(),
      holdFirstFileExecution: z.boolean().default(false),
    })
    .prefault({}),
});

export const providerRequestSchema = z
  .object({ input: z.array(z.unknown()), model: z.string() })
  .passthrough();

export const preparedAgentSchema = z.object({
  summary: agentSummarySchema,
  channelId: z.string(),
  workspace: z.string(),
});

export type ScenarioConfiguration = z.input<typeof configurationSchema> & {
  provider: (request: ProviderRequest, response: ServerResponse) => void | Promise<void>;
  signal?: AbortSignal;
  resourceManifestPath?: string;
  observeProcess?: (service: "control-plane" | "node", output: ProcessOutput) => void;
  beforeClose?: (facts: ScenarioFacts, signal: AbortSignal) => void | Promise<void>;
};

export type PreparedScenarioAgent = z.infer<typeof preparedAgentSchema>;

export type ScenarioFacts = {
  directory: string;
  origin: string;
  nodeId: string;
  processes: readonly ProcessOutput[];
  agents: readonly PreparedScenarioAgent[];
  requests: readonly ProviderRequest[];
  network?: readonly NodeLinkEvent[];
  topology?: ReturnType<typeof createScenarioContainer>["topology"] | undefined;
  redact: (text: string) => string;
  startupFailure?: unknown;
};
