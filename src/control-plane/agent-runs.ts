import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ModelCredentialDirectory } from "./model-credentials.js";
import type { AgentRunContextPage, OwnerChat } from "./owner-chat.js";
import { NodeDirectory, type NodeAgentRunStart } from "./nodes/directory.js";
import {
  AgentProcessOperationBroker,
  deriveAgentProcessOperationId,
} from "./agent-process-operations.js";
import {
  agentConversationOperations,
  agentProcessToolOperations,
  agentToolSchemas,
} from "./agent-tools.js";
import { z } from "zod";
import { recordAgentActivity } from "./activity.js";

const schedulerIntervalMs = 250;
const retryDelayMs = 1500;
const maxRetryDelayMs = 5 * 60_000;

interface RunCandidate {
  agent_id: string;
  node_id: string;
  session_id: string;
  name: string;
  role: string;
  description: string;
  provider: string;
  model_id: string;
  channel_id: string;
  channel_visibility: "public" | "private";
  delivery_id: string;
}

/** Durable owner-channel run admission and the single primary run path for each Agent. */
export class AgentRunCoordinator {
  private readonly activeAgents = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private draining = false;
  private closed = false;
  private readonly now: () => number;
  readonly processOperations: AgentProcessOperationBroker;

  constructor(
    private readonly db: Database.Database,
    private readonly nodes: NodeDirectory,
    private readonly credentials: ModelCredentialDirectory,
    private readonly chat: OwnerChat,
    now: () => number = Date.now,
  ) {
    this.now = now;
    this.processOperations = new AgentProcessOperationBroker(db, nodes, now);
    this.recoverInterruptedRuns();
    nodes.setProcessReceiptHandler(
      (nodeId, receipt) => {
        const outcome = this.processOperations.reconcile(nodeId, receipt);
        if (
          outcome.corrected &&
          outcome.result &&
          outcome.result.state !== "unknown" &&
          outcome.result.state !== "executing"
        ) {
          this.chat.notifyAgentReceiptCorrection(
            receipt.agentId,
            receipt.operationId,
            outcome.result.state,
          );
          this.wake();
        }
      },
      () => this.wake(),
    );
    nodes.setAgentRunHandlers({
      context: (runId, agentId, cursor, limit) =>
        this.readRunContext(runId, agentId, cursor, limit),
      journal: (runId, nodeId, agentId, requestId, text, replayOnly) =>
        chat.commitAgentReply(runId, nodeId, agentId, requestId, text, replayOnly),
      tool: (runId, nodeId, agentId, toolCallId, operation, input) =>
        this.executeAgentTool(runId, nodeId, agentId, toolCallId, operation, input),
      result: (runId, agentId, ok, code) => this.finishRun(runId, agentId, ok, code),
    });
    this.timer = setInterval(() => this.wake(), schedulerIntervalMs);
    this.timer.unref?.();
    this.wake();
  }

  private async executeAgentTool(
    runId: string,
    nodeId: string,
    agentId: string,
    toolCallId: string,
    operation: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    if (operation !== "tools.call")
      return this.chat.executeAgentTool(runId, nodeId, agentId, toolCallId, operation, input);
    const request = agentToolSchemas["tools.call"].safeParse(input);
    if (request.success && request.data.name === "session.compact") {
      try {
        return {
          ok: true,
          result: this.commitCompaction(runId, nodeId, agentId, toolCallId, request.data.input),
        };
      } catch {
        return { ok: false, error: "Session compaction was refused" };
      }
    }
    if (!request.success || !Object.hasOwn(agentProcessToolOperations, request.data.name))
      return this.chat.executeAgentTool(runId, nodeId, agentId, toolCallId, operation, input);

    try {
      const authorized = this.chat.authorizeAgentProcessOperation(
          runId,
          nodeId,
          agentId,
          request.data.name,
          request.data.input,
        ),
        operationId = deriveAgentProcessOperationId(agentId, toolCallId),
        result = await this.processOperations.execute({
          runId,
          nodeId,
          agentId,
          actionScopeId: authorized.actionScopeId,
          stableActionId: toolCallId,
          operationId,
          operation: authorized.operation,
        });
      return {
        ok: true,
        result: { operationId: result.operationId, state: result.state, receipt: result.receipt },
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof z.ZodError ? "Invalid tool input" : "Agent tool request was refused",
      };
    }
  }

