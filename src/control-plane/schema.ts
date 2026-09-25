import { nodeDirectorySchema } from "./nodes/schema.js";
import { ownerAuthSchema } from "./owner-auth-schema.js";
import { agentDirectorySchema } from "./agents/schema.js";

/** The format used by the paired-node release before Agent provisioning. */
export const controlPlaneSchemaV4 = `${ownerAuthSchema}\n${nodeDirectorySchema}`;

/** The current private control-plane database format. */
export const controlPlaneSchema = `${controlPlaneSchemaV4}\n${agentDirectorySchema}`;

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
    nextSchema: controlPlaneSchema,
    migrationSchema: agentDirectorySchema,
  },
] as const;
