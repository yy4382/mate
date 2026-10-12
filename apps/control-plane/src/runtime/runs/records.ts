import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { OwnerChat } from "../../conversations/service.js";
import { sourceMessage } from "../../prompts/index.js";
import { providerCredentialExistsSql } from "../../providers/credentials.js";
import { recordAgentActivity } from "../activity.js";
import { queueUncertainOperationFacts } from "../recovery/context.js";
import { AgentSession } from "../session/service.js";

// Admission scans continue on later passes; this does not cap an Agent's work.
const maxCandidatesPerPass = 100;
const consecutiveContextFailuresBeforePause = 2;
const retryDelayMs = 1500;
const maxRetryDelayMs = 5 * 60_000;
/** Bounds exponent growth even after a long sequence of failures. */
const maxRetryExponent = 16;

function classifyRunFailure(code: string | undefined) {
  if (code === "node_disconnected" || code === "aborted") return "interrupted";
  if (code === "credentials_invalid" || code === "model_unavailable") return "credentials";
  if (code === "context_failed") return "context";
  if (code === "execution_environment") return "environment";
  return "temporary";
}

function runRetryDelayMs(consecutiveFailures: number) {
  return Math.min(
    maxRetryDelayMs,
    retryDelayMs * 2 ** Math.min(consecutiveFailures - 1, maxRetryExponent),
  );
}

export interface RunCandidate {
  agent_id: string;
  node_id: string;
  home: string | null;
  home_marker: string | null;
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

export class RunRecords {
  constructor(
    private readonly db: Database.Database,
    private readonly chat: OwnerChat,
    private readonly now: () => number,
  ) {}
  pendingCandidates(onlineNodeIds: string[]): RunCandidate[] {
    if (onlineNodeIds.length === 0) return [];
    const onlineNodePlaceholders = onlineNodeIds.map(() => "?").join(",");
    return this.db
      .prepare<unknown[], RunCandidate>(
        `SELECT a.id AS agent_id,a.node_id,a.home,a.home_marker,s.id AS session_id,a.name,a.role,a.description,
                a.provider,a.model_id,d.channel_id,c.visibility AS channel_visibility,
                d.id AS delivery_id
         FROM owner_message_deliveries d
         JOIN owner_messages m ON m.id=d.message_id
         JOIN owner_agents a ON a.id=d.recipient_id
         JOIN owner_agent_sessions s ON s.agent_id=a.id
         JOIN owner_channels c ON c.id=d.channel_id
         WHERE d.recipient_kind='agent' AND d.state='pending'
           AND (c.archived=0 OR m.internal_kind='reminder')
           AND a.node_id IN (${onlineNodePlaceholders})
           AND a.stage='complete'
           AND NOT EXISTS (SELECT 1 FROM owner_agent_run_control ctl WHERE ctl.agent_id=a.id AND ctl.paused_reason IS NOT NULL)
           AND ${providerCredentialExistsSql}
           AND NOT EXISTS (SELECT 1 FROM owner_agent_runs r WHERE r.agent_id=a.id AND r.state='running')
           AND NOT EXISTS (
             SELECT 1 FROM owner_message_deliveries earlier
             JOIN owner_messages earlier_message ON earlier_message.id=earlier.message_id
             JOIN owner_channels earlier_source
               ON earlier_source.id=earlier.channel_id
             WHERE earlier.recipient_kind='agent' AND earlier.recipient_id=a.id
               AND earlier.state='pending' AND earlier.seq<d.seq
               AND (earlier_source.archived=0 OR earlier_message.internal_kind='reminder')
           )
           AND NOT EXISTS (
             SELECT 1 FROM owner_agent_runs retry
             WHERE retry.delivery_id=d.id AND retry.state='failed' AND retry.retry_at>?
           )
         ORDER BY d.seq LIMIT ${maxCandidatesPerPass}`,
      )
      .all(...onlineNodeIds, this.now());
  }

