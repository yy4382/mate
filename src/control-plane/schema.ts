import { conversationAttentionSchemaV17 } from "./conversation-attention-schema.js";
import { taskReminderSchemaV18 } from "./task-reminder-schema.js";
import { nodeDirectorySchema } from "./nodes/schema.js";
import { ownerAuthSchema } from "./owner-auth-schema.js";
import { agentDirectorySchema, singleAccountAgentSchemaV24 } from "./agents/schema.js";
import { modelCredentialSchema } from "./model-credentials.js";
import {
  agentRunTranscriptSchemaV23,
  agentJournalReplaySchema,
  agentRunBatchSchemaV9,
  agentRunContextHistorySchemaV10,
  agentConversationToolsSchemaV11,
  agentConversationActionRecoverySchemaV12,
  agentRunSchemaV7,
} from "./agent-runs-schema.js";
import { workspaceSchemaV14 } from "./workspace-schema.js";
import { workspaceAccessAuditSchemaV15 } from "./workspace-access-schema.js";
import { agentProcessOperationsSchemaV13 } from "./process-operations-schema.js";
import { recoverySchemaV16 } from "./recovery-schema.js";
import { agentLifecycleSchemaV19 } from "./agent-lifecycle-schema.js";
import { recoveryHoldSchemaV21 } from "./recovery-holds.js";
import { recoveryVersionsSchema, recoveryVersionsSchemaV22 } from "./recovery-versions-schema.js";

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
export const controlPlaneSchemaV14 = `${controlPlaneSchemaV13}\n${workspaceSchemaV14}`;
export const controlPlaneSchemaV15 = `${controlPlaneSchemaV14}\n${workspaceAccessAuditSchemaV15}`;
export const controlPlaneSchemaV16 = `${controlPlaneSchemaV15}\n${recoverySchemaV16}`;
export const controlPlaneSchemaV17 = `${controlPlaneSchemaV16}\n${conversationAttentionSchemaV17}`;
export const controlPlaneSchemaV18 = `${controlPlaneSchemaV17}\n${taskReminderSchemaV18}`;
export const controlPlaneSchemaV19 = `${controlPlaneSchemaV18}\n${agentLifecycleSchemaV19}`;

/**
 * Revision 20 of the old release: the control plane kept an owner-approved privileged command
 * request and its signed node grant in these two tables. Revision 25 removes that path, so this
 * template is frozen only because the migration machinery compares a real, older database against
 * it before upgrading: revision 24's format must be recognised for what it is.
 */
const privilegedApprovalSchemaV20 = `
CREATE TABLE IF NOT EXISTS owner_privileged_approval_keys (
  id INTEGER PRIMARY KEY CHECK(id=1), private_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_privileged_approvals (
  request_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL, node_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  command_json TEXT NOT NULL, request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','running','succeeded','failed','unknown','rejected','expired')),
  receipt_json TEXT, started_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_privileged_approvals_channel
  ON owner_privileged_approvals(channel_id,created_at);
`;

export const controlPlaneSchemaV20 = `${controlPlaneSchemaV19}\n${privilegedApprovalSchemaV20}`;
export const controlPlaneSchemaV21 = `${controlPlaneSchemaV20}\n${recoveryHoldSchemaV21}`;
export const controlPlaneSchemaV22 = `${controlPlaneSchemaV21}\n${recoveryVersionsSchemaV22}`;

/** The private control-plane format that records every plain assistant turn of a run. */
export const controlPlaneSchemaV23 = `${controlPlaneSchemaV22}\n${agentRunTranscriptSchemaV23}`;

/** Revision 24 rebuilt the Agent table for the single-account release. */
export const controlPlaneSchemaV24 = `${controlPlaneSchemaV23}\n${singleAccountAgentSchemaV24}`;

