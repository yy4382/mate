import { conversationSchema } from "../conversations/schema.js";
import { agentSessionSchema } from "../runtime/session/schema.js";
import { conversationAttentionSchema } from "../conversations/messages/schema.js";
import { taskReminderSchema } from "../conversations/tasks/schema.js";
import { nodeDirectorySchema } from "../nodes/schema.js";
import { ownerAuthSchema } from "../auth/schema.js";
import { agentDirectorySchema } from "../agents/schema.js";
import { modelCredentialSchema } from "../providers/schema.js";
import { agentRunSchema } from "../runtime/run-schema.js";
import { workspaceSchema } from "../workspaces/schema.js";
import { workspaceAccessAuditSchema } from "../workspaces/access/schema.js";
import { agentProcessOperationsSchema } from "../runtime/process-schema.js";
import { recoverySchema } from "../runtime/recovery-schema.js";
import { agentLifecycleSchema } from "../runtime/lifecycle-schema.js";
import { ownerPushSchema } from "../notifications/schema.js";

/** Sole supported first-release format; older experimental databases are left untouched. */
export const controlPlaneSchema = [
  ownerAuthSchema,
  conversationSchema,
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
