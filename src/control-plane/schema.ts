import { nodeDirectorySchema } from "./nodes/schema.js";
import { ownerAuthSchema } from "./owner-auth-schema.js";
import { agentDirectorySchema } from "./agents/schema.js";
import { modelCredentialSchema } from "./model-credentials.js";
import { agentJournalReplaySchema, agentRunSchemaV7 } from "./agent-runs-schema.js";

/** The format used by the paired-node release before Agent provisioning. */
export const controlPlaneSchemaV4 = `${ownerAuthSchema}\n${nodeDirectorySchema}`;

/** The paired-node database format after Agent provisioning was added. */
export const controlPlaneSchemaV5 = `${controlPlaneSchemaV4}\n${agentDirectorySchema}`;

/** The paired-node database with owner-managed provider credentials. */
export const controlPlaneSchemaV6 = `${controlPlaneSchemaV5}\n${modelCredentialSchema}`;

/** The paired-node database with the first owner-DM Agent run path. */
export const controlPlaneSchemaV7 = `${controlPlaneSchemaV6}\n${agentRunSchemaV7}`;

/** The current private control-plane database format. */
export const controlPlaneSchema = `${controlPlaneSchemaV7}\n${agentJournalReplaySchema}`;

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
    nextSchema: controlPlaneSchema,
    migrationSchema: agentJournalReplaySchema,
  },
] as const;
