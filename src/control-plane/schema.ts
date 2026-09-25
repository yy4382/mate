import { nodeDirectorySchema } from "./nodes/schema.js";
import { ownerAuthSchema } from "./owner-auth-schema.js";

/** The current private control-plane database format. */
export const controlPlaneSchema = `${ownerAuthSchema}\n${nodeDirectorySchema}`;
