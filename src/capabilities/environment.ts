import { z } from "zod";
import type { RunToken } from "../storage/store.js";
import type { Collaboration } from "../collaboration/service.js";
import type { ConversationTarget } from "../domain/conversations.js";

const availability = z.enum(["configured", "unavailable"]);
export const environmentReportSchema = z
  .object({
    format: z.literal("mate.environment.v3"),
    workId: z.string(),
    snapshotAt: z.number().int(),
    filesystem: z.object({
      home: z.string(),
      sharedRoot: z.string().optional(),
      access: z.enum(["linux_user_permissions", "local_user_permissions"]),
    }),
    execution: z.object({
      status: availability,
      network: z.literal("host"),
      reason: z.string().optional(),
    }),
    attachmentInput: z.object({
      status: availability,
      scope: z.literal("visible_external_message_file"),
      reason: z.string().optional(),
    }),
    artifactOutput: z.object({
      adapterStatus: availability,
      status: availability,
      scope: z.literal("supported_external_target_only"),
      reason: z.string().optional(),
    }),
  })
  .strict();
export type EnvironmentReport = z.infer<typeof environmentReportSchema>;

export interface EnvironmentDeployment {
  homes: Readonly<Record<string, string>>;
  sharedRoot?: string;
  access?: "linux_user_permissions" | "local_user_permissions";
  attachmentConfigured(actor: string): boolean;
  artifactConfigured(actor: string): boolean;
  artifactSupported(actor: string, target: ConversationTarget): boolean;
}

/** Informational paths and adapter availability; Unix identity decides ordinary file access. */
export class EnvironmentCapabilities {
  constructor(
    readonly collaboration: Collaboration,
    readonly deployment: EnvironmentDeployment,
  ) {}
  read(run: RunToken, workId: string): EnvironmentReport {
    this.collaboration.store.assertRun(run);
    const home = this.deployment.homes[run.agentId];
    if (!home) throw new Error("Agent Linux home is not configured");
    const seat = this.collaboration.seats.active(run.agentId);
    const attachmentConfigured = !seat && this.deployment.attachmentConfigured(run.agentId);
    const target = JSON.parse(this.collaboration.work(workId).target) as ConversationTarget;
    const artifactAdapter = !seat && this.deployment.artifactConfigured(run.agentId);
    const artifactSupported =
      artifactAdapter && this.deployment.artifactSupported(run.agentId, target);
    return environmentReportSchema.parse({
      format: "mate.environment.v3",
      workId,
      snapshotAt: Date.now(),
      filesystem: {
        home,
        ...(this.deployment.sharedRoot ? { sharedRoot: this.deployment.sharedRoot } : {}),
        access: this.deployment.access ?? "linux_user_permissions",
      },
      execution: { status: "configured", network: "host" },
      attachmentInput: {
        status: attachmentConfigured ? "configured" : "unavailable",
        scope: "visible_external_message_file",
        ...(!attachmentConfigured
          ? {
              reason: seat
                ? "Independent review isolates external inputs."
                : "No attachment input adapter is configured for this Agent.",
            }
          : {}),
      },
      artifactOutput: {
        adapterStatus: artifactAdapter ? "configured" : "unavailable",
        status: artifactSupported ? "configured" : "unavailable",
        scope: "supported_external_target_only",
        ...(!artifactSupported
          ? {
              reason: seat
                ? "Independent review isolates external outputs."
                : !artifactAdapter
                  ? "No artifact output adapter is configured for this Agent."
                  : "The current work target does not support artifact output.",
            }
          : {}),
      },
    });
  }
}
