import { nodeDirectorySchema } from "./nodes/schema.js";
import { ownerAuthSchema } from "./owner-auth-schema.js";
import { agentDirectorySchema } from "./agents/schema.js";
import { modelCredentialSchema } from "./model-credentials.js";
import {
  agentJournalReplaySchema,
  agentRunBatchSchemaV9,
  agentRunContextHistorySchemaV10,
  agentConversationToolsSchemaV11,
  agentConversationActionRecoverySchemaV12,
  agentRunSchemaV7,
} from "./agent-runs-schema.js";
import { agentProcessOperationsSchemaV13 } from "./process-operations-schema.js";

/** The format used by the paired-node release before Agent provisioning. */
export const controlPlaneSchemaV4 = `${ownerAuthSchema}\n${nodeDirectorySchema}`;

/** The paired-node database format after Agent provisioning was added. */
export const controlPlaneSchemaV5 = `${controlPlaneSchemaV4}\n${agentDirectorySchema}`;

/** The paired-node database with owner-managed provider credentials. */
export const controlPlaneSchemaV6 = `${controlPlaneSchemaV5}\n${modelCredentialSchema}`;

/** The paired-node database with the first owner-DM Agent run path. */
export const controlPlaneSchemaV7 = `${controlPlaneSchemaV6}\n${agentRunSchemaV7}`;

/** The private control-plane format after exact journal replay tracking. */
export const controlPlaneSchemaV8 = `${controlPlaneSchemaV7}\n${agentJournalReplaySchema}`;

/** The private control-plane database format with separate run-history and input snapshots. */
export const controlPlaneSchemaV9 = `${controlPlaneSchemaV8}\n${agentRunBatchSchemaV9}`;
export const controlPlaneSchemaV10 = `${controlPlaneSchemaV9}\n${agentRunContextHistorySchemaV10}`;
export const controlPlaneSchemaV11 = `${controlPlaneSchemaV10}\n${agentConversationToolsSchemaV11}`;
export const controlPlaneSchemaV12 = `${controlPlaneSchemaV11}\n${agentConversationActionRecoverySchemaV12}`;
export const controlPlaneSchemaV13 = `${controlPlaneSchemaV12}\n${agentProcessOperationsSchemaV13}`;
export const controlPlaneSchema = controlPlaneSchemaV13;

export const controlPlaneMigrations = [
  {
    fromRevision: 3,
    toRevision: 4,
    previousSchema: ownerAuthSchema,
    nextSchema: controlPlaneSchemaV4,
    migrationSchema: nodeDirectorySchema,
  },
  {
    fromRevision: 4,
    toRevision: 5,
    previousSchema: controlPlaneSchemaV4,
    nextSchema: controlPlaneSchemaV5,
    migrationSchema: agentDirectorySchema,
  },
  {
    fromRevision: 5,
    toRevision: 6,
    previousSchema: controlPlaneSchemaV5,
    nextSchema: controlPlaneSchemaV6,
    migrationSchema: modelCredentialSchema,
  },
  {
    fromRevision: 6,
    toRevision: 7,
    previousSchema: controlPlaneSchemaV6,
    nextSchema: controlPlaneSchemaV7,
    migrationSchema: agentRunSchemaV7,
  },
  {
    fromRevision: 7,
    toRevision: 8,
    previousSchema: controlPlaneSchemaV7,
    nextSchema: controlPlaneSchemaV8,
    migrationSchema: agentJournalReplaySchema,
  },
  {
    fromRevision: 8,
    toRevision: 9,
    previousSchema: controlPlaneSchemaV8,
    nextSchema: controlPlaneSchemaV9,
    migrationSchema: agentRunBatchSchemaV9,
  },
  {
    fromRevision: 9,
    toRevision: 10,
    previousSchema: controlPlaneSchemaV9,
    nextSchema: controlPlaneSchemaV10,
    migrationSchema: agentRunContextHistorySchemaV10,
  },
  {
    fromRevision: 10,
    toRevision: 11,
    previousSchema: controlPlaneSchemaV10,
    nextSchema: controlPlaneSchemaV11,
    migrationSchema: agentConversationToolsSchemaV11,
  },
  {
    fromRevision: 11,
    toRevision: 12,
    previousSchema: controlPlaneSchemaV11,
    nextSchema: controlPlaneSchemaV12,
    migrationSchema: agentConversationActionRecoverySchemaV12,
  },
  {
    fromRevision: 12,
    toRevision: 13,
    previousSchema: controlPlaneSchemaV12,
    nextSchema: controlPlaneSchemaV13,
    migrationSchema: agentProcessOperationsSchemaV13,
  },
] as const;