  private commitCompaction(
    runId: string,
    nodeId: string,
    agentId: string,
    actionId: string,
    input: unknown,
  ): unknown {
    const { summary, snapshot } =
      agentConversationOperations["session.compact"].schema.parse(input);
    const snapshotJson = JSON.stringify(snapshot);
    if (summary.length + snapshotJson.length > 19_000) throw new Error("Snapshot is too large");
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ summary, snapshot }))
      .digest("hex");
    return this.db
      .transaction(() => {
        const run = this.db
          .prepare(
            `SELECT r.delivery_id,r.context_history_end_seq,r.independent_review,s.id AS logical_session_id
         FROM owner_agent_runs r JOIN owner_agent_sessions s ON s.agent_id=r.agent_id
         WHERE r.id=? AND r.node_id=? AND r.agent_id=? AND r.state='running'`,
          )
          .get(runId, nodeId, agentId) as
          | {
              delivery_id: string;
              context_history_end_seq: number;
              independent_review: number;
              logical_session_id: string;
            }
          | undefined;
        if (
          !run ||
          run.independent_review ||
          run.context_history_end_seq < 1 ||
          !actionId.startsWith(`mate:${run.delivery_id}:`)
        )
          throw new Error("Run cannot compact session");
        const old = this.db
          .prepare(
            `SELECT request_hash,model_session_id,through_seq FROM owner_agent_session_snapshots
         WHERE agent_id=? AND action_id=?`,
          )
          .get(agentId, actionId) as
          { request_hash: string; model_session_id: string; through_seq: number } | undefined;
        if (old) {
          if (old.request_hash !== requestHash)
            throw new Error("Compaction action identity conflict");
          return {
            committed: true,
            effective: "next_run",
            sessionId: old.model_session_id,
            throughSequence: old.through_seq,
          };
        }
        const modelSessionId = randomUUID(),
          at = this.now();
        this.db
          .prepare(
            `INSERT INTO owner_agent_session_snapshots(
          id,agent_id,action_id,request_hash,through_seq,model_session_id,summary,snapshot_json,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            randomUUID(),
            agentId,
            actionId,
            requestHash,
            run.context_history_end_seq,
            modelSessionId,
            summary,
            snapshotJson,
            at,
          );
        this.db
          .prepare("UPDATE owner_agent_sessions SET model_session_id=? WHERE id=?")
          .run(modelSessionId, run.logical_session_id);
        recordAgentActivity(this.db, {
          agentId,
          nodeId,
          kind: "session.compacted",
          referenceId: modelSessionId,
          summary: "会话摘要和快照已由控制面确认；下一次运行使用新模型会话。",
          detail: { summary, snapshot, throughSequence: run.context_history_end_seq },
          at,
        });
        return {
          committed: true,
          effective: "next_run",
          sessionId: modelSessionId,
          throughSequence: run.context_history_end_seq,
        };
      })
      .immediate();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  wake(): void {
    if (!this.closed) void this.drain();
  }

  credentialsChanged(provider: string): number {
    this.db
      .prepare(
        `UPDATE owner_agent_run_control SET paused_reason=NULL,temporary_failures=0,updated_at=?
       WHERE paused_reason='credentials' AND agent_id IN (SELECT id FROM owner_agents WHERE provider=?)`,
      )
      .run(this.now(), provider);
    const running = this.db
      .prepare(
        `SELECT r.id,a.id AS agent_id FROM owner_agent_runs r
         JOIN owner_agents a ON a.id=r.agent_id
         WHERE r.state='running' AND a.provider=?`,
      )
      .all(provider) as Array<{ id: string; agent_id: string }>;
    let canceled = 0;
    for (const run of running) {
      if (this.nodes.cancelAgentRun(run.id, run.agent_id, "credentials_changed")) canceled++;
    }
    return canceled;
  }

  pauseAgent(agentId: string): boolean {
    const agent = this.db.prepare("SELECT id FROM owner_agents WHERE id=?").get(agentId);
    if (!agent) return false;
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `INSERT INTO owner_agent_run_control(agent_id,paused_reason,updated_at) VALUES(?,'manual',?)
         ON CONFLICT(agent_id) DO UPDATE SET paused_reason='manual',updated_at=excluded.updated_at`,
          )
          .run(agentId, this.now());
        this.db
          .prepare(
            `UPDATE owner_agent_runs SET state='failed',error_code='manual_pause',retry_at=NULL,completed_at=?
         WHERE agent_id=? AND state='running'`,
          )
          .run(this.now(), agentId);
        recordAgentActivity(this.db, {
          agentId,
          kind: "run.paused",
          summary: "所有者已暂停 Agent 运行。",
          at: this.now(),
        });
      })
      .immediate();
    const pending = this.db
      .prepare(
        `SELECT id FROM owner_agent_runs WHERE agent_id=? AND error_code='manual_pause' ORDER BY started_at DESC LIMIT 1`,
      )
      .get(agentId) as { id: string } | undefined;
    if (pending) this.nodes.cancelAgentRun(pending.id, agentId, "manual_pause");
    return true;
  }

  resumeAgent(agentId: string): boolean {
    const row = this.db
      .prepare("SELECT paused_reason FROM owner_agent_run_control WHERE agent_id=?")
      .get(agentId) as { paused_reason: string | null } | undefined;
    if (!row) return false;
    this.db
      .prepare(
        "UPDATE owner_agent_run_control SET paused_reason=NULL,temporary_failures=0,updated_at=? WHERE agent_id=?",
      )
      .run(this.now(), agentId);
    recordAgentActivity(this.db, {
      agentId,
      kind: "run.resumed",
      summary: "所有者已恢复 Agent 运行。",
      at: this.now(),
    });
    this.wake();
    return true;
  }

  pauseReason(agentId: string): string | null {
    const row = this.db
      .prepare("SELECT paused_reason FROM owner_agent_run_control WHERE agent_id=?")
      .get(agentId) as { paused_reason: string | null } | undefined;
    return row?.paused_reason ?? null;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      const onlineNodeIds = this.nodes
        .list()
        .filter((node) => node.online)
        .map((node) => node.id);
      for (const candidate of this.pendingCandidates(onlineNodeIds)) {
        if (this.closed) return;
        if (this.activeAgents.has(candidate.agent_id)) continue;
        const apiKey = this.credentials.readForRun(candidate.provider);
        if (!apiKey) continue;
        const runId = this.beginRun(candidate);
        if (!runId) continue;
        this.activeAgents.add(candidate.agent_id);
        const request: NodeAgentRunStart = {
          type: "control.agent.run",
          requestId: runId,
          runId,
          agentId: candidate.agent_id,
          sessionId: candidate.session_id,
          actionScopeId: candidate.delivery_id,
          provider: candidate.provider,
          modelId: candidate.model_id,
          apiKey,
          channelId: candidate.channel_id,
          channelVisibility: candidate.channel_visibility,
          prompt: {
            name: candidate.name,
            role: candidate.role,
            description: candidate.description,
          },
        };
        void this.nodes
          .runAgent(candidate.node_id, request)
          .catch(() => {
            if (!this.closed) this.finishRun(runId, candidate.agent_id, false, "node_disconnected");
          })
          .finally(() => {
            this.activeAgents.delete(candidate.agent_id);
            if (!this.closed) this.wake();
          });
      }
    } finally {
      this.draining = false;
    }
  }

  private pendingCandidates(onlineNodeIds: string[]): RunCandidate[] {
    if (onlineNodeIds.length === 0) return [];
    const onlineNodePlaceholders = onlineNodeIds.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT a.id AS agent_id,a.node_id,COALESCE(s.model_session_id,s.id) AS session_id,a.name,a.role,a.description,
                a.provider,a.model_id,d.channel_id,c.visibility AS channel_visibility,
                d.id AS delivery_id
         FROM owner_message_deliveries d
         JOIN owner_agents a ON a.id=d.recipient_id
         JOIN owner_agent_sessions s ON s.agent_id=a.id
         JOIN owner_channels c ON c.id=d.channel_id AND c.archived=0
         JOIN owner_agent_session_journal j
           ON j.agent_id=a.id AND j.message_id=d.message_id AND j.role='user'
         WHERE d.recipient_kind='agent' AND d.state='pending'
           AND a.node_id IN (${onlineNodePlaceholders})
           AND a.status='waiting_credentials' AND a.model_ready=1
           AND NOT EXISTS (SELECT 1 FROM owner_agent_run_control ctl WHERE ctl.agent_id=a.id AND ctl.paused_reason IS NOT NULL)
           AND EXISTS (SELECT 1 FROM model_credentials c WHERE c.provider=a.provider)
           AND NOT EXISTS (SELECT 1 FROM owner_agent_runs r WHERE r.agent_id=a.id AND r.state='running')
           AND NOT EXISTS (
             SELECT 1 FROM owner_message_deliveries earlier
             JOIN owner_channels earlier_source
               ON earlier_source.id=earlier.channel_id AND earlier_source.archived=0
             WHERE earlier.recipient_kind='agent' AND earlier.recipient_id=a.id
               AND earlier.state='pending' AND earlier.seq<d.seq
               AND EXISTS (
                 SELECT 1 FROM owner_agent_session_journal prior
                 WHERE prior.agent_id=a.id AND prior.message_id=earlier.message_id
                   AND prior.role='user'
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM owner_agent_runs retry
             WHERE retry.delivery_id=d.id AND retry.state='failed' AND retry.retry_at>?
           )
         ORDER BY d.seq LIMIT 100`,
      )
      .all(...onlineNodeIds, this.now()) as RunCandidate[];
  }

  private beginRun(candidate: RunCandidate): string | undefined {
    const id = randomUUID();
    try {
      return this.db
        .transaction(() => {
          const current = this.db
            .prepare(
              `SELECT c.visibility FROM owner_agents a
               JOIN owner_message_deliveries d ON d.recipient_id=a.id AND d.recipient_kind='agent'
               JOIN owner_agent_session_journal j
                 ON j.agent_id=a.id AND j.message_id=d.message_id AND j.role='user'
               JOIN owner_channels c ON c.id=d.channel_id
               WHERE a.id=? AND a.status='waiting_credentials' AND a.model_ready=1
                 AND c.archived=0
                 AND d.id=? AND d.state='pending'`,
            )
            .get(candidate.agent_id, candidate.delivery_id) as
            { visibility: "public" | "private" } | undefined;
          if (!current) return undefined;
          candidate.channel_visibility = current.visibility;
          const inputStart = this.db
            .prepare(
              `SELECT j.seq FROM owner_message_deliveries d
               JOIN owner_agent_session_journal j
                 ON j.agent_id=d.recipient_id AND j.message_id=d.message_id AND j.role='user'
               WHERE d.id=?`,
            )
            .get(candidate.delivery_id) as { seq: number } | undefined;
          if (!inputStart) return undefined;
          const firstDifferentSource = this.db
            .prepare(
              `SELECT MIN(seq) AS seq FROM owner_agent_session_journal
               WHERE agent_id=? AND role='user' AND seq>? AND channel_id<>?`,
            )
            .get(candidate.agent_id, inputStart.seq, candidate.channel_id) as
            { seq: number | null } | undefined;
          const maxSequence = this.db
            .prepare(
              `SELECT COALESCE(MAX(seq),0) AS seq
               FROM owner_agent_session_journal WHERE agent_id=?`,
            )
            .get(candidate.agent_id) as { seq: number };
          const inputEndSequence =
            firstDifferentSource?.seq === null || firstDifferentSource === undefined
              ? maxSequence.seq
              : firstDifferentSource.seq - 1;
          this.db
            .prepare(
              `INSERT INTO owner_agent_runs(
                 id,agent_id,node_id,delivery_id,state,started_at,input_end_seq,
                 context_history_end_seq
               ) VALUES(?,?,?,?,'running',?,?,?)`,
            )
            .run(
              id,
              candidate.agent_id,
              candidate.node_id,
              candidate.delivery_id,
              this.now(),
              Math.max(inputStart.seq, inputEndSequence),
              maxSequence.seq,
            );
          recordAgentActivity(this.db, {
            agentId: candidate.agent_id,
            nodeId: candidate.node_id,
            kind: "run.started",
            referenceId: id,
            summary: "Agent 运行已开始。",
            at: this.now(),
          });
          return id;
        })
        .immediate();
    } catch {
      // A competing scheduler or the partial unique index already owns this Agent's run.
      return undefined;
    }
  }

  private readRunContext(
    runId: string,
    agentId: string,
    cursor: number,
    limit: number,
  ): AgentRunContextPage | undefined {
    const run = this.db
      .prepare(
        `SELECT r.input_end_seq,r.context_history_end_seq,r.delivery_id,d.channel_id
         FROM owner_agent_runs r JOIN owner_message_deliveries d ON d.id=r.delivery_id
         WHERE r.id=? AND r.agent_id=? AND r.state='running'`,
      )
      .get(runId, agentId) as
      | {
          input_end_seq: number;
          context_history_end_seq: number;
          delivery_id: string;
          channel_id: string;
        }
      | undefined;
    if (!run) return undefined;
    const inputStart = this.db
      .prepare(
        `SELECT j.seq FROM owner_message_deliveries d
         JOIN owner_agent_session_journal j
           ON j.agent_id=d.recipient_id AND j.message_id=d.message_id AND j.role='user'
         WHERE d.id=?`,
      )
      .get(run.delivery_id) as { seq: number } | undefined;
    return inputStart
      ? this.chat.listAgentRunContext(
          agentId,
          cursor,
          limit,
          run.context_history_end_seq,
          run.channel_id,
          inputStart.seq,
          run.input_end_seq,
        )
      : undefined;
  }

  private finishRun(runId: string, agentId: string, ok: boolean, code?: string): void {
    const existing = this.db
      .prepare("SELECT state FROM owner_agent_runs WHERE id=? AND agent_id=?")
      .get(runId, agentId) as { state: string } | undefined;
    if (!existing || existing.state !== "running") return;
    if (ok) {
      if (this.chat.completeAgentRunSilently(runId, agentId))
        recordAgentActivity(this.db, {
          agentId,
          kind: "run.completed",
          referenceId: runId,
          summary: "Agent 运行已完成。",
          at: this.now(),
        });
      this.db
        .prepare(
          "UPDATE owner_agent_run_control SET temporary_failures=0,updated_at=? WHERE agent_id=?",
        )
        .run(this.now(), agentId);
      return;
    }
    const interrupted = code === "node_disconnected" || code === "aborted";
    const credentialFailure = code === "credentials_invalid" || code === "model_unavailable";
    let delay = 0;
    if (credentialFailure)
      this.db
        .prepare(
          `INSERT INTO owner_agent_run_control(agent_id,paused_reason,updated_at) VALUES(?,'credentials',?)
       ON CONFLICT(agent_id) DO UPDATE SET paused_reason='credentials',updated_at=excluded.updated_at`,
        )
        .run(agentId, this.now());
    else if (!interrupted) {
      const row = this.db
        .prepare(
          `INSERT INTO owner_agent_run_control(agent_id,temporary_failures,updated_at) VALUES(?,1,?)
         ON CONFLICT(agent_id) DO UPDATE SET temporary_failures=temporary_failures+1,updated_at=excluded.updated_at
         RETURNING temporary_failures`,
        )
        .get(agentId, this.now()) as { temporary_failures: number };
      delay = Math.min(
        maxRetryDelayMs,
        retryDelayMs * 2 ** Math.min(row.temporary_failures - 1, 16),
      );
    }
    this.db
      .prepare(
        "UPDATE owner_agent_runs SET state='failed',error_code=?,retry_at=?,completed_at=? WHERE id=? AND agent_id=? AND state='running'",
      )
      .run(
        interrupted ? "interrupted" : safeFailureCode(code),
        credentialFailure ? null : this.now() + delay,
        this.now(),
        runId,
        agentId,
      );
    recordAgentActivity(this.db, {
      agentId,
      kind: interrupted ? "run.interrupted" : "run.failed",
      referenceId: runId,
      summary: interrupted
        ? "运行因连接中断而停止；待处理消息仍在队列中。"
        : credentialFailure
          ? "模型凭据或模型配置需要所有者处理，运行已暂停。"
          : "模型服务暂时失败，稍后退避重试。",
      detail: { code: safeFailureCode(code) },
      at: this.now(),
    });
  }

  private recoverInterruptedRuns(): void {
    this.db
      .prepare(
        "UPDATE owner_agent_runs SET state='failed',error_code='interrupted',retry_at=?,completed_at=? WHERE state='running'",
      )
      .run(this.now(), this.now());
  }
}

function safeFailureCode(code: string | undefined): string {
  return code && /^[a-z_]{1,40}$/.test(code) ? code : "run_failed";
}

export type AgentRunContext = AgentRunContextPage;
