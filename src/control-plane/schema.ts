import { agentSessionSchema } from "./agent-session.js";
import { conversationAttentionSchemaV17 } from "./conversation-attention-schema.js";
import { taskReminderSchemaV18 } from "./task-reminder-schema.js";
import { nodeDirectorySchema } from "./nodes/schema.js";
import { ownerAuthSchema } from "./owner-auth-schema.js";
import { agentDirectorySchema } from "./agents/schema.js";
import { modelCredentialSchema } from "./model-credentials.js";
import { agentRunSchema } from "./agent-runs-schema.js";
import { workspaceSchemaV14 } from "./workspace-schema.js";
import { workspaceAccessAuditSchemaV15 } from "./workspace-access-schema.js";
import { agentProcessOperationsSchemaV13 } from "./process-operations-schema.js";
import { recoverySchema } from "./recovery-schema.js";
import { agentLifecycleSchemaV19 } from "./agent-lifecycle-schema.js";
import { recoveryHoldSchemaV21 } from "./recovery-holds.js";
import { ownerPushSchema } from "./push-schema.js";

/** Sole supported first-release format; older experimental databases are left untouched. */
export const controlPlaneSchema = [
  ownerAuthSchema,
  nodeDirectorySchema,
  agentDirectorySchema,
  modelCredentialSchema,
  agentRunSchema,
  agentProcessOperationsSchemaV13,
  workspaceSchemaV14,
  workspaceAccessAuditSchemaV15,
  recoverySchema,
  conversationAttentionSchemaV17,
  taskReminderSchemaV18,
  agentLifecycleSchemaV19,
  recoveryHoldSchemaV21,
  agentSessionSchema,
  ownerPushSchema,
].join("\n");
