import { agentProvisioningStageSchema } from "@mate/protocol/owner";
import { z } from "zod";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { type AgentWorkspaceIdentity, type AgentProvisionStage } from "@mate/protocol";

import {
  nodeAccountOf,
  NodeAccountConflict,
  type NodeAccount,
  type NodeIdentity,
} from "../nodes/identity.js";
import { providerCredentialExistsSql } from "../providers/credentials.js";
import type { OwnerChat } from "../conversations/service.js";
import type {
  AgentSummary,
  AgentProvisioningStage,
  AgentProvisioningStatus,
  NewAgentRequest,
} from "./contracts.js";
import type { agentProfilePatchSchema } from "./contracts.js";

const agentRowSchema = z.looseObject({
  id: z.string(),
  node_id: z.string(),
  name: z.string(),
  role: z.string(),
  description: z.string(),
  provider: z.string(),
  model_id: z.string(),
  initial_channel_id: z.string().nullable(),
  session_id: z.string(),
  provision_request_id: z.string(),
  request_hash: z.string(),
  stage: agentProvisioningStageSchema,
  error: z.string().nullable(),
  linux_username: z.string().nullable(),
  uid: z.number().nullable(),
  gid: z.number().nullable(),
  home: z.string().nullable(),
  home_marker: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  provider_credential: z.number(),
});
type AgentRow = z.infer<typeof agentRowSchema>;

/**
 * The stages a node's progress and failure reports may still move. A finished or failed Agent is
 * never moved by a later report; `tests/storage/control-plane-database.test.ts` fails if the table
 * ever declares a stage this list does not carry, so a new stage cannot leave the guarded updates
 * silently ignoring it.
 */
export const preparingStages = [
  "queued",
  "checking_account",
  "preparing_workspace",
  "verifying_workspace",
] as const;

const preparingStageList = preparingStages.map((stage) => `'${stage}'`).join(",");

export class AgentRequestConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRequestConflict";
  }
}

export interface PreparedAgentProvision {
  agent: AgentSummary;
  requestId: string;
  created: boolean;
  shouldProvision: boolean;
}

/**
 * One Agent's own columns, its logical session, the account of the node it runs on, and whether a
 * credential row for its current provider exists. Readiness is answered here and never stored, so
 * a credential the owner adds or removes is visible on the very next read.
 */
const agentRowQuery = `
  SELECT a.id,a.node_id,a.name,a.role,a.description,a.provider,a.model_id,
         a.initial_channel_id,s.id AS session_id,a.provision_request_id,a.request_hash,
         a.stage,a.error,n.linux_username,n.uid,n.gid,a.home,a.home_marker,
         a.created_at,a.updated_at,
         ${providerCredentialExistsSql} AS provider_credential
  FROM owner_agents a JOIN owner_agent_sessions s ON s.agent_id=a.id
  JOIN nodes n ON n.id=a.node_id
`;

