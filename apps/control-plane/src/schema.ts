import { agentSessionSchema } from "./agent-session.js";
import { conversationAttentionSchema } from "./conversation-attention-schema.js";
import { taskReminderSchema } from "./task-reminder-schema.js";
import { nodeDirectorySchema } from "./nodes/schema.js";
import { ownerAuthSchema } from "./owner-auth-schema.js";
import { agentDirectorySchema } from "./agents/schema.js";
import { modelCredentialSchema } from "./model-credentials.js";
import { agentRunSchema } from "./agent-runs-schema.js";
import { workspaceSchema } from "./workspace-schema.js";
import { workspaceAccessAuditSchema } from "./workspace-access-schema.js";
import { agentProcessOperationsSchema } from "./process-operations-schema.js";
import { recoverySchema } from "./recovery-schema.js";
import { agentLifecycleSchema } from "./agent-lifecycle-schema.js";
import { ownerPushSchema } from "./push-schema.js";

/** Sole supported first-release format; older experimental databases are left untouched. */
export const controlPlaneSchema = [
  ownerAuthSchema,
  nodeDirectorySchema,
  agentDirectorySchema,
  modelCredentialSchema,
  agentRunSchema,
  agentProcessOperationsSchema,
  workspaceSchema,
  workspaceAccessAuditSchema,
  recoverySchema,
  conversationAttentionSchema,
  taskReminderSchema,
  agentLifecycleSchema,
  agentSessionSchema,
  ownerPushSchema,
].join("\n");
