import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ModelCredentialDirectory } from "./model-credentials.js";
import type { AgentSessionJournalPage, OwnerChat } from "./owner-chat.js";
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
  delivery_id: string;
}

/** Durable owner-DM run admission and the single run path introduced for the first reply. */
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
      context: (runId, agentId, after, limit) =>
        this.isRunning(runId, agentId)
          ? chat.listAgentSessionJournal(agentId, after, limit)
          : undefined,
      journal: (runId, nodeId, agentId, requestId, text, replayOnly) =>
        chat.commitAgentReply(runId, nodeId, agentId, requestId, text, replayOnly),
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
      for (const candidate of this.pendingCandidates()) {
        if (this.closed) return;
        if (this.activeAgents.has(candidate.agent_id)) continue;
        if (!this.nodes.list().some((node) => node.id === candidate.node_id && node.online))
          continue;
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

  private pendingCandidates(): RunCandidate[] {
    return this.db
      .prepare(
        `SELECT a.id AS agent_id,a.node_id,s.id AS session_id,a.name,a.role,a.description,
                a.provider,a.model_id,direct.channel_id,d.id AS delivery_id
         FROM owner_message_deliveries d
         JOIN owner_agent_direct_channels direct ON direct.channel_id=d.channel_id
         JOIN owner_agents a ON a.id=direct.agent_id AND a.id=d.recipient_id
         JOIN owner_agent_sessions s ON s.agent_id=a.id
         WHERE d.recipient_kind='agent' AND d.state='pending'
           AND a.status='waiting_credentials' AND a.model_ready=1
           AND EXISTS (SELECT 1 FROM model_credentials c WHERE c.provider=a.provider)
           AND NOT EXISTS (SELECT 1 FROM owner_agent_runs r WHERE r.agent_id=a.id AND r.state='running')
           AND NOT EXISTS (
             SELECT 1 FROM owner_message_deliveries earlier
             WHERE earlier.recipient_kind='agent' AND earlier.recipient_id=a.id
               AND earlier.state='pending' AND earlier.seq<d.seq
               AND EXISTS (SELECT 1 FROM owner_agent_direct_channels prior WHERE prior.channel_id=earlier.channel_id AND prior.agent_id=a.id)
           )
           AND NOT EXISTS (
             SELECT 1 FROM owner_agent_runs retry
             WHERE retry.delivery_id=d.id AND retry.state='failed' AND retry.retry_at>?
           )
         ORDER BY d.seq LIMIT 100`,
      )
      .all(this.now()) as RunCandidate[];
  }

  private beginRun(candidate: RunCandidate): string | undefined {
    const id = randomUUID();
    try {
      return this.db
        .transaction(() => {
          const current = this.db
            .prepare(
              `SELECT 1 FROM owner_agents a
               JOIN owner_message_deliveries d ON d.recipient_id=a.id AND d.recipient_kind='agent'
               JOIN owner_agent_direct_channels direct ON direct.agent_id=a.id AND direct.channel_id=d.channel_id
               WHERE a.id=? AND a.status='waiting_credentials' AND a.model_ready=1
                 AND d.id=? AND d.state='pending'`,
            )
            .get(candidate.agent_id, candidate.delivery_id);
          if (!current) return undefined;
          this.db
            .prepare(
              "INSERT INTO owner_agent_runs(id,agent_id,node_id,delivery_id,state,started_at) VALUES(?,?,?,?,'running',?)",
            )
            .run(id, candidate.agent_id, candidate.node_id, candidate.delivery_id, this.now());
          return id;
        })
        .immediate();
    } catch {
      // A competing scheduler or the partial unique index already owns this Agent's run.
      return undefined;
    }
  }

  private isRunning(runId: string, agentId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM owner_agent_runs WHERE id=? AND agent_id=? AND state='running'")
        .get(runId, agentId),
    );
  }

  private finishRun(runId: string, agentId: string, ok: boolean, code?: string): void {
    const existing = this.db
      .prepare("SELECT state FROM owner_agent_runs WHERE id=? AND agent_id=?")
      .get(runId, agentId) as { state: string } | undefined;
    if (!existing || existing.state !== "running") return;
    this.db
      .prepare(
        "UPDATE owner_agent_runs SET state='failed',error_code=?,retry_at=?,completed_at=? WHERE id=? AND agent_id=? AND state='running'",
      )
      .run(
        ok ? "missing_reply" : safeFailureCode(code),
        this.now() + retryDelayMs,
        this.now(),
        runId,
        agentId,
      );
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

export type AgentRunContext = AgentSessionJournalPage;