/** Durable owner-facing Agent identity and provisioning state. */
export class AgentDirectory {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
    /** Records and verifies the one ordinary account the Agent's node runs under. */
    private readonly nodeIdentity: Pick<NodeIdentity, "recordAccount">,
  ) {}

  list(): AgentSummary[] {
    const rows = agentRowSchema
      .array()
      .parse(this.db.prepare(`${agentRowQuery} ORDER BY a.created_at,a.id`).all());
    return rows.map(toAgent);
  }

  get(id: string): AgentSummary | undefined {
    const row = this.read(id);
    return row ? toAgent(row) : undefined;
  }

  updateProfile(
    id: string,
    patch: z.infer<typeof agentProfilePatchSchema>,
  ): AgentSummary | undefined {
    const current = this.read(id);
    if (!current) return undefined;
    this.db
      .prepare("UPDATE owner_agents SET name=?,role=?,description=?,updated_at=? WHERE id=?")
      .run(
        patch.name ?? current.name,
        patch.role ?? current.role,
        patch.description ?? current.description,
        this.now(),
        id,
      );
    return this.get(id);
  }

  updateModel(id: string, model: NewAgentRequest["model"]): AgentSummary | undefined {
    if (!this.read(id)) return undefined;
    this.db
      .prepare("UPDATE owner_agents SET provider=?,model_id=?,updated_at=? WHERE id=?")
      .run(model.provider, model.id, this.now(), id);
    return this.get(id);
  }

  assertSameRequest(input: NewAgentRequest): void {
    const existing = this.read(input.id);
    if (existing && existing.request_hash !== hashRequest(input))
      throw new AgentRequestConflict("这个 Agent ID 已用于不同资料，不能复用。请重新创建 Agent。");
  }

  /** Persist the stable Agent and logical session before any node operation starts. */
  prepare(input: NewAgentRequest): PreparedAgentProvision {
    const requestHash = hashRequest(input),
      at = this.now();
    return this.db
      .transaction(() => {
        const existing = this.read(input.id);
        if (existing) {
          if (existing.request_hash !== requestHash)
            throw new AgentRequestConflict(
              "这个 Agent ID 已用于不同资料，不能复用。请重新创建 Agent。",
            );
          // A finished workspace is what makes this request already satisfied; whether the Agent
          // could run right now is a separate question about its provider's credential.
          if (existing.stage === "complete")
            return {
              agent: toAgent(existing),
              requestId: existing.provision_request_id,
              created: false,
              shouldProvision: false,
            };
          this.db
            .prepare("UPDATE owner_agents SET stage='queued',error=NULL,updated_at=? WHERE id=?")
            .run(at, input.id);
          const retried = this.read(input.id);
          if (!retried) throw new Error("Prepared Agent disappeared");
          return {
            agent: toAgent(retried),
            requestId: retried.provision_request_id,
            created: false,
            shouldProvision: true,
          };
        }

        if (input.initialChannelId) {
          const channel = z
            .looseObject({ archived: z.number() })
            .optional()
            .parse(
              this.db
                .prepare("SELECT archived FROM owner_channels WHERE id=?")
                .get(input.initialChannelId),
            );
          if (!channel || channel.archived)
            throw new AgentRequestConflict("所选初始频道不存在或已归档，请更新表单后重试。");
        }

        const requestId = randomUUID(),
          sessionId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO owner_agents(
              id,node_id,name,role,description,provider,model_id,initial_channel_id,
              request_hash,provision_request_id,stage,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?)`,
          )
          .run(
            input.id,
            input.nodeId,
            input.name,
            input.role,
            input.description,
            input.model.provider,
            input.model.id,
            input.initialChannelId ?? null,
            requestHash,
            requestId,
            at,
            at,
          );
        this.db
          .prepare("INSERT INTO owner_agent_sessions(id,agent_id,created_at) VALUES(?,?,?)")
          .run(sessionId, input.id, at);
        const created = this.read(input.id);
        if (!created) throw new Error("Created Agent was not persisted");
        return { agent: toAgent(created), requestId, created: true, shouldProvision: true };
      })
      .immediate();
  }

  /** Node progress moves an Agent that is still preparing; it can never finish one. */
  updateStage(id: string, stage: AgentProvisionStage): void {
    this.db
      .prepare(
        `UPDATE owner_agents SET stage=?,updated_at=?
         WHERE id=? AND stage IN (${preparingStageList})`,
      )
      .run(stage, this.now(), id);
  }

  fail(id: string, message: string): AgentSummary | undefined {
    this.db
      .prepare(
        `UPDATE owner_agents SET stage='failed',error=?,updated_at=?
         WHERE id=? AND stage IN (${preparingStageList})`,
      )
      .run(message.slice(0, 240), this.now(), id);
    return this.get(id);
  }

  /**
   * Commit the node's account, this Agent's workspace and its finished stage atomically, plus the
   * optional channel membership the original request asked for. Every Agent on one node reports the
   * same account with its own workspace; the account is recorded on the node itself.
   */
  complete(id: string, identity: AgentWorkspaceIdentity, ownerChat: OwnerChat): AgentSummary {
    return this.db
      .transaction(() => {
        const current = this.read(id);
        if (!current) throw new Error("Agent record disappeared during provisioning");
        if (
          basename(identity.workspace) !== id.toLowerCase() ||
          resolve(identity.workspace) !== identity.workspace
        )
          throw new AgentRequestConflict("节点返回的 Agent 工作区路径与 Agent ID 不匹配。");
        if (!identity.username || identity.username.length > 255)
          throw new AgentRequestConflict("节点未返回运行账号的名称。");
        if (
          !Number.isSafeInteger(identity.uid) ||
          identity.uid < 1 ||
          !Number.isSafeInteger(identity.gid) ||
          identity.gid < 1
        )
          throw new AgentRequestConflict(
            "节点报告的运行账号是 root，或 UID/GID 无效；这个版本要求节点以现有普通账号运行。",
          );
        if (!/^[0-9a-f]{64}$/.test(identity.workspaceMarker))
          throw new AgentRequestConflict("节点未返回有效的 Agent 工作区原身份标记。");

        const at = this.now(),
          // Every Agent on one node runs under that node's single ordinary account. This
          // transaction records it on the node the first time and requires every later Agent on
          // that node to report the same one; a mismatch throws before anything is written.
          account: NodeAccount = {
            username: identity.username,
            uid: identity.uid,
            gid: identity.gid,
          };
        // The Agent must still be preparing. A concurrent failure or an already finished Agent
        // must not have its stage overwritten, and the node account must not be recorded for a
        // workspace that was never accepted.
        const finished = this.db
          .prepare(
            `UPDATE owner_agents SET stage='complete',error=NULL,home=?,home_marker=?,updated_at=?
             WHERE id=? AND stage IN (${preparingStageList})`,
          )
          .run(identity.workspace, identity.workspaceMarker, at, id);
        if (finished.changes !== 1)
          throw new AgentRequestConflict("Agent 的准备状态已变化，未完成的工作区不会被记录。");
        try {
          this.nodeIdentity.recordAccount(current.node_id, account);
        } catch (error) {
          // A node whose account moved is the owner's provisioning conflict, the same kind of
          // refusal as any other request this Agent cannot satisfy.
          if (error instanceof NodeAccountConflict) throw new AgentRequestConflict(error.message);
          throw error;
        }
        if (
          current.initial_channel_id &&
          !ownerChat.inviteAgentToChannel(current.initial_channel_id, id)
        )
          throw new AgentRequestConflict(
            "所选初始频道已归档或不可用，取消邀请；解除归档后可按原请求重试。",
          );
        const completed = this.read(id);
        if (!completed) throw new Error("Completed Agent was not persisted");
        return toAgent(completed);
      })
      .immediate();
  }

  private read(id: string): AgentRow | undefined {
    return agentRowSchema
      .optional()
      .parse(this.db.prepare(`${agentRowQuery} WHERE a.id=?`).get(id));
  }
}

function toAgent(row: AgentRow): AgentSummary {
  const account = nodeAccountOf(row),
    // Without an accepted workspace of its own an Agent has no run identity, even on a node whose
    // shared account is already recorded for the Agents that did finish.
    identity = account && row.home !== null ? { ...account, workspace: row.home } : null;
  return {
    id: row.id,
    nodeId: row.node_id,
    name: row.name,
    role: row.role,
    description: row.description,
    model: { provider: row.provider, id: row.model_id },
    initialChannelId: row.initial_channel_id,
    sessionId: row.session_id,
    status: deriveStatus(row.stage, row.provider_credential === 1),
    stage: row.stage,
    error: row.error,
    linuxIdentity: identity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The one owner-facing status rule. Workspace preparation stages are still provisioning, a failed
 * preparation is failed, and a finished workspace is ready exactly when the Agent's current
 * provider has a credential. The stored preparation stage alone never invents a fourth state.
 */
function deriveStatus(
  stage: AgentProvisioningStage,
  hasProviderCredential: boolean,
): AgentProvisioningStatus {
  if (stage === "failed") return "failed";
  if (stage !== "complete") return "provisioning";
  return hasProviderCredential ? "ready" : "waiting_credentials";
}

function hashRequest(input: NewAgentRequest): string {
  const canonical = JSON.stringify({
    id: input.id,
    nodeId: input.nodeId,
    name: input.name,
    role: input.role,
    description: input.description,
    model: { provider: input.model.provider, id: input.model.id },
    initialChannelId: input.initialChannelId ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
