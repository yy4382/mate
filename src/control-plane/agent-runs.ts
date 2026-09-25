import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ModelCredentialDirectory } from "./model-credentials.js";
import type { AgentRunContextPage, OwnerChat } from "./owner-chat.js";
import { NodeDirectory, type NodeAgentRunStart } from "./nodes/directory.js";

const schedulerIntervalMs = 250;
const retryDelayMs = 1500;

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

  constructor(
    private readonly db: Database.Database,
    private readonly nodes: NodeDirectory,
    private readonly credentials: ModelCredentialDirectory,
    private readonly chat: OwnerChat,
    now: () => number = Date.now,
  ) {
    this.now = now;
    this.recoverInterruptedRuns();
    nodes.setAgentRunHandlers({
      context: (runId, agentId, cursor, limit) =>
        this.readRunContext(runId, agentId, cursor, limit),
      journal: (runId, nodeId, agentId, requestId, text, replayOnly) =>
        chat.commitAgentReply(runId, nodeId, agentId, requestId, text, replayOnly),
      tool: (runId, nodeId, agentId, toolCallId, operation, input) =>
        chat.executeAgentTool(runId, nodeId, agentId, toolCallId, operation, input),
      result: (runId, agentId, ok, code) => this.finishRun(runId, agentId, ok, code),
    });
    this.timer = setInterval(() => this.wake(), schedulerIntervalMs);
    this.timer.unref?.();
    this.wake();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  wake(): void {
    if (!this.closed) void this.drain();
  }

  credentialsChanged(provider: string): number {
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
        `SELECT a.id AS agent_id,a.node_id,s.id AS session_id,a.name,a.role,a.description,
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
      this.chat.completeAgentRunSilently(runId, agentId);
      return;
    }
    this.db
      .prepare(
        "UPDATE owner_agent_runs SET state='failed',error_code=?,retry_at=?,completed_at=? WHERE id=? AND agent_id=? AND state='running'",
      )
      .run(safeFailureCode(code), this.now() + retryDelayMs, this.now(), runId, agentId);
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
