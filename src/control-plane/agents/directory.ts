import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import type { AgentWorkspaceIdentity } from "../../nodes/agent-provisioner.js";
import type { AgentProvisionStage } from "../../nodes/protocol.js";
import type { OwnerChat } from "../owner-chat.js";
import type {
  AgentSummary,
  AgentProvisioningStage,
  AgentProvisioningStatus,
  NewAgentRequest,
} from "./contracts.js";
import type { z } from "zod";
import type { agentProfilePatchSchema } from "./contracts.js";

interface AgentRow {
  id: string;
  node_id: string;
  name: string;
  role: string;
  description: string;
  provider: string;
  model_id: string;
  initial_channel_id: string | null;
  session_id: string;
  provision_request_id: string;
  request_hash: string;
  model_ready: number;
  status: AgentProvisioningStatus;
  stage: AgentProvisioningStage;
  error: string | null;
  linux_username: string | null;
  uid: number | null;
  gid: number | null;
  home: string | null;
  home_marker: string | null;
  created_at: number;
  updated_at: number;
}

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

/** Durable owner-facing Agent identity and provisioning state. */
export class AgentDirectory {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  list(): AgentSummary[] {
    const rows = this.db
      .prepare(
        `SELECT a.id,a.node_id,a.name,a.role,a.description,a.provider,a.model_id,
                a.initial_channel_id,s.id AS session_id,a.provision_request_id,a.request_hash,
                a.status,a.model_ready,a.stage,a.error,a.linux_username,a.uid,a.gid,a.home,a.home_marker,a.created_at,a.updated_at
         FROM owner_agents a JOIN owner_agent_sessions s ON s.agent_id=a.id
         ORDER BY a.created_at,a.id`,
      )
      .all() as AgentRow[];
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
      .prepare(
        "UPDATE owner_agents SET provider=?,model_id=?,model_ready=1,updated_at=? WHERE id=?",
      )
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
          if (existing.status === "waiting_credentials")
            return {
              agent: toAgent(existing),
              requestId: existing.provision_request_id,
              created: false,
              shouldProvision: false,
            };
          this.db
            .prepare(
              "UPDATE owner_agents SET status='provisioning',stage='queued',error=NULL,updated_at=? WHERE id=?",
            )
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
          const channel = this.db
            .prepare("SELECT archived FROM owner_channels WHERE id=?")
            .get(input.initialChannelId) as { archived: number } | undefined;
          if (!channel || channel.archived)
            throw new AgentRequestConflict("所选初始频道不存在或已归档，请更新表单后重试。");
        }

        const requestId = randomUUID(),
          sessionId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO owner_agents(
              id,node_id,name,role,description,provider,model_id,initial_channel_id,
              request_json,request_hash,provision_request_id,status,stage,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'provisioning','queued',?,?)`,
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
            JSON.stringify(input),
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

  updateStage(id: string, stage: AgentProvisionStage): void {
    this.db
      .prepare("UPDATE owner_agents SET stage=?,updated_at=? WHERE id=? AND status='provisioning'")
      .run(stage, this.now(), id);
  }

  fail(id: string, message: string): AgentSummary | undefined {
    this.db
      .prepare(
        "UPDATE owner_agents SET status='failed',stage='failed',error=?,updated_at=? WHERE id=? AND status='provisioning'",
      )
      .run(message.slice(0, 240), this.now(), id);
    return this.get(id);
  }

  /**
   * Commit node-verified account and workspace facts, session readiness, and optional channel
   * membership atomically. Every Agent on one node reports the same account with its own workspace.
   */
  complete(
    id: string,
    identity: AgentWorkspaceIdentity,
    ownerChat: OwnerChat,
    modelReady = false,
  ): AgentSummary {
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
        // Every Agent on one node runs under that node's single ordinary account. A node that
        // reports a different username, UID or GID for a second Agent is not the account this
        // release requires, and storing both would silently break the Agent-to-account binding.
        const neighbour = this.db
          .prepare(
            `SELECT linux_username,uid,gid FROM owner_agents
             WHERE node_id=? AND id<>? AND linux_username IS NOT NULL AND uid IS NOT NULL
               AND gid IS NOT NULL LIMIT 1`,
          )
          .get(current.node_id, id) as
          { linux_username: string; uid: number; gid: number } | undefined;
        if (
          neighbour &&
          (neighbour.linux_username !== identity.username ||
            neighbour.uid !== identity.uid ||
            neighbour.gid !== identity.gid)
        )
          throw new AgentRequestConflict(
            "同一节点上的 Agent 必须共用该节点运行账号；节点返回了不同账号，请检查节点部署。",
          );

        const at = this.now();
        this.db
          .prepare(
            `UPDATE owner_agents SET status='waiting_credentials',stage='complete',error=NULL,
              linux_username=?,uid=?,gid=?,home=?,home_marker=?,updated_at=? WHERE id=?`,
          )
          .run(
            identity.username,
            identity.uid,
            identity.gid,
            identity.workspace,
            identity.workspaceMarker,
            at,
            id,
          );
        this.db
          .prepare("UPDATE owner_agent_sessions SET verified_at=? WHERE agent_id=?")
          .run(at, id);
        this.db
          .prepare("UPDATE owner_agents SET model_ready=? WHERE id=?")
          .run(modelReady ? 1 : 0, id);
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

  setProviderReady(provider: string, ready: boolean): void {
    this.db
      .prepare(
        "UPDATE owner_agents SET model_ready=?,updated_at=? WHERE provider=? AND status='waiting_credentials'",
      )
      .run(ready ? 1 : 0, this.now(), provider);
  }

  private read(id: string): AgentRow | undefined {
    return this.db
      .prepare(
        `SELECT a.id,a.node_id,a.name,a.role,a.description,a.provider,a.model_id,
                a.initial_channel_id,s.id AS session_id,a.provision_request_id,a.request_hash,
                a.status,a.model_ready,a.stage,a.error,a.linux_username,a.uid,a.gid,a.home,a.home_marker,a.created_at,a.updated_at
         FROM owner_agents a JOIN owner_agent_sessions s ON s.agent_id=a.id WHERE a.id=?`,
      )
      .get(id) as AgentRow | undefined;
  }
}

function toAgent(row: AgentRow): AgentSummary {
  const identity =
    row.linux_username !== null && row.uid !== null && row.gid !== null && row.home !== null
      ? { username: row.linux_username, uid: row.uid, gid: row.gid, workspace: row.home }
      : null;
  return {
    id: row.id,
    nodeId: row.node_id,
    name: row.name,
    role: row.role,
    description: row.description,
    model: { provider: row.provider, id: row.model_id },
    initialChannelId: row.initial_channel_id,
    sessionId: row.session_id,
    status: row.status === "waiting_credentials" && row.model_ready === 1 ? "ready" : row.status,
    stage: row.stage,
    error: row.error,
    linuxIdentity: identity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