  beginRun(candidate: RunCandidate): string | undefined {
    const id = randomUUID();
    try {
      return this.db
        .transaction(() => {
          const current = this.db
            .prepare<unknown[], { visibility: "public" | "private" }>(
              `SELECT c.visibility FROM owner_agents a
               JOIN owner_message_deliveries d ON d.recipient_id=a.id AND d.recipient_kind='agent'
               JOIN owner_messages m ON m.id=d.message_id
               JOIN owner_channels c ON c.id=d.channel_id
               WHERE a.id=? AND a.stage='complete'
                 AND ${providerCredentialExistsSql}
                 AND (c.archived=0 OR m.internal_kind='reminder')
                 AND d.id=? AND d.state='pending'`,
            )
            .get(candidate.agent_id, candidate.delivery_id);
          if (!current) return undefined;
          candidate.channel_visibility = current.visibility;
          const inputStart = this.db
            .prepare<unknown[], { seq: number }>(
              `SELECT seq FROM owner_message_deliveries WHERE id=?`,
            )
            .get(candidate.delivery_id);
          if (!inputStart) return undefined;
          const firstDifferentSource = this.db
            .prepare<unknown[], { seq: number | null }>(
              `SELECT MIN(seq) AS seq FROM owner_message_deliveries
               WHERE recipient_id=? AND recipient_kind='agent' AND seq>? AND channel_id<>?`,
            )
            .get(candidate.agent_id, inputStart.seq, candidate.channel_id);
          const maxSequence = this.db
            .prepare<unknown[], { seq: number }>(
              `SELECT COALESCE(MAX(seq),0) AS seq
               FROM owner_message_deliveries WHERE recipient_id=? AND recipient_kind='agent'`,
            )
            .get(candidate.agent_id);
          if (!maxSequence) throw new Error("Message delivery aggregate did not return a row");
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

  readRunContext(
    runId: string,
    agentId: string,
  ): import("../session/record.js").ModelContextMessage[] | undefined {
    const run = this.db
      .prepare<
        unknown[],
        {
          input_end_seq: number;
          context_history_end_seq: number;
          delivery_id: string;
          channel_id: string;
        }
      >(
        `SELECT r.input_end_seq,r.context_history_end_seq,r.delivery_id,d.channel_id
         FROM owner_agent_runs r JOIN owner_message_deliveries d ON d.id=r.delivery_id
         WHERE r.id=? AND r.agent_id=? AND r.state='running'`,
      )
      .get(runId, agentId);
    if (!run) return undefined;
    const inputStart = this.db
      .prepare<unknown[], { seq: number }>(`SELECT seq FROM owner_message_deliveries WHERE id=?`)
      .get(run.delivery_id);
    if (!inputStart) return undefined;
    queueUncertainOperationFacts(this.db, agentId, this.now());
    const input = this.db
      .prepare<
        unknown[],
        {
          id: string;
          text: string;
          created_at: number;
          root_id: string | null;
          quote_id: string | null;
          visibility: string;
        }
      >(
        `SELECT d.id,m.text,m.created_at,m.root_id,m.quote_id,c.visibility
      FROM owner_message_deliveries d JOIN owner_messages m ON m.id=d.message_id
      JOIN owner_channels c ON c.id=d.channel_id
      WHERE d.recipient_kind='agent' AND d.recipient_id=? AND d.channel_id=? AND d.state='pending'
        AND d.seq>=? AND d.seq<=?
        AND (NOT EXISTS (SELECT 1 FROM owner_message_deliveries seed JOIN owner_messages sm ON sm.id=seed.message_id WHERE seed.id=? AND sm.internal_kind='reminder') OR m.internal_kind='reminder')
      ORDER BY d.seq`,
      )
      .all(agentId, run.channel_id, inputStart.seq, run.input_end_seq, run.delivery_id);
    const messages = [
      ...input.map((row) => ({
        id: row.id,
        actionScopeId: run.delivery_id,
        pending: true,
        message: sourceMessage(run.channel_id, row),
      })),
      // Append pending late-receipt corrections after the admitted input batch.
      ...new AgentSession(this.db).pendingCorrections(agentId, run.delivery_id),
    ];
    return messages;
  }

  finishRun(
    { runId, agentId }: { runId: string; agentId: string },
    { ok, code, reason }: { ok: boolean; code?: string | undefined; reason?: string | undefined },
  ): void {
    const existing = this.db
      .prepare<unknown[], { state: string }>(
        "SELECT state FROM owner_agent_runs WHERE id=? AND agent_id=?",
      )
      .get(runId, agentId);
    if (!existing || existing.state !== "running") return;
    if (ok) {
      if (this.chat.deliveries.completeAgentRun(runId, agentId))
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
    const failure = classifyRunFailure(code);
    const interrupted = failure === "interrupted";
    const credentialFailure = failure === "credentials";
    const contextFailure = failure === "context";
    const environmentFailure = failure === "environment";
    let contextPaused = false;
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
        .prepare<unknown[], { temporary_failures: number }>(
          `INSERT INTO owner_agent_run_control(agent_id,temporary_failures,updated_at) VALUES(?,1,?)
         ON CONFLICT(agent_id) DO UPDATE SET temporary_failures=temporary_failures+1,updated_at=excluded.updated_at
         RETURNING temporary_failures`,
        )
        .get(agentId, this.now());
      if (!row) throw new Error("Run retry update did not return a row");
      delay = runRetryDelayMs(row.temporary_failures);
      const priorFailure = this.db
        .prepare<unknown[], { error_code: string }>(
          "SELECT error_code FROM owner_agent_runs WHERE agent_id=? AND state='failed' ORDER BY rowid DESC LIMIT 1",
        )
        .get(agentId);
      if (
        contextFailure &&
        row.temporary_failures >= consecutiveContextFailuresBeforePause &&
        priorFailure?.error_code === "context_failed"
      ) {
        this.db
          .prepare(
            "UPDATE owner_agent_run_control SET paused_reason='context',updated_at=? WHERE agent_id=?",
          )
          .run(this.now(), agentId);
        contextPaused = true;
      }
    }
    this.db
      .prepare(
        "UPDATE owner_agent_runs SET state='failed',error_code=?,retry_at=?,completed_at=? WHERE id=? AND agent_id=? AND state='running'",
      )
      .run(
        interrupted ? "interrupted" : safeFailureCode(code),
        credentialFailure || contextPaused ? null : this.now() + delay,
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
          : contextPaused
            ? "上下文压缩连续失败，运行已暂停；请检查模型容量或摘要响应。"
            : environmentFailure
              ? "原节点运行账号或 Agent 工作区未通过核验；保留队列，稍后退避重试。"
              : "模型服务暂时失败，稍后退避重试。",
      detail: {
        code: safeFailureCode(code),
        ...((contextFailure || environmentFailure) && reason ? { reason } : {}),
      },
      at: this.now(),
    });
  }

  recoverInterruptedRuns(): void {
    this.db
      .transaction(() => {
        const at = this.now();
        const interrupted = this.db
          .prepare<unknown[], { id: string; agent_id: string; node_id: string }>(
            `UPDATE owner_agent_runs SET state='failed',error_code='interrupted',retry_at=?,completed_at=?
           WHERE state='running' RETURNING id,agent_id,node_id`,
          )
          .all(at, at);
        for (const run of interrupted)
          recordAgentActivity(this.db, {
            agentId: run.agent_id,
            nodeId: run.node_id,
            kind: "run.interrupted",
            referenceId: run.id,
            summary: "控制面重启中断了运行；待处理消息仍在队列中。",
            at,
          });
      })
      .immediate();
  }

  invalidateRun(runId: string, agentId: string): void {
    this.db
      .transaction(() => {
        this.db
          .prepare(
            "UPDATE owner_agent_runs SET state='failed',error_code='configuration_changed',retry_at=?,completed_at=? WHERE id=? AND state='running'",
          )
          .run(this.now(), this.now(), runId);
        recordAgentActivity(this.db, {
          agentId,
          kind: "run.interrupted",
          referenceId: runId,
          summary: "模型或凭据变更使旧运行失效；待处理消息将从已确认记录恢复。",
          at: this.now(),
        });
      })
      .immediate();
  }
  credentialsChanged(provider: string, ready: boolean): void {
    if (ready)
      this.db
        .prepare(
          `UPDATE owner_agent_run_control SET paused_reason=NULL,temporary_failures=0,updated_at=?
       WHERE paused_reason='credentials' AND agent_id IN (SELECT id FROM owner_agents WHERE provider=?)`,
        )
        .run(this.now(), provider);
  }

  modelChanged(agentId: string): void {
    this.db
      .prepare(
        "UPDATE owner_agent_run_control SET paused_reason=NULL,temporary_failures=0,updated_at=? WHERE agent_id=? AND paused_reason IN ('credentials','context')",
      )
      .run(this.now(), agentId);
  }

  current(runId: string, agentId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM owner_agent_runs WHERE id=? AND agent_id=? AND state='running'")
      .get(runId, agentId);
  }
}
function safeFailureCode(code: string | undefined): string {
  return code && /^[a-z_]{1,40}$/.test(code) ? code : "run_failed";
}