/**
 * Revision 25 removes Mate's privileged-command approval state: a command the Agent writes is an
 * ordinary child process of the node's own account, and whether a `sudo` inside it succeeds is
 * decided by the host's existing sudo rules alone (ADR-0004).
 *
 * This is a reset, not a reconciliation (ADR-0002): an upgrade drops every row with the tables,
 * including a request the old release had already approved or started. Nothing in revision 25 can
 * confirm such a command's outcome, so it is deliberately not carried into any new state, hold or
 * receipt — an owner who needs one of those old records must read the pre-upgrade database with a
 * read-only SQLite client before the first revision-25 start. The same applies to the node's old
 * `privileged-operations.sqlite`, which revision 25 neither opens nor reconciles.
 */
export const privilegedApprovalRemovalSchemaV25 = `
DROP TABLE owner_privileged_approvals;
DROP TABLE owner_privileged_approval_keys;
`;

/**
 * The current format (revision 25) is revision 24 with the two approval tables never created;
 * everything else is unchanged. It is spelled out rather than built from the revision-24 template
 * because SQLite cannot subtract a table from a schema string.
 */
export const controlPlaneSchema = `${controlPlaneSchemaV19}\n${recoveryHoldSchemaV21}\n${recoveryVersionsSchema}\n${agentRunTranscriptSchemaV23}\n${singleAccountAgentSchemaV24}`;

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
  {
    fromRevision: 13,
    toRevision: 14,
    previousSchema: controlPlaneSchemaV13,
    nextSchema: controlPlaneSchemaV14,
    migrationSchema: workspaceSchemaV14,
  },
  {
    fromRevision: 14,
    toRevision: 15,
    previousSchema: controlPlaneSchemaV14,
    nextSchema: controlPlaneSchemaV15,
    migrationSchema: workspaceAccessAuditSchemaV15,
  },
  {
    fromRevision: 15,
    toRevision: 16,
    previousSchema: controlPlaneSchemaV15,
    nextSchema: controlPlaneSchemaV16,
    migrationSchema: recoverySchemaV16,
  },
  {
    fromRevision: 16,
    toRevision: 17,
    previousSchema: controlPlaneSchemaV16,
    nextSchema: controlPlaneSchemaV17,
    migrationSchema: conversationAttentionSchemaV17,
  },
  {
    fromRevision: 17,
    toRevision: 18,
    previousSchema: controlPlaneSchemaV17,
    nextSchema: controlPlaneSchemaV18,
    migrationSchema: taskReminderSchemaV18,
  },
  {
    fromRevision: 18,
    toRevision: 19,
    previousSchema: controlPlaneSchemaV18,
    nextSchema: controlPlaneSchemaV19,
    migrationSchema: agentLifecycleSchemaV19,
  },
  {
    fromRevision: 19,
    toRevision: 20,
    previousSchema: controlPlaneSchemaV19,
    nextSchema: controlPlaneSchemaV20,
    migrationSchema: privilegedApprovalSchemaV20,
  },
  {
    fromRevision: 20,
    toRevision: 21,
    previousSchema: controlPlaneSchemaV20,
    nextSchema: controlPlaneSchemaV21,
    migrationSchema: recoveryHoldSchemaV21,
  },
  {
    fromRevision: 21,
    toRevision: 22,
    previousSchema: controlPlaneSchemaV21,
    nextSchema: controlPlaneSchemaV22,
    migrationSchema: recoveryVersionsSchemaV22,
  },
  {
    fromRevision: 22,
    toRevision: 23,
    previousSchema: controlPlaneSchemaV22,
    nextSchema: controlPlaneSchemaV23,
    migrationSchema: agentRunTranscriptSchemaV23,
  },
  {
    fromRevision: 23,
    toRevision: 24,
    previousSchema: controlPlaneSchemaV23,
    nextSchema: controlPlaneSchemaV24,
    migrationSchema: singleAccountAgentSchemaV24,
  },
  {
    fromRevision: 24,
    toRevision: 25,
    previousSchema: controlPlaneSchemaV24,
    nextSchema: controlPlaneSchema,
    migrationSchema: privilegedApprovalRemovalSchemaV25,
  },
] as const;
