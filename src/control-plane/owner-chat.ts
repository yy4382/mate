import { AgentSession } from "./agent-session.js";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  agentMateOperations,
  agentConversationOperations,
  agentProcessToolOperations,
  agentWorkspaceOperations,
  agentToolSchemas,
  type AgentConversationOperation,
  toAgentProcessOperation,
  type AgentWorkspaceOperation,
} from "./agent-tools.js";
import type { AgentProcessOperation } from "../nodes/process-operations.js";
import { nodeAccountOf } from "./nodes/directory.js";

export type ChannelVisibility = "public" | "private";
export type OwnerPrincipalKind = "human" | "agent";

/** Readable conversation facts returned to a running Agent. */
interface AgentConversationFacts {
  id: string;
  name: string;
  description: string;
  visibility: ChannelVisibility;
  kind: "channel" | "dm";
}

export interface OwnerChannel {
  id: string;
  name: string;
  description: string;
  visibility: ChannelVisibility;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface OwnerMessage {
  id: string;
  channelId: string;
  rootId: string | null;
  quoteId: string | null;
  replyCount: number;
  recentReplies: OwnerMessage[];
  author: { kind: "human"; id: "owner" } | { kind: "agent"; id: string };
  text: string;
  order: string;
  revision: string;
  createdAt: number;
}

export interface OwnerTask {
  id: string;
  messageId: string;
  channelId: string;
  title: string;
  status: "open" | "in_progress" | "done";
  ownerAgentId: string | null;
  ownerAgentName: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** The outcome of the Agent's one direct claim call for a message. */
export interface OwnerTaskClaim {
  outcome: "claimed" | "conflict";
  created: boolean;
  messageId: string;
  channelId: string;
  task: OwnerTask;
}

export interface OwnerReminder {
  id: string;
  agentId: string;
  channelId: string;
  taskId: string | null;
  text: string;
  dueAt: number;
  state: "active" | "fired" | "cancelled";
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface OwnerMessagePage {
  messages: OwnerMessage[];
  nextBefore: string | null;
}

export interface OwnerMessageDelivery {
  sequence: number;
  id: string;
  messageId: string;
  channelId: string;
  recipient: { kind: OwnerPrincipalKind; id: string };
  state: "pending";
  createdAt: number;
  message: OwnerMessage;
}

export interface OwnerMessageDeliveryPage {
  deliveries: OwnerMessageDelivery[];
  nextAfter: number | null;
}

export interface AgentRunContextPage {
  messages: import("../nodes/session-record.js").ModelContextMessage[];
  /** Next message position in the ordered run context; null marks the final page. */
  nextCursor: number | null;
}

export interface OwnerChatSnapshot {
  channels: OwnerChannel[];
  cursor: number;
}

export interface OwnerChatEvent {
  seq: number;
  kind: string;
  channelId: string;
  payload: unknown;
  createdAt: number;
}

export interface NewOwnerChannel {
  name: string;
  description: string;
  visibility: ChannelVisibility;
}

export interface OwnerChannelUpdate {
  name?: string | undefined;
  description?: string | undefined;
  visibility?: ChannelVisibility | undefined;
  archived?: boolean | undefined;
}

export type AgentToolCallResult = { ok: true; result: unknown } | { ok: false; error: string };

export interface ExternalAgentToolRequest {
  runId: string;
  nodeId: string;
  agentId: string;
  actionId: string;
  name: AgentWorkspaceOperation;
  input: Record<string, unknown>;
}

export type ExternalAgentToolHandler = (
  request: ExternalAgentToolRequest,
) => Promise<AgentToolCallResult>;

interface ActiveAgentToolRun {
  run_id: string;
  agent_id: string;
  node_id: string;
  action_scope_id: string;
  session_id: string;
  state: string;
  independent_review: number;
  input_end_seq: number;
}

export interface AuthorizedAgentProcessOperation {
  actionScopeId: string;
  operation: AgentProcessOperation;
}

class AgentToolRefusal extends Error {}

export class ArchivedChannelError extends Error {
  constructor() {
    super("Archived channels are read-only");
    this.name = "ArchivedChannelError";
  }
}

interface ChannelRow {
  id: string;
  name: string;
  description: string;
  visibility: ChannelVisibility;
  archived: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  channel_id: string;
  order_seq: number;
  revision: number;
  text: string;
  root_id?: string | null;
  quote_id?: string | null;
  author_kind: OwnerPrincipalKind;
  author_id: string;
  created_at: number;
}

interface TaskRow {
  id: string;
  message_id: string;
  channel_id: string;
  title: string;
  status: OwnerTask["status"];
  owner_agent_id: string | null;
  owner_agent_name: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

interface ReminderRow {
  id: string;
  agent_id: string;
  channel_id: string;
  task_id: string | null;
  text: string;
  due_at: number;
  state: OwnerReminder["state"];
  version: number;
  created_at: number;
  updated_at: number;
}

interface TaskDraftRow {
  id: string;
  agent_id: string;
  task_id: string | null;
  action: string;
  input_json: string;
  input_end_seq: number;
  state: string;
}

interface EventRow {
  seq: number;
  kind: string;
  channel_id: string;
  payload: string;
  created_at: number;
}

interface PendingDeliveryRow {
  delivery_sequence: number;
  delivery_id: string;
  message_id: string;
  channel_id: string;
  recipient_kind: OwnerPrincipalKind;
  recipient_id: string;
  state: "pending";
  delivery_created_at: number;
  order_seq: number;
  revision: number;
  text: string;
  root_id: string | null;
  quote_id: string | null;
  author_kind: OwnerPrincipalKind;
  author_id: string;
  created_at: number;
}

const eventRetention = 1000;

/** Owner-facing channel facts committed in the control-plane database. */
export class OwnerChat {
  private externalAgentToolHandler?: ExternalAgentToolHandler;
  private pushMessage?: (message: OwnerMessage, directToOwner: boolean) => void;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  setPushHandler(handler: (message: OwnerMessage, directToOwner: boolean) => void): void {
    this.pushMessage = handler;
  }

  createChannel(input: NewOwnerChannel): OwnerChannel {
    const id = randomUUID(),
      at = this.now();
    return this.db
      .transaction(() => {
        this.db
          .prepare(
            "INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .run(id, input.name, input.description, input.visibility, at, at);
        this.db
          .prepare(
            "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'human','owner',1,?)",
          )
          .run(id, at);
        const channel = this.readChannel(id);
        this.record("channel.created", channel.id, channel);
        return channel;
      })
      .immediate();
  }

  listChannels(): OwnerChannel[] {
    const rows = this.db
      .prepare(
        "SELECT id,name,description,visibility,archived,created_at,updated_at FROM owner_channels ORDER BY created_at,id",
      )
      .all() as ChannelRow[];
    return rows.map(toChannel);
  }

  listInvitableChannels(): OwnerChannel[] {
    const rows = this.db
      .prepare(
        `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at,c.updated_at
         FROM owner_channels c
         WHERE c.archived=0
           AND NOT EXISTS (SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=c.id)
           AND NOT EXISTS (SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=c.id)
         ORDER BY c.created_at,c.id`,
      )
      .all() as ChannelRow[];
    return rows.map(toChannel);
  }

  /** The only entry point through which a running Agent may call shared conversation tools. */
  setExternalAgentToolHandler(handler: ExternalAgentToolHandler): void {
    this.externalAgentToolHandler = handler;
  }

  executeAgentTool(
    runId: string,
    nodeId: string,
    agentId: string,
    toolCallId: string,
    operation: string,
    input: Record<string, unknown>,
  ): AgentToolCallResult | Promise<AgentToolCallResult> {
    if (operation === "tools.call") {
      const request = agentToolSchemas["tools.call"].safeParse(input);
      if (request.success && Object.hasOwn(agentWorkspaceOperations, request.data.name)) {
        let external: ExternalAgentToolRequest;
        try {
          external = this.db
            .transaction(() => {
              const run = this.activeAgentToolRun(runId, nodeId, agentId),
                entry = agentWorkspaceOperations[request.data.name as AgentWorkspaceOperation];
              if (run.independent_review === 1 && entry.seatPolicy === "deny")
                throw new AgentToolRefusal("Independent review seat isolates this input path");
              const parsedInput = entry.schema.parse(request.data.input);
              if (
                typeof parsedInput !== "object" ||
                parsedInput === null ||
                Array.isArray(parsedInput)
              )
                throw new AgentToolRefusal("Invalid tool input");
              return {
                runId,
                nodeId,
                agentId,
                actionId: toolCallId,
                name: request.data.name as AgentWorkspaceOperation,
                input: parsedInput as Record<string, unknown>,
              };
            })
            .immediate();
        } catch (error) {
          if (error instanceof AgentToolRefusal) return { ok: false, error: error.message };
          if (error instanceof z.ZodError) return { ok: false, error: "Invalid tool input" };
          return { ok: false, error: "Agent tool request was refused" };
        }
        if (!this.externalAgentToolHandler)
          return Promise.resolve({ ok: false, error: "File services are unavailable" });
        return this.externalAgentToolHandler(external).catch(() => ({
          ok: false as const,
          error: "Agent 文件请求被拒绝。",
        }));
      }
    }
    try {
      const result = this.db
        .transaction(() => {
          const run = this.activeAgentToolRun(runId, nodeId, agentId),
            reviewSeat = run.independent_review === 1;
          if (operation === "tools.list") {
            agentToolSchemas["tools.list"].parse(input);
            return {
              tools: [
                ...Object.entries(agentMateOperations),
                ...Object.entries(agentProcessToolOperations),
              ]
                .filter(([, entry]) => !reviewSeat || entry.seatPolicy !== "deny")
                .map(([name, entry]) => ({ name, description: entry.description })),
            };
          }
          if (operation === "tools.describe") {
            const request = agentToolSchemas["tools.describe"].parse(input),
              entry =
                agentConversationOperations[request.name as AgentConversationOperation] ??
                agentWorkspaceOperations[request.name as AgentWorkspaceOperation] ??
                agentProcessToolOperations[request.name as keyof typeof agentProcessToolOperations];
            if (!entry || (reviewSeat && entry.seatPolicy === "deny"))
              throw new AgentToolRefusal("Unknown operation");
            return {
              name: request.name,
              description: entry.description,
              inputSchema: z.toJSONSchema(entry.schema),
            };
          }
          if (operation !== "tools.call") throw new AgentToolRefusal("Unknown operation");
          const request = agentToolSchemas["tools.call"].parse(input);
          return this.executeConversationOperation(
            run,
            reviewSeat,
            toolCallId,
            request.name,
            request.input,
          );
        })
        .immediate();
      return { ok: true, result };
    } catch (error) {
      if (error instanceof AgentToolRefusal) return { ok: false, error: error.message };
      if (error instanceof z.ZodError) return { ok: false, error: "Invalid tool input" };
      return { ok: false, error: "Agent tool request was refused" };
    }
  }

  /** Verify the active delivery, node and process tool input before the process broker records it. */
  authorizeAgentProcessOperation(
    runId: string,
    nodeId: string,
    agentId: string,
    name: string,
    input: unknown,
  ): AuthorizedAgentProcessOperation {
    const operation = toAgentProcessOperation(name, input);
    if (!operation) throw new Error("Unknown process operation");
    return this.db
      .transaction(() => {
        const run = this.activeAgentToolRun(runId, nodeId, agentId),
          entry = agentProcessToolOperations[name as keyof typeof agentProcessToolOperations];
        if (!entry) throw new Error("Agent process operation was refused");
        return { actionScopeId: run.action_scope_id, operation };
      })
      .immediate();
  }

  /** Create or return the one private owner conversation bound to this verified Agent. */
  getOrCreateAgentDirectChannel(agentId: string): OwnerChannel | undefined {
    return this.db
      .transaction(() => {
        const agent = this.db
          .prepare("SELECT a.id,a.name,a.stage FROM owner_agents a WHERE a.id=?")
          .get(agentId) as { id: string; name: string; stage: string } | undefined;
        if (!agent || agent.stage !== "complete") return undefined;
        const existing = this.db
          .prepare(
            `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at,c.updated_at
             FROM owner_agent_direct_channels d JOIN owner_channels c ON c.id=d.channel_id
             WHERE d.agent_id=?`,
          )
          .get(agentId) as ChannelRow | undefined;
        if (existing) return toChannel(existing);

        const id = randomUUID(),
          at = this.now(),
          channel: OwnerChannel = {
            id,
            name: `${agent.name} 私信`,
            description: `与 ${agent.name} 的所有者私信。`,
            visibility: "private",
            archived: false,
            createdAt: at,
            updatedAt: at,
          };
        this.db
          .prepare(
            "INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at) VALUES(?,?,?,'private',?,?)",
          )
          .run(id, channel.name, channel.description, at, at);
        this.db
          .prepare(
            "INSERT INTO owner_agent_direct_channels(agent_id,channel_id,created_at) VALUES(?,?,?)",
          )
          .run(agentId, id, at);
        this.db
          .prepare(
            "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'human','owner',1,?),(?, 'agent', ?,1,?)",
          )
          .run(id, at, id, agentId, at);
        this.record("channel.created", id, channel);
        return channel;
      })
      .immediate();
  }

  /** Add a provisioned Agent to an active channel before its messages can be delivered. */
  inviteAgentToChannel(channelId: string, agentId: string): boolean {
    return this.db
      .transaction(() => {
        const session = this.db
          .prepare(
            `SELECT a.stage,a.home,n.linux_username,n.uid,n.gid
             FROM owner_agent_sessions s JOIN owner_agents a ON a.id=s.agent_id
             JOIN nodes n ON n.id=a.node_id
             WHERE s.agent_id=?`,
          )
          .get(agentId) as
          | {
              stage: string;
              linux_username: string | null;
              uid: number | null;
              gid: number | null;
              home: string | null;
            }
          | undefined;
        if (!session || session.stage !== "complete" || !nodeAccountOf(session) || !session.home)
          return false;
        const channel = this.db
          .prepare(
            `SELECT c.archived FROM owner_channels c
             WHERE c.id=?
               AND NOT EXISTS (
                 SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=c.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=c.id
               )`,
          )
          .get(channelId) as { archived: number } | undefined;
        if (!channel || channel.archived) return false;
        this.db
          .prepare(
            "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'agent',?,1,?) ON CONFLICT(channel_id,principal_kind,principal_id) DO UPDATE SET active=1",
          )
          .run(channelId, agentId, this.now());
        return true;
      })
      .immediate();
  }

  /**
   * Let an Agent join a public channel it chose to take part in, under the same commit
   * that records the decision. Joining grants no read of the past: unread state is still
   * created only by the delivery snapshot of a later message, so old history is never
   * backfilled as unread, and an earlier re-join keeps the original joined_at.
   */
  joinAgentToPublicChannel(agentId: string, channelId: string): OwnerChannel | undefined {
    return this.db
      .transaction(() => {
        const channel = this.db
          .prepare(
            `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at,c.updated_at
             FROM owner_channels c
             WHERE c.id=? AND c.archived=0 AND c.visibility='public'
               AND NOT EXISTS (SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=c.id)
               AND NOT EXISTS (
                 SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=c.id
               )`,
          )
          .get(channelId) as ChannelRow | undefined;
        if (!channel) return undefined;
        this.db
          .prepare(
            "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'agent',?,1,?) ON CONFLICT(channel_id,principal_kind,principal_id) DO UPDATE SET active=1",
          )
          .run(channelId, agentId, this.now());
        return toChannel(channel);
      })
      .immediate();
  }

  snapshot(): OwnerChatSnapshot {
    return this.db
      .transaction(() => ({
        channels: this.listChannels(),
        cursor: this.eventCursor(),
      }))
      .deferred();
  }

  eventsAfter(cursor: number, limit = 100): { stale: boolean; events: OwnerChatEvent[] } {
    const first = this.db.prepare("SELECT MIN(seq) AS first FROM owner_chat_events").get() as {
      first: number | null;
    };
    if (first.first !== null && cursor < first.first - 1) return { stale: true, events: [] };
    const rows = this.db
      .prepare(
        "SELECT seq,kind,channel_id,payload,created_at FROM owner_chat_events WHERE seq>? ORDER BY seq LIMIT ?",
      )
      .all(cursor, limit) as EventRow[];
    return {
      stale: false,
      events: rows.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        channelId: row.channel_id,
        payload: JSON.parse(row.payload) as unknown,
        createdAt: row.created_at,
      })),
    };
  }

  private eventCursor(): number {
    const result = this.db
      .prepare("SELECT COALESCE(MAX(seq),0) AS cursor FROM owner_chat_events")
      .get() as { cursor: number };
    return result.cursor;
  }

  updateChannel(id: string, input: OwnerChannelUpdate): OwnerChannel | undefined {
    return this.db
      .transaction(() => {
        const current = this.db.prepare("SELECT id FROM owner_channels WHERE id=?").get(id);
        if (!current) return undefined;
        // A direct message is a private conversation between fixed participants, so it can
        // never be published: otherwise every Agent could read it through the public path.
        if (input.visibility === "public" && this.isDirectChannel(id))
          throw new Error("A direct message cannot be made public");

        this.db
          .prepare(
            "UPDATE owner_channels SET name=COALESCE(?,name),description=COALESCE(?,description),visibility=COALESCE(?,visibility),archived=COALESCE(?,archived),updated_at=? WHERE id=?",
          )
          .run(
            input.name ?? null,
            input.description ?? null,
            input.visibility ?? null,
            input.archived === undefined ? null : input.archived ? 1 : 0,
            this.now(),
            id,
          );
        const channel = this.readChannel(id);
        this.record("channel.updated", channel.id, channel);
        return channel;
      })
      .immediate();
  }

  createMessage(
    channelId: string,
    text: string,
    position: {
      rootId?: string | undefined;
      quoteId?: string | undefined;
      asTask?: boolean | undefined;
    } = {},
  ): OwnerMessage | undefined {
    const id = randomUUID(),
      at = this.now();
    return this.db
      .transaction(() => {
        const channel = this.db
          .prepare("SELECT archived FROM owner_channels WHERE id=?")
          .get(channelId) as { archived: number } | undefined;
        if (!channel) return undefined;
        if (channel.archived) throw new ArchivedChannelError();

        if (position.rootId && position.quoteId)
          throw new Error("A message cannot be both a thread and quote reply");
        const targetId = position.rootId ?? position.quoteId;
        if (targetId) {
          const target = this.db
            .prepare("SELECT channel_id,root_id FROM owner_messages WHERE id=?")
            .get(targetId) as { channel_id: string; root_id: string | null } | undefined;
          if (!target || target.channel_id !== channelId || (position.rootId && target.root_id))
            throw new Error("Reply target is not a root message in this conversation");
        }
        const sequence = this.db
          .prepare(
            "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
          )
          .get(channelId) as { next: number };
        this.db
          .prepare(
            "INSERT INTO owner_messages(id,channel_id,order_seq,text,root_id,quote_id,created_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            id,
            channelId,
            sequence.next,
            text,
            position.rootId ?? null,
            position.quoteId ?? null,
            at,
          );
        const message = toMessage({
          id,
          channel_id: channelId,
          order_seq: sequence.next,
          revision: 1,
          text,
          root_id: position.rootId ?? null,
          quote_id: position.quoteId ?? null,
          author_kind: "human",
          author_id: "owner",
          created_at: at,
        });
        this.queueDeliveries(message, at);
        this.record("message.created", channelId, message);
        if (position.asTask) this.createTaskForMessage(id, "human", "owner");
        return message;
      })
      .immediate();
  }

  /** Queue a private Mate fact so a corrected operation wakes its Agent once. */
  notifyAgentReceiptCorrection(
    agentId: string,
    operationId: string,
    state: "succeeded" | "failed",
  ): void {
    const channel = this.getOrCreateAgentDirectChannel(agentId);
    const at = this.now(),
      id = randomUUID();
    const processReceipt = this.db
      .prepare(
        "SELECT receipt_json FROM owner_agent_process_operations WHERE operation_id=? AND agent_id=?",
      )
      .get(operationId, agentId) as { receipt_json: string | null } | undefined;
    const workspaceReceipt = this.db
      .prepare(
        "SELECT result_json FROM owner_agent_tool_actions WHERE agent_id=? AND json_extract(result_json,'$.operationId')=?",
      )
      .get(agentId, operationId) as { result_json: string } | undefined;
    new AgentSession(this.db).queueCorrection(
      agentId,
      {
        operationId,
        state,
        receipt: processReceipt?.receipt_json
          ? JSON.parse(processReceipt.receipt_json)
          : workspaceReceipt?.result_json
            ? JSON.parse(workspaceReceipt.result_json)
            : null,
      },
      at,
    );
    if (!channel || channel.archived) return;
    const text = `Mate 已核对操作 ${operationId} 的收据：${state === "succeeded" ? "成功" : "失败"}。完整更正将在后续模型上下文中呈现。`;
    this.db
      .transaction(() => {
        const sequence = this.db
          .prepare(
            "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
          )
          .get(channel.id) as { next: number };
        this.db
          .prepare(
            `INSERT INTO owner_messages(id,channel_id,order_seq,text,author_kind,author_id,created_at)
         VALUES(?,?,?,?,'agent','mate-system',?)`,
          )
          .run(id, channel.id, sequence.next, text, at);
        const message = toMessage({
          id,
          channel_id: channel.id,
          order_seq: sequence.next,
          revision: 1,
          text,
          author_kind: "agent",
          author_id: "mate-system",
          created_at: at,
        });
        this.queueDeliveries(message, at);
        this.record("message.created", channel.id, message);
      })
      .immediate();
  }

  createTaskForMessage(
    messageId: string,
    actorKind: OwnerPrincipalKind,
    actorId: string,
  ): OwnerTask {
    return this.db
      .transaction(() => {
        const message = this.db
          .prepare(
            "SELECT id,channel_id,text FROM owner_messages WHERE id=? AND internal_kind IS NULL",
          )
          .get(messageId) as { id: string; channel_id: string; text: string } | undefined;
        if (!message) throw new Error("Message is not available");
        if (actorKind === "agent") this.requireAgentConversation(actorId, message.channel_id);
        const id = this.insertTask(message, "open", null, this.now());
        this.taskEvent(id, actorKind, actorId, "created", "");
        const task = this.readTask(id)!;
        this.record("task.created", message.channel_id, task);
        return task;
      })
      .immediate();
  }

  /** Insert the one task row for a message; callers own its status, owner and recorded events. */
  private insertTask(
    message: { id: string; channel_id: string; text: string },
    status: OwnerTask["status"],
    ownerAgentId: string | null,
    at: number,
  ): string {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO owner_tasks(id,message_id,channel_id,title,status,owner_agent_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        message.id,
        message.channel_id,
        message.text.slice(0, 200),
        status,
        ownerAgentId,
        at,
        at,
      );
    return id;
  }

  /**
   * The task a direct claim acts on. A task already anchored on the named message wins, because an
   * Agent may name a reply that carries its own task; otherwise the discussion's original top-level
   * message is the anchor. Returns nothing when the named message is not available.
   */
  private directClaimTarget(
    messageId: string,
  ): { channelId: string; anchorMessageId: string; task: OwnerTask | undefined } | undefined {
    const message = this.db
      .prepare(
        "SELECT id,channel_id,root_id FROM owner_messages WHERE id=? AND internal_kind IS NULL",
      )
      .get(messageId) as { id: string; channel_id: string; root_id: string | null } | undefined;
    if (!message) return undefined;
    const named = this.taskForMessage(message.id);
    if (named)
      return { channelId: message.channel_id, anchorMessageId: named.messageId, task: named };
    const anchorMessageId = message.root_id ?? message.id;
    return {
      channelId: message.channel_id,
      anchorMessageId,
      task: anchorMessageId === message.id ? undefined : this.taskForMessage(anchorMessageId),
    };
  }

  /**
   * The Agent's one call for a readable message: create the task anchored on that conversation's
   * original top-level message and claim it, or claim the task already anchored on the named
   * message. A peer's claim is reported as a conflict instead of being taken over. The caller must
   * already be able to read the conversation, and owning the task never grants that access.
   */
  private claimTaskForMessage(agentId: string, messageId: string): OwnerTaskClaim {
    return this.db
      .transaction((): OwnerTaskClaim => {
        const target = this.directClaimTarget(messageId);
        if (!target) throw new AgentToolRefusal("Message is not available");
        const anchor = this.db
          .prepare(
            "SELECT id,channel_id,root_id,text FROM owner_messages WHERE id=? AND internal_kind IS NULL",
          )
          .get(target.anchorMessageId) as
          { id: string; channel_id: string; root_id: string | null; text: string } | undefined;
        // A task already anchored on the named message is claimed as it stands; otherwise the
        // anchor must be the discussion's original top-level message.
        if (!anchor || anchor.channel_id !== target.channelId || (!target.task && anchor.root_id))
          throw new AgentToolRefusal("Task anchor is not available");
        this.requireAgentConversation(agentId, anchor.channel_id);
        const existing = target.task;
        if (existing) {
          if (existing.ownerAgentId === agentId)
            // Already this Agent's task: a repeated call changes nothing.
            return {
              outcome: "claimed",
              created: false,
              messageId: anchor.id,
              channelId: anchor.channel_id,
              task: existing,
            };
          if (existing.ownerAgentId)
            return {
              outcome: "conflict",
              created: false,
              messageId: anchor.id,
              channelId: anchor.channel_id,
              task: existing,
            };
          this.db
            .prepare(
              "UPDATE owner_tasks SET status='in_progress',owner_agent_id=?,version=version+1,updated_at=? WHERE id=?",
            )
            .run(agentId, this.now(), existing.id);
          this.taskEvent(existing.id, "agent", agentId, "claim", "");
          const claimed = this.readTask(existing.id)!;
          this.record("task.updated", anchor.channel_id, claimed);
          return {
            outcome: "claimed",
            created: false,
            messageId: anchor.id,
            channelId: anchor.channel_id,
            task: claimed,
          };
        }
        const id = this.insertTask(anchor, "in_progress", agentId, this.now());
        this.taskEvent(id, "agent", agentId, "created", "");
        this.taskEvent(id, "agent", agentId, "claim", "");
        const task = this.readTask(id)!;
        this.record("task.created", anchor.channel_id, task);
        return {
          outcome: "claimed",
          created: true,
          messageId: anchor.id,
          channelId: anchor.channel_id,
          task,
        };
      })
      .immediate();
  }

  readTask(id: string): OwnerTask | undefined {
    const row = this.db
      .prepare(
        "SELECT t.*,a.name AS owner_agent_name FROM owner_tasks t LEFT JOIN owner_agents a ON a.id=t.owner_agent_id WHERE t.id=?",
      )
      .get(id) as TaskRow | undefined;
    return row && toTask(row);
  }

  taskForMessage(messageId: string): OwnerTask | undefined {
    const row = this.db
      .prepare(
        "SELECT t.*,a.name AS owner_agent_name FROM owner_tasks t LEFT JOIN owner_agents a ON a.id=t.owner_agent_id WHERE t.message_id=?",
      )
      .get(messageId) as TaskRow | undefined;
    return row && toTask(row);
  }

  listTasks(): OwnerTask[] {
    return (
      this.db
        .prepare(
          "SELECT t.*,a.name AS owner_agent_name FROM owner_tasks t LEFT JOIN owner_agents a ON a.id=t.owner_agent_id ORDER BY t.updated_at DESC,t.id DESC",
        )
        .all() as TaskRow[]
    ).map(toTask);
  }

  taskActivity(taskId: string): unknown[] {
    return this.db
      .prepare(
        "SELECT seq,task_id AS taskId,actor_kind AS actorKind,actor_id AS actorId,kind,note,created_at AS createdAt FROM owner_task_events WHERE task_id=? ORDER BY seq",
      )
      .all(taskId);
  }

  /** True for the one-to-one conversations that must never follow channel visibility. */
  private isDirectChannel(channelId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 WHERE EXISTS (
           SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=?
         ) OR EXISTS (
           SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=?
         )`,
      )
      .get(channelId, channelId);
    return row !== undefined;
  }

  /** True only while this Agent holds an active membership in a live channel. */
  private isAgentChannelMember(agentId: string, channelId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM owner_channels c
         JOIN owner_channel_memberships m
           ON m.channel_id=c.id AND m.principal_kind='agent' AND m.principal_id=? AND m.active=1
         WHERE c.id=? AND c.archived=0`,
      )
      .get(agentId, channelId);
    return row !== undefined;
  }

  private taskDraftPosition(draft: TaskDraftRow): {
    channelId: string;
    rootId: string | undefined;
  } {
    const input = JSON.parse(draft.input_json) as { messageId?: string };
    const task = draft.task_id ? this.readTask(draft.task_id) : undefined;
    // A direct claim is reviewed at its target's anchor, the same position the claim itself is
    // gated on, so a later apply cannot quietly pass a change its own review would have shown.
    const claimAnchorId =
      draft.action === "tasks.claim_message" && input.messageId
        ? (this.directClaimTarget(input.messageId)?.anchorMessageId ?? input.messageId)
        : input.messageId;
    const messageId = task?.messageId ?? claimAnchorId;
    const message = this.db
      .prepare("SELECT channel_id,root_id FROM owner_messages WHERE id=?")
      .get(messageId) as { channel_id: string; root_id: string | null } | undefined;
    if (!message) throw new AgentToolRefusal("Task anchor is not available");
    return { channelId: message.channel_id, rootId: message.root_id ?? undefined };
  }

  private unreviewedTaskChanges(draft: TaskDraftRow): OwnerMessage[] {
    const position = this.taskDraftPosition(draft);
    return this.inspectAgentPositionChanges(
      draft.agent_id,
      draft.input_end_seq,
      position.channelId,
      position.rootId,
    ).changes.filter(
      (message) =>
        !this.db
          .prepare("SELECT 1 FROM owner_task_draft_reviews WHERE draft_id=? AND message_id=?")
          .get(draft.id, message.id),
    );
  }

  private recordTaskDraftReviews(draftId: string, changes: OwnerMessage[]): void {
    for (const message of changes) {
      this.db
        .prepare("INSERT OR IGNORE INTO owner_task_draft_reviews(draft_id,message_id) VALUES(?,?)")
        .run(draftId, message.id);
      const draft = this.db
        .prepare("SELECT agent_id FROM owner_task_drafts WHERE id=?")
        .get(draftId) as { agent_id: string };
      this.db
        .prepare(
          "INSERT OR IGNORE INTO owner_agent_message_attention(agent_id,message_id,updated_at) VALUES(?,?,?)",
        )
        .run(draft.agent_id, message.id, this.now());
      this.db
        .prepare(
          "UPDATE owner_agent_message_attention SET presented=1,updated_at=? WHERE agent_id=? AND message_id=?",
        )
        .run(this.now(), draft.agent_id, message.id);
    }
  }

  private mutateTask(
    agentId: string,
    task: OwnerTask,
    action: string,
    input: Record<string, unknown>,
  ): OwnerTask {
    const current = this.readTask(task.id);
    if (
      !current ||
      (current.version !== input.expectedVersion &&
        !(action === "tasks.yield" && current.ownerAgentId !== agentId))
    )
      throw new AgentToolRefusal("Task version changed; read the task again");
    this.requireAgentConversation(agentId, current.channelId);
    let owner = current.ownerAgentId,
      status = current.status,
      title = current.title;
    if (action === "tasks.claim") {
      if (owner && owner !== agentId) throw new AgentToolRefusal("Task is already claimed");
      owner = agentId;
      status = "in_progress";
    } else if (action === "tasks.yield") {
      if (owner === agentId) {
        owner = null;
        status = "open";
      }
      // A peer's newer claim remains authoritative; this Agent may still yield socially.
    } else if (action === "tasks.transfer") {
      const targetId = input.agentId as string;
      // Only the current owner hands the task on: a peer cannot take over by transferring it.
      if (owner !== agentId)
        throw new AgentToolRefusal("Only the current owner can transfer this task");
      if (targetId === agentId) throw new AgentToolRefusal("Task is already yours");
      if (!this.isAgentChannelMember(targetId, current.channelId))
        throw new AgentToolRefusal("Transfer target is not a conversation member");
      owner = targetId;
      status = "in_progress";
    } else if (action === "tasks.update") {
      if (typeof input.title === "string") title = input.title;
      if (typeof input.status === "string") status = input.status as OwnerTask["status"];
    }
    this.db
      .prepare(
        "UPDATE owner_tasks SET title=?,status=?,owner_agent_id=?,version=version+1,updated_at=? WHERE id=?",
      )
      .run(title, status, owner, this.now(), task.id);
    this.taskEvent(
      task.id,
      "agent",
      agentId,
      action.slice(6),
      typeof input.note === "string" ? input.note : "",
    );
    const updated = this.readTask(task.id)!;
    this.record("task.updated", task.channelId, updated);
    return updated;
  }

  private taskEvent(
    taskId: string,
    actorKind: OwnerPrincipalKind,
    actorId: string,
    kind: string,
    note: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO owner_task_events(task_id,actor_kind,actor_id,kind,note,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(taskId, actorKind, actorId, kind, note, this.now());
  }

  listAgentReminders(
    agentId: string,
  ): Array<OwnerReminder & { firing: { firedAt: number; handledAt: number | null } | null }> {
    const rows = this.db
      .prepare(
        "SELECT id,agent_id,channel_id,task_id,text,due_at,state,version,created_at,updated_at FROM owner_reminders WHERE agent_id=? ORDER BY due_at DESC,id",
      )
      .all(agentId) as ReminderRow[];
    return rows.map((row) => {
      const firing = this.db
        .prepare(
          "SELECT fired_at AS firedAt,handled_at AS handledAt FROM owner_reminder_firings WHERE reminder_id=?",
        )
        .get(row.id) as { firedAt: number; handledAt: number | null } | undefined;
      return { ...toReminder(row), firing: firing ?? null };
    });
  }

  private readReminder(id: string): OwnerReminder | undefined {
    const row = this.db
      .prepare(
        "SELECT id,agent_id,channel_id,task_id,text,due_at,state,version,created_at,updated_at FROM owner_reminders WHERE id=?",
      )
      .get(id) as ReminderRow | undefined;
    return row && toReminder(row);
  }

  /** Due time and delivery are committed together, independent of node connectivity. */
  fireDueReminders(): number {
    return this.db
      .transaction(() => {
        const due = this.db
          .prepare(
            "SELECT id,agent_id FROM owner_reminders WHERE state='active' AND due_at<=? ORDER BY due_at,id LIMIT 100",
          )
          .all(this.now()) as Array<{ id: string; agent_id: string }>;
        for (const candidate of due) {
          const reminder = this.readReminder(candidate.id)!;
          const channel = this.getOrCreateAgentDirectChannel(reminder.agentId);
          if (!channel) continue;
          const order = this.db
            .prepare(
              "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
            )
            .get(channel.id) as { next: number };
          const messageId = randomUUID(),
            deliveryId = randomUUID(),
            at = this.now();
          this.db
            .prepare(
              "INSERT INTO owner_messages(id,channel_id,order_seq,text,author_kind,author_id,internal_kind,created_at) VALUES(?,?,?,?,'agent',?,'reminder',?)",
            )
            .run(messageId, channel.id, order.next, `提醒：${reminder.text}`, reminder.agentId, at);
          this.db
            .prepare(
              "INSERT INTO owner_message_deliveries(id,message_id,channel_id,recipient_kind,recipient_id,state,created_at) VALUES(?,?,?,'agent',?,'pending',?)",
            )
            .run(deliveryId, messageId, channel.id, reminder.agentId, at);
          this.db
            .prepare(
              "INSERT INTO owner_reminder_firings(id,reminder_id,agent_id,fired_at,delivery_id) VALUES(?,?,?,?,?)",
            )
            .run(randomUUID(), reminder.id, reminder.agentId, at, deliveryId);
          this.db
            .prepare(
              "UPDATE owner_reminders SET state='fired',version=version+1,updated_at=? WHERE id=?",
            )
            .run(at, reminder.id);
        }
        this.syncHandledReminders();
        return due.length;
      })
      .immediate();
  }

  syncHandledReminders(): void {
    this.db
      .prepare(
        `UPDATE owner_reminder_firings SET handled_at=(
      SELECT d.handled_at FROM owner_message_deliveries d
      WHERE d.id=owner_reminder_firings.delivery_id
    ) WHERE handled_at IS NULL AND EXISTS (
      SELECT 1 FROM owner_message_deliveries d
      JOIN owner_agent_runs r
        ON r.agent_id=owner_reminder_firings.agent_id AND r.state='completed'
           AND r.input_end_seq>=d.seq AND r.completed_at=d.handled_at
      JOIN owner_message_deliveries seed ON seed.id=r.delivery_id AND seed.channel_id=d.channel_id
      WHERE d.id=owner_reminder_firings.delivery_id AND d.state='handled' AND seed.seq<=d.seq
    )`,
      )
      .run();
  }

  listPendingDeliveries(
    recipientKind: OwnerPrincipalKind,
    recipientId: string,
    after = 0,
    limit = 100,
  ): OwnerMessageDeliveryPage {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new Error("Delivery cursor must be a non-negative safe integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error("Delivery page size must be between 1 and 500");
    const rows = this.db
      .prepare(
        `SELECT d.seq AS delivery_sequence,d.id AS delivery_id,d.message_id,d.channel_id,
                d.recipient_kind,d.recipient_id,d.state,d.created_at AS delivery_created_at,
                m.order_seq,m.revision,m.text,m.root_id,m.quote_id,m.author_kind,m.author_id,m.created_at
         FROM owner_message_deliveries d JOIN owner_messages m ON m.id=d.message_id
         WHERE d.recipient_kind=? AND d.recipient_id=? AND d.state='pending' AND d.seq>?
         ORDER BY d.seq LIMIT ?`,
      )
      .all(recipientKind, recipientId, after, limit + 1) as PendingDeliveryRow[];
    const hasMore = rows.length > limit,
      deliveries = rows.slice(0, limit).map((row) => ({
        sequence: row.delivery_sequence,
        id: row.delivery_id,
        messageId: row.message_id,
        channelId: row.channel_id,
        recipient: { kind: row.recipient_kind, id: row.recipient_id },
        state: row.state,
        createdAt: row.delivery_created_at,
        message: toMessage({
          id: row.message_id,
          channel_id: row.channel_id,
          order_seq: row.order_seq,
          revision: row.revision,
          text: row.text,
          root_id: row.root_id,
          quote_id: row.quote_id,
          author_kind: row.author_kind,
          author_id: row.author_id,
          created_at: row.created_at,
        }),
      }));
    return {
      deliveries,
      nextAfter: hasMore ? (deliveries.at(-1)?.sequence ?? after) : null,
    };
  }

  acknowledgeDelivery(
    deliveryId: string,
    recipientKind: OwnerPrincipalKind,
    recipientId: string,
  ): boolean {
    const reminder = this.db
      .prepare("SELECT 1 FROM owner_reminder_firings WHERE delivery_id=?")
      .get(deliveryId);
    if (
      reminder &&
      !this.db
        .prepare(
          "SELECT 1 FROM owner_agent_runs WHERE delivery_id=? AND agent_id=? AND state='completed'",
        )
        .get(deliveryId, recipientId)
    )
      return false;
    return (
      this.db
        .prepare(
          "UPDATE owner_message_deliveries SET state='handled',handled_at=? WHERE id=? AND recipient_kind=? AND recipient_id=? AND state='pending'",
        )
        .run(this.now(), deliveryId, recipientKind, recipientId).changes === 1
    );
  }

  /**
   * Complete a successful run and mark only the deliveries its boundary captured as handled.
   * Speaking, staying silent and completing a run are separate facts: this never changes a task.
   */
  completeAgentRun(runId: string, agentId: string): boolean {
    return this.db
      .transaction(() => {
        const run = this.db
          .prepare(
            `SELECT r.state,r.input_end_seq,s.id AS session_id,d.channel_id,
                    c.archived AS channel_archived,m.internal_kind AS delivery_kind,
                    d.seq AS input_start_seq
             FROM owner_agent_runs r JOIN owner_agent_sessions s ON s.agent_id=r.agent_id
             JOIN owner_message_deliveries d ON d.id=r.delivery_id
             JOIN owner_channels c ON c.id=d.channel_id
             JOIN owner_messages m ON m.id=d.message_id
             WHERE r.id=? AND r.agent_id=?
           AND NOT EXISTS (SELECT 1 FROM owner_agent_recovery_holds hold WHERE hold.agent_id=r.agent_id)`,
          )
          .get(runId, agentId) as
          | {
              state: string;
              input_end_seq: number;
              session_id: string;
              channel_id: string;
              channel_archived: number;
              delivery_kind: string | null;
              input_start_seq: number;
            }
          | undefined;
        if (!run || run.state !== "running") return false;
        const at = this.now();
        if (run.channel_archived === 1 && run.delivery_kind !== "reminder") {
          this.db
            .prepare(
              `UPDATE owner_agent_runs SET state='failed',error_code='channel_archived',
                 retry_at=NULL,completed_at=? WHERE id=? AND agent_id=? AND state='running'`,
            )
            .run(at, runId, agentId);
          return false;
        }
        this.db
          .prepare(
            `UPDATE owner_message_deliveries SET state='handled',handled_at=?
         WHERE recipient_kind='agent' AND recipient_id=? AND channel_id=? AND state='pending'
               AND message_id IN (
                 SELECT d.message_id FROM owner_message_deliveries d
                 JOIN owner_messages m ON m.id=d.message_id
                 WHERE d.recipient_id=? AND d.recipient_kind='agent'
                   AND d.seq>=? AND d.seq<=?
                   AND (?=0 OR m.internal_kind='reminder')
               )`,
          )
          .run(
            at,
            agentId,
            run.channel_id,
            agentId,
            run.input_start_seq,
            run.input_end_seq,
            run.delivery_kind === "reminder" ? 1 : 0,
          );
        this.db
          .prepare(
            `UPDATE owner_agent_runs SET state='completed',completed_at=?,retry_at=NULL,error_code=NULL
             WHERE id=? AND agent_id=? AND state='running'`,
          )
          .run(at, runId, agentId);
        return true;
      })
      .immediate();
  }

  listMessages(
    channelId: string,
    before: number | undefined,
    limit: number,
  ): OwnerMessagePage | undefined {
    if (!this.db.prepare("SELECT 1 FROM owner_channels WHERE id=?").get(channelId))
      return undefined;
    const rows = this.db
      .prepare(
        "SELECT id,channel_id,order_seq,revision,text,root_id,quote_id,author_kind,author_id,created_at FROM owner_messages WHERE channel_id=? AND root_id IS NULL AND internal_kind IS NULL AND (? IS NULL OR order_seq < ?) ORDER BY order_seq DESC LIMIT ?",
      )
      .all(channelId, before ?? null, before ?? null, limit + 1) as MessageRow[];
    const hasMore = rows.length > limit,
      messages = rows
        .slice(0, limit)
        .reverse()
        .map((row) => this.withReplyPreview(toMessage(row)));
    return { messages, nextBefore: hasMore ? (messages[0]?.order ?? null) : null };
  }

  messageContext(channelId: string, messageId: string) {
    const row = this.db
      .prepare(
        "SELECT id,channel_id,order_seq,revision,text,root_id,quote_id,author_kind,author_id,created_at FROM owner_messages WHERE id=? AND channel_id=? AND internal_kind IS NULL",
      )
      .get(messageId, channelId) as MessageRow | undefined;
    if (!row) return undefined;
    if (row.root_id) {
      const thread = this.listThread(channelId, row.root_id);
      return thread ? { kind: "thread" as const, messageId, thread } : undefined;
    }
    const page = this.listMessages(channelId, row.order_seq + 1, 50);
    if (!page) return undefined;
    const latest = this.listMessages(channelId, undefined, 1)?.messages[0];
    return { kind: "timeline" as const, messageId, page, hasNewer: latest?.id !== messageId };
  }

  listThread(
    channelId: string,
    rootId: string,
  ): { root: OwnerMessage; replies: OwnerMessage[] } | undefined {
    const root = this.db
      .prepare(
        "SELECT id,channel_id,order_seq,revision,text,root_id,quote_id,author_kind,author_id,created_at FROM owner_messages WHERE id=? AND channel_id=? AND root_id IS NULL AND internal_kind IS NULL",
      )
      .get(rootId, channelId) as MessageRow | undefined;
    if (!root) return undefined;
    const replies = this.db
      .prepare(
        "SELECT id,channel_id,order_seq,revision,text,root_id,quote_id,author_kind,author_id,created_at FROM owner_messages WHERE channel_id=? AND root_id=? ORDER BY order_seq",
      )
      .all(channelId, rootId) as MessageRow[];
    return { root: this.withReplyPreview(toMessage(root)), replies: replies.map(toMessage) };
  }

  private withReplyPreview(message: OwnerMessage): OwnerMessage {
    const rows = this.db
      .prepare(
        "SELECT id,channel_id,order_seq,revision,text,root_id,quote_id,author_kind,author_id,created_at FROM owner_messages WHERE channel_id=? AND root_id=? ORDER BY order_seq DESC LIMIT 3",
      )
      .all(message.channelId, message.id) as MessageRow[];
    const count = this.db
      .prepare("SELECT COUNT(*) AS count FROM owner_messages WHERE channel_id=? AND root_id=?")
      .get(message.channelId, message.id) as { count: number };
    return { ...message, replyCount: count.count, recentReplies: rows.reverse().map(toMessage) };
  }

  private readChannel(id: string): OwnerChannel {
    const row = this.db
      .prepare(
        "SELECT id,name,description,visibility,archived,created_at,updated_at FROM owner_channels WHERE id=?",
      )
      .get(id) as ChannelRow | undefined;
    if (!row) throw new Error("Created channel was not persisted");
    return toChannel(row);
  }

  private activeAgentToolRun(runId: string, nodeId: string, agentId: string): ActiveAgentToolRun {
    const run = this.db
      .prepare(
        `SELECT r.id AS run_id,r.agent_id,r.node_id,r.delivery_id AS action_scope_id,
                r.state,r.independent_review,r.input_end_seq,s.id AS session_id,
                a.node_id AS current_node_id
         FROM owner_agent_runs r
         JOIN owner_agents a ON a.id=r.agent_id
         JOIN owner_agent_sessions s ON s.agent_id=a.id
         WHERE r.id=? AND r.agent_id=?
           AND NOT EXISTS (SELECT 1 FROM owner_agent_recovery_holds hold WHERE hold.agent_id=a.id)`,
      )
      .get(runId, agentId) as (ActiveAgentToolRun & { current_node_id: string }) | undefined;
    if (!run || run.state !== "running" || run.node_id !== nodeId || run.current_node_id !== nodeId)
      throw new AgentToolRefusal("Agent run is no longer active");
    return run;
  }

  private executeConversationOperation(
    run: ActiveAgentToolRun,
    reviewSeat: boolean,
    toolCallId: string,
    name: string,
    input: Record<string, unknown>,
  ): unknown {
    if (!Object.hasOwn(agentConversationOperations, name))
      throw new AgentToolRefusal("Unknown operation");
    const entry = agentConversationOperations[name as AgentConversationOperation];
    if (reviewSeat && entry.seatPolicy === "deny")
      throw new AgentToolRefusal("Independent review seat isolates this input path");

    switch (name as AgentConversationOperation) {
      case "agents.list":
        agentConversationOperations["agents.list"].schema.parse(input);
        return { agents: this.listContactableAgents(run.agent_id) };
      case "conversations.list":
        agentConversationOperations["conversations.list"].schema.parse(input);
        return { conversations: this.listAgentConversations(run.agent_id) };
      case "conversations.read": {
        const args = agentConversationOperations["conversations.read"].schema.parse(input),
          conversation = this.requireReadableConversation(run.agent_id, args.conversationId),
          before = args.before === undefined ? undefined : Number(args.before);
        if (before !== undefined && !Number.isSafeInteger(before)) throw new z.ZodError([]);
        const page = this.listMessages(args.conversationId, before, args.limit);
        if (!page) throw new AgentToolRefusal("Conversation is not available");
        for (const message of page.messages)
          this.db
            .prepare(
              "UPDATE owner_agent_message_attention SET presented=1,updated_at=? WHERE agent_id=? AND message_id=?",
            )
            .run(this.now(), run.agent_id, message.id);
        return { conversation, ...page };
      }
      case "conversations.read_thread": {
        const args = agentConversationOperations["conversations.read_thread"].schema.parse(input);
        this.requireReadableConversation(run.agent_id, args.conversationId);
        const thread = this.listThread(args.conversationId, args.rootId);
        if (!thread) throw new AgentToolRefusal("Thread is not available");
        for (const message of [thread.root, ...thread.replies])
          this.db
            .prepare(
              "UPDATE owner_agent_message_attention SET presented=1,updated_at=? WHERE agent_id=? AND message_id=?",
            )
            .run(this.now(), run.agent_id, message.id);
        return thread;
      }
      case "conversations.open_dm": {
        const args = agentConversationOperations["conversations.open_dm"].schema.parse(input);
        if (args.targetAgentId === run.agent_id)
          throw new AgentToolRefusal("An Agent cannot open a direct message with itself");
        if (!this.isInviteableAgent(args.targetAgentId))
          throw new AgentToolRefusal("Direct-message target is not available");
        return this.recordAgentToolAction(run, toolCallId, "conversations.open_dm", args, () =>
          this.getOrCreateAgentPeerDirectChannel(run.agent_id, args.targetAgentId),
        );
      }
      case "attention.list": {
        const args = agentConversationOperations["attention.list"].schema.parse(input);
        this.requireAgentConversation(run.agent_id, args.conversationId);
        return {
          items: this.db
            .prepare(
              `SELECT a.message_id AS messageId,a.unread,a.seen,a.deferred,a.muted,a.presented,m.order_seq AS messageOrder,m.root_id AS rootId FROM owner_agent_message_attention a JOIN owner_messages m ON m.id=a.message_id WHERE a.agent_id=? AND m.channel_id=? ORDER BY m.order_seq`,
            )
            .all(run.agent_id, args.conversationId),
        };
      }
      case "attention.update": {
        const args = agentConversationOperations["attention.update"].schema.parse(input);
        this.requireAgentConversation(run.agent_id, args.conversationId);
        const message = this.db
          .prepare("SELECT 1 FROM owner_messages WHERE id=? AND channel_id=?")
          .get(args.messageId, args.conversationId);
        if (!message) throw new AgentToolRefusal("Message is not available");
        return this.recordAgentToolAction(run, toolCallId, "attention.update", args, () => {
          const changes = ["unread", "seen", "deferred", "muted"] as const;
          for (const key of changes)
            if (args[key] !== undefined)
              this.db
                .prepare(
                  `UPDATE owner_agent_message_attention SET ${key}=?,updated_at=? WHERE agent_id=? AND message_id=?`,
                )
                .run(args[key] ? 1 : 0, this.now(), run.agent_id, args.messageId);
          return { conversationId: args.conversationId, messageId: args.messageId, updated: true };
        });
      }
      case "drafts.save": {
        const args = agentConversationOperations["drafts.save"].schema.parse(input);
        this.requireAgentConversation(run.agent_id, args.conversationId);
        this.validateMessagePosition(args.conversationId, args.rootId, args.quoteId);
        return this.recordAgentToolAction(run, toolCallId, "drafts.save", args, () => {
          const id = randomUUID(),
            at = this.now(),
            freshness = this.inspectAgentPositionChanges(
              run.agent_id,
              run.input_end_seq,
              args.conversationId,
              args.rootId,
            );
          this.db
            .prepare(
              "INSERT INTO owner_agent_drafts(id,agent_id,channel_id,root_id,quote_id,text,input_end_seq,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'editing',?,?)",
            )
            .run(
              id,
              run.agent_id,
              args.conversationId,
              args.rootId ?? null,
              args.quoteId ?? null,
              args.text,
              run.input_end_seq,
              at,
              at,
            );
          this.recordDraftReviews(id, freshness.changes);
          return {
            id,
            channelId: args.conversationId,
            state: "editing",
            changes: freshness.changes,
          };
        });
      }
      case "drafts.review": {
        const args = agentConversationOperations["drafts.review"].schema.parse(input);
        const draft = this.readAgentDraft(run.agent_id, args.draftId);
        this.requireAgentConversation(run.agent_id, draft.channel_id);
        return this.recordAgentToolAction(run, toolCallId, "drafts.review", args, () => {
          const changes = this.unreviewedDraftChanges(draft);
          if (args.choice === "inspect") {
            this.recordDraftReviews(draft.id, changes);
            return { channelId: draft.channel_id, draftId: draft.id, state: draft.state, changes };
          }
          if (args.choice === "continue" && changes.length)
            throw new AgentToolRefusal("Conversation changed; inspect the draft before continuing");
          if (draft.state === "sent" || draft.state === "abandoned")
            throw new AgentToolRefusal("Draft is closed");
          const state =
            args.choice === "revise"
              ? "editing"
              : args.choice === "keep"
                ? "kept"
                : args.choice === "defer"
                  ? "deferred"
                  : args.choice === "abandon"
                    ? "abandoned"
                    : "ready";
          if (args.choice === "revise" && !args.text)
            throw new AgentToolRefusal("Revised text is required");
          this.recordDraftReviews(draft.id, changes);
          this.db
            .prepare(
              "UPDATE owner_agent_drafts SET text=COALESCE(?,text),state=?,updated_at=? WHERE id=?",
            )
            .run(args.choice === "revise" ? args.text : null, state, this.now(), draft.id);
          return { channelId: draft.channel_id, draftId: draft.id, state, changes };
        });
      }
      case "messages.send": {
        const args = agentConversationOperations["messages.send"].schema.parse(input);
        this.requireAgentConversation(run.agent_id, args.conversationId);
        this.validateMessagePosition(args.conversationId, args.rootId, args.quoteId);
        return this.recordAgentToolAction(run, toolCallId, "messages.send", args, () => {
          if (!args.draftId) {
            const { changes } = this.inspectAgentPositionChanges(
              run.agent_id,
              run.input_end_seq,
              args.conversationId,
              args.rootId,
            );
            if (changes.length) {
              const id = randomUUID(),
                at = this.now();
              this.db
                .prepare(
                  "INSERT INTO owner_agent_drafts(id,agent_id,channel_id,root_id,quote_id,text,input_end_seq,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'editing',?,?)",
                )
                .run(
                  id,
                  run.agent_id,
                  args.conversationId,
                  args.rootId ?? null,
                  args.quoteId ?? null,
                  args.text,
                  run.input_end_seq,
                  at,
                  at,
                );
              this.recordDraftReviews(id, changes);
              return {
                channelId: args.conversationId,
                status: "needs_review",
                draftId: id,
                changes,
              };
            }
          }
          if (args.draftId) {
            const draft = this.readAgentDraft(run.agent_id, args.draftId);
            if (
              draft.channel_id !== args.conversationId ||
              draft.root_id !== (args.rootId ?? null) ||
              draft.quote_id !== (args.quoteId ?? null) ||
              draft.text !== args.text ||
              draft.state !== "ready"
            )
              throw new AgentToolRefusal("Draft is not ready for this message");
            if (this.unreviewedDraftChanges(draft).length)
              throw new AgentToolRefusal("Conversation changed; review the draft again");
            this.db
              .prepare("UPDATE owner_agent_drafts SET state='sent',updated_at=? WHERE id=?")
              .run(this.now(), draft.id);
          }
          return this.createAgentToolMessage(
            run,
            toolCallId,
            args.conversationId,
            args.text,
            args.rootId,
            args.quoteId,
            args.asTask,
          );
        });
      }
      case "tasks.list": {
        agentConversationOperations["tasks.list"].schema.parse(input);
        // Task visibility stays member-only: this ticket widened conversation READS, and
        // task ownership must not move with them.
        return {
          tasks: this.listTasks().filter((task) =>
            this.isAgentChannelMember(run.agent_id, task.channelId),
          ),
        };
      }
      case "reminders.list": {
        agentConversationOperations["reminders.list"].schema.parse(input);
        this.syncHandledReminders();
        return { reminders: this.listAgentReminders(run.agent_id) };
      }
      case "reminders.create": {
        const args = agentConversationOperations["reminders.create"].schema.parse(input);
        this.requireAgentConversation(run.agent_id, args.conversationId);
        return this.recordAgentToolAction(run, toolCallId, "reminders.create", args, () => {
          if (args.taskId) {
            const task = this.readTask(args.taskId);
            if (!task || task.channelId !== args.conversationId)
              throw new AgentToolRefusal("Task is not in this conversation");
          }
          const id = randomUUID(),
            at = this.now();
          this.db
            .prepare(
              "INSERT INTO owner_reminders(id,agent_id,channel_id,task_id,text,due_at,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',?,?)",
            )
            .run(
              id,
              run.agent_id,
              args.conversationId,
              args.taskId ?? null,
              args.text,
              args.dueAt,
              at,
              at,
            );
          return this.readReminder(id)!;
        });
      }
      case "reminders.reschedule":
      case "reminders.cancel": {
        const operation = name as "reminders.reschedule" | "reminders.cancel";
        const args = agentConversationOperations[operation].schema.parse(input);
        const reminder = this.readReminder(args.reminderId);
        if (!reminder || reminder.agentId !== run.agent_id)
          throw new AgentToolRefusal("Reminder is not available");
        return this.recordAgentToolAction(run, toolCallId, operation, args, () => {
          const current = this.readReminder(args.reminderId)!;
          if (current.version !== args.expectedVersion || current.state !== "active")
            throw new AgentToolRefusal("Reminder version or state changed");
          if (operation === "reminders.reschedule") {
            const dueAt = (args as unknown as { dueAt: number }).dueAt;
            this.db
              .prepare(
                "UPDATE owner_reminders SET due_at=?,version=version+1,updated_at=? WHERE id=?",
              )
              .run(dueAt, this.now(), current.id);
          } else {
            this.db
              .prepare(
                "UPDATE owner_reminders SET state='cancelled',version=version+1,updated_at=? WHERE id=?",
              )
              .run(this.now(), current.id);
          }
          return this.readReminder(current.id)!;
        });
      }
      case "tasks.review": {
        const args = agentConversationOperations["tasks.review"].schema.parse(input);
        return this.recordAgentToolAction(run, toolCallId, "tasks.review", args, () => {
          const draft = this.db
            .prepare("SELECT * FROM owner_task_drafts WHERE id=? AND agent_id=?")
            .get(args.draftId, run.agent_id) as TaskDraftRow | undefined;
          if (!draft) throw new AgentToolRefusal("Task draft is not available");
          const position = this.taskDraftPosition(draft);
          this.requireAgentConversation(run.agent_id, position.channelId);
          const changes = this.unreviewedTaskChanges(draft);
          const result = {
            channelId: position.channelId,
            draftId: draft.id,
            state: draft.state,
            changes,
          };
          if (args.choice === "inspect") {
            this.recordTaskDraftReviews(draft.id, changes);
            return result;
          }
          if (draft.state === "abandoned" || draft.state === "applied")
            throw new AgentToolRefusal("Task draft is closed");
          if (args.choice === "continue" && changes.length)
            throw new AgentToolRefusal(
              "Conversation changed; inspect the task draft before continuing",
            );
          if (args.choice === "revise" && !args.revisedInput)
            throw new AgentToolRefusal("Revised task input is required");
          const state =
            args.choice === "revise"
              ? "editing"
              : args.choice === "keep"
                ? "kept"
                : args.choice === "abandon"
                  ? "abandoned"
                  : args.choice === "defer"
                    ? "deferred"
                    : "ready";
          this.recordTaskDraftReviews(draft.id, changes);
          this.db
            .prepare(
              "UPDATE owner_task_drafts SET input_json=COALESCE(?,input_json),state=?,updated_at=? WHERE id=?",
            )
            .run(
              args.choice === "revise" ? JSON.stringify(args.revisedInput) : null,
              state,
              this.now(),
              draft.id,
            );
          return { ...result, state };
        });
      }
      case "tasks.create":
      case "tasks.claim":
      case "tasks.claim_message":
      case "tasks.yield":
      case "tasks.transfer":
      case "tasks.update": {
        const taskOperation = name as
          | "tasks.create"
          | "tasks.claim"
          | "tasks.claim_message"
          | "tasks.yield"
          | "tasks.transfer"
          | "tasks.update";
        const args = agentConversationOperations[taskOperation].schema.parse(input);
        const messageId = "messageId" in args ? args.messageId : undefined;
        const task = "taskId" in args ? this.readTask(args.taskId) : undefined;
        const message = messageId
          ? (this.db
              .prepare(
                "SELECT id,channel_id,root_id FROM owner_messages WHERE id=? AND internal_kind IS NULL",
              )
              .get(messageId) as
              { id: string; channel_id: string; root_id: string | null } | undefined)
          : undefined;
        if (!task && !message) throw new AgentToolRefusal("Task or message is not available");
        if (taskOperation === "tasks.create" && messageId && this.taskForMessage(messageId))
          throw new AgentToolRefusal(
            "Message already has a task; use tasks.claim_message to claim it",
          );
        const channelId = task?.channelId ?? message!.channel_id;
        this.requireAgentConversation(run.agent_id, channelId);
        return this.recordAgentToolAction(run, toolCallId, taskOperation, args, () => {
          // Freshness follows the message the operation actually changes: a direct claim is scoped
          // to its target's anchor, not to whichever message id the Agent happened to pass.
          const anchorMessageId =
            taskOperation === "tasks.claim_message"
              ? (this.directClaimTarget(messageId!)?.anchorMessageId ?? messageId!)
              : (task?.messageId ?? messageId!);
          const anchor = this.db
            .prepare("SELECT root_id FROM owner_messages WHERE id=?")
            .get(anchorMessageId) as { root_id: string | null } | undefined;
          const rootId = anchor?.root_id ?? undefined;
          if (!args.draftId) {
            const { changes } = this.inspectAgentPositionChanges(
              run.agent_id,
              run.input_end_seq,
              channelId,
              rootId,
            );
            if (changes.length) {
              const draftId = randomUUID();
              this.db
                .prepare(
                  "INSERT INTO owner_task_drafts(id,agent_id,task_id,action,input_json,input_end_seq,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'editing',?,?)",
                )
                .run(
                  draftId,
                  run.agent_id,
                  task?.id ?? null,
                  name,
                  JSON.stringify(args),
                  run.input_end_seq,
                  this.now(),
                  this.now(),
                );
              this.recordTaskDraftReviews(draftId, changes);
              return { channelId, status: "needs_review", draftId, changes };
            }
          } else {
            const draft = this.db
              .prepare("SELECT * FROM owner_task_drafts WHERE id=? AND agent_id=?")
              .get(args.draftId, run.agent_id) as TaskDraftRow | undefined;
            if (
              !draft ||
              draft.action !== name ||
              draft.state !== "ready" ||
              draft.task_id !== (task?.id ?? null)
            )
              throw new AgentToolRefusal("Task draft is not ready");
            const original = JSON.parse(draft.input_json) as Record<string, unknown>;
            const current = { ...args } as Record<string, unknown>;
            delete current.draftId;
            delete original.draftId;
            if (JSON.stringify(original) !== JSON.stringify(current))
              throw new AgentToolRefusal("Task draft changed; revise it first");
            if (this.unreviewedTaskChanges(draft).length)
              throw new AgentToolRefusal("Conversation changed; review the task draft again");
            this.db
              .prepare("UPDATE owner_task_drafts SET state='applied',updated_at=? WHERE id=?")
              .run(this.now(), draft.id);
          }
          if (name === "tasks.create")
            return this.createTaskForMessage(messageId!, "agent", run.agent_id);
          if (name === "tasks.claim_message")
            return this.claimTaskForMessage(run.agent_id, messageId!);
          return this.mutateTask(run.agent_id, task!, name, args as Record<string, unknown>);
        });
      }
      case "conversations.join": {
        const args = agentConversationOperations["conversations.join"].schema.parse(input);
        const alreadyMember = this.isAgentChannelMember(run.agent_id, args.conversationId);
        if (alreadyMember) {
          const conversation = this.requireAgentConversation(run.agent_id, args.conversationId);
          if (conversation.kind !== "channel")
            throw new AgentToolRefusal("Only a public channel can be joined");
          return this.recordAgentToolAction(run, toolCallId, "conversations.join", args, () => ({
            conversationId: conversation.id,
            name: conversation.name,
            visibility: conversation.visibility,
            member: true,
            alreadyMember: true,
          }));
        }
        const conversation = this.requireReadableConversation(run.agent_id, args.conversationId);
        if (conversation.kind !== "channel" || conversation.visibility !== "public")
          throw new AgentToolRefusal("Only a public channel can be joined");
        return this.recordAgentToolAction(run, toolCallId, "conversations.join", args, () => {
          const channel = this.joinAgentToPublicChannel(run.agent_id, args.conversationId);
          if (!channel) throw new AgentToolRefusal("Only a public channel can be joined");
          return {
            conversationId: channel.id,
            name: channel.name,
            visibility: channel.visibility,
            member: true,
            alreadyMember: false,
          };
        });
      }
      case "conversations.invite": {
        const args = agentConversationOperations["conversations.invite"].schema.parse(input),
          conversation = this.requireAgentConversation(run.agent_id, args.conversationId);
        if (conversation.kind !== "channel")
          throw new AgentToolRefusal("Only a channel can receive an invitation");
        if (args.agentId === run.agent_id)
          throw new AgentToolRefusal("An Agent cannot invite itself");
        const currentMember = this.db
          .prepare(
            "SELECT active FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
          )
          .get(args.conversationId, args.agentId) as { active: number } | undefined;
        // A valid Agent invitation is effective at this same control-plane commit.
        if (!this.isInviteableAgent(args.agentId))
          throw new AgentToolRefusal("Invitation target is not available");
        return this.recordAgentToolAction(run, toolCallId, "conversations.invite", args, () => {
          if (!this.inviteAgentToChannel(args.conversationId, args.agentId))
            throw new AgentToolRefusal("Invitation target is not available");
          return {
            conversationId: args.conversationId,
            agentId: args.agentId,
            status: "succeeded",
            alreadyMember: currentMember?.active === 1,
          };
        });
      }
    }
  }

  listAgentAttention(
    agentId: string,
    channelId: string,
  ): Array<{
    messageId: string;
    unread: number;
    seen: number;
    deferred: number;
    muted: number;
    presented: number;
  }> {
    return this.db
      .prepare(
        `SELECT a.message_id AS messageId,a.unread,a.seen,a.deferred,a.muted,a.presented FROM owner_agent_message_attention a JOIN owner_messages m ON m.id=a.message_id WHERE a.agent_id=? AND m.channel_id=? ORDER BY m.order_seq`,
      )
      .all(agentId, channelId) as Array<{
      messageId: string;
      unread: number;
      seen: number;
      deferred: number;
      muted: number;
      presented: number;
    }>;
  }

  readPersistedAgentDraft(
    agentId: string,
    id: string,
  ): { state: string; text: string; channelId: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT state,text,channel_id AS channelId FROM owner_agent_drafts WHERE id=? AND agent_id=?",
      )
      .get(id, agentId) as { state: string; text: string; channelId: string } | undefined;
    return row;
  }

  private validateMessagePosition(channelId: string, rootId?: string, quoteId?: string): void {
    if (rootId && quoteId) throw new AgentToolRefusal("Choose one reply position");
    const id = rootId ?? quoteId;
    if (!id) return;
    const row = this.db
      .prepare("SELECT channel_id,root_id FROM owner_messages WHERE id=?")
      .get(id) as { channel_id: string; root_id: string | null } | undefined;
    if (!row || row.channel_id !== channelId || (rootId && row.root_id))
      throw new AgentToolRefusal("Reply target is not available");
  }

  /** Shared per-message freshness check for an authorized Agent send or task change. */
  inspectAgentPositionChanges(
    agentId: string,
    inputEndSequence: number,
    channelId: string,
    rootId?: string,
  ): { changes: OwnerMessage[] } {
    return {
      changes: this.unpresentedPositionMessages(agentId, inputEndSequence, channelId, rootId),
    };
  }

  private unpresentedPositionMessages(
    agentId: string,
    inputEndSequence: number,
    channelId: string,
    rootId?: string,
  ): OwnerMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.id,m.channel_id,m.order_seq,m.revision,m.text,m.root_id,m.quote_id,m.author_kind,m.author_id,m.created_at
      FROM owner_messages m WHERE m.channel_id=?
      AND NOT (m.author_kind='agent' AND m.author_id=?)
      AND (? IS NULL OR m.id=? OR m.root_id=?)
      AND NOT EXISTS (SELECT 1 FROM owner_agent_message_attention a WHERE a.agent_id=? AND a.message_id=m.id AND a.presented=1)
      AND NOT EXISTS (SELECT 1 FROM owner_message_deliveries d WHERE d.recipient_id=? AND d.recipient_kind='agent' AND d.message_id=m.id AND d.seq<=?)
      ORDER BY m.order_seq`,
      )
      .all(
        channelId,
        agentId,
        rootId ?? null,
        rootId ?? null,
        rootId ?? null,
        agentId,
        agentId,
        inputEndSequence,
      ) as MessageRow[];
    return rows.map(toMessage);
  }

  private unreviewedDraftChanges(draft: ReturnType<OwnerChat["readAgentDraft"]>): OwnerMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.id,m.channel_id,m.order_seq,m.revision,m.text,m.root_id,m.quote_id,m.author_kind,m.author_id,m.created_at
      FROM owner_messages m WHERE m.channel_id=?
      AND NOT (m.author_kind='agent' AND m.author_id=?)
      AND (? IS NULL OR m.id=? OR m.root_id=?)
      AND NOT EXISTS (SELECT 1 FROM owner_agent_draft_reviews r WHERE r.draft_id=? AND r.message_id=m.id)
      AND NOT EXISTS (SELECT 1 FROM owner_agent_message_attention a WHERE a.agent_id=? AND a.message_id=m.id AND a.presented=1)
      AND NOT EXISTS (SELECT 1 FROM owner_message_deliveries d WHERE d.recipient_id=? AND d.recipient_kind='agent' AND d.message_id=m.id AND d.seq<=?)
      ORDER BY m.order_seq`,
      )
      .all(
        draft.channel_id,
        draft.agent_id,
        draft.root_id,
        draft.root_id,
        draft.root_id,
        draft.id,
        draft.agent_id,
        draft.agent_id,
        draft.input_end_seq,
      ) as MessageRow[];
    return rows.map(toMessage);
  }

  private recordDraftReviews(draftId: string, messages: OwnerMessage[]): void {
    for (const message of messages) {
      this.db
        .prepare("INSERT OR IGNORE INTO owner_agent_draft_reviews(draft_id,message_id) VALUES(?,?)")
        .run(draftId, message.id);
      const draft = this.db
        .prepare("SELECT agent_id FROM owner_agent_drafts WHERE id=?")
        .get(draftId) as { agent_id: string };
      this.db
        .prepare(
          "INSERT OR IGNORE INTO owner_agent_message_attention(agent_id,message_id,updated_at) VALUES(?,?,?)",
        )
        .run(draft.agent_id, message.id, this.now());
      this.db
        .prepare(
          "UPDATE owner_agent_message_attention SET presented=1,updated_at=? WHERE agent_id=? AND message_id=?",
        )
        .run(this.now(), draft.agent_id, message.id);
    }
  }

  private readAgentDraft(
    agentId: string,
    id: string,
  ): {
    id: string;
    agent_id: string;
    channel_id: string;
    root_id: string | null;
    quote_id: string | null;
    text: string;
    input_end_seq: number;
    state: string;
  } {
    const row = this.db
      .prepare(
        "SELECT id,agent_id,channel_id,root_id,quote_id,text,input_end_seq,state FROM owner_agent_drafts WHERE id=? AND agent_id=?",
      )
      .get(id, agentId) as ReturnType<OwnerChat["readAgentDraft"]> | undefined;
    if (!row) throw new AgentToolRefusal("Draft is not available");
    return row;
  }

  private listAgentConversations(agentId: string): Array<{
    id: string;
    name: string;
    description: string;
    visibility: ChannelVisibility;
    kind: "channel" | "dm";
    member: boolean;
  }> {
    const rows = this.db
      .prepare(
        `SELECT c.id,c.name,c.description,c.visibility,d.agent_id AS direct_agent_id,
                CASE WHEN d.agent_id IS NOT NULL OR p.channel_id IS NOT NULL
                     THEN 'dm' ELSE 'channel' END AS conversation_kind,
                COALESCE(m.active,0) AS member
         FROM owner_channels c
         LEFT JOIN owner_channel_memberships m
           ON m.channel_id=c.id AND m.principal_kind='agent' AND m.principal_id=?
         LEFT JOIN owner_agent_direct_channels d ON d.channel_id=c.id
         LEFT JOIN owner_agent_peer_direct_channels p ON p.channel_id=c.id
         WHERE c.archived=0 AND (m.active=1 OR (
           c.visibility='public' AND d.agent_id IS NULL AND p.channel_id IS NULL
         ))
         ORDER BY c.created_at,c.id`,
      )
      .all(agentId) as Array<{
      id: string;
      name: string;
      description: string;
      visibility: ChannelVisibility;
      direct_agent_id: string | null;
      conversation_kind: "channel" | "dm";
      member: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      kind: row.conversation_kind,
      member: row.member === 1,
    }));
  }

  private listContactableAgents(agentId: string): Array<{
    id: string;
    name: string;
    role: string;
    description: string;
  }> {
    return this.db
      .prepare(
        `SELECT a.id,a.name,a.role,a.description
         FROM owner_agents a JOIN nodes n ON n.id=a.node_id
         WHERE a.id<>? AND a.stage='complete'
           AND n.linux_username IS NOT NULL AND n.uid IS NOT NULL AND n.gid IS NOT NULL
           AND a.home IS NOT NULL
         ORDER BY a.created_at,a.id`,
      )
      .all(agentId) as Array<{ id: string; name: string; role: string; description: string }>;
  }

  private getOrCreateAgentPeerDirectChannel(
    firstAgentId: string,
    secondAgentId: string,
  ): OwnerChannel {
    const ordered = [firstAgentId, secondAgentId].sort(),
      first = ordered[0],
      second = ordered[1];
    if (first === undefined || second === undefined)
      throw new AgentToolRefusal("Direct-message target is not available");
    const existing = this.db
      .prepare(
        `SELECT channel_id FROM owner_agent_peer_direct_channels
           WHERE first_agent_id=? AND second_agent_id=?`,
      )
      .get(first, second) as { channel_id: string } | undefined;
    if (existing) {
      const channel = this.readChannel(existing.channel_id);
      if (channel.archived) throw new AgentToolRefusal("Direct message is archived");
      return channel;
    }
    const participants = this.db
      .prepare("SELECT id,name FROM owner_agents WHERE id IN (?,?) ORDER BY id")
      .all(first, second) as Array<{ id: string; name: string }>;
    if (participants.length !== 2)
      throw new AgentToolRefusal("Direct-message target is not available");
    const id = randomUUID(),
      at = this.now(),
      names = new Map<string, string>(participants.map((agent) => [agent.id, agent.name])),
      firstName = names.get(first),
      secondName = names.get(second);
    if (firstName === undefined || secondName === undefined)
      throw new AgentToolRefusal("Direct-message target is not available");
    this.db
      .prepare(
        `INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at)
         VALUES(?,?,?,'private',?,?)`,
      )
      .run(
        id,
        `${firstName} ↔ ${secondName} 私信`,
        `${firstName} 与 ${secondName} 的私信。`,
        at,
        at,
      );
    this.db
      .prepare(
        `INSERT INTO owner_agent_peer_direct_channels(
           channel_id,first_agent_id,second_agent_id,created_at
         ) VALUES(?,?,?,?)`,
      )
      .run(id, first, second, at);
    this.db
      .prepare(
        `INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at)
         VALUES(?,'human','owner',1,?),(?, 'agent', ?,1,?),(?, 'agent', ?,1,?)`,
      )
      .run(id, at, id, first, at, id, second, at);
    const channel = this.readChannel(id);
    this.record("channel.created", id, channel);
    return channel;
  }

  /**
   * The one conversation-metadata SELECT. Membership is always probed, so a reader can get
   * the active-member flag without a second round trip.
   */
  private readConversationRow(agentId: string, conversationId: string) {
    return this.db
      .prepare(
        `SELECT c.id,c.name,c.description,c.visibility,
                CASE WHEN d.agent_id IS NOT NULL OR p.channel_id IS NOT NULL
                     THEN 'dm' ELSE 'channel' END AS conversation_kind,
                m.active AS active_member
         FROM owner_channels c
         LEFT JOIN owner_channel_memberships m
           ON m.channel_id=c.id AND m.principal_kind='agent' AND m.principal_id=? AND m.active=1
         LEFT JOIN owner_agent_direct_channels d ON d.channel_id=c.id
         LEFT JOIN owner_agent_peer_direct_channels p ON p.channel_id=c.id
         WHERE c.id=? AND c.archived=0`,
      )
      .get(agentId, conversationId) as
      | (AgentConversationFacts & {
          conversation_kind: "channel" | "dm";
          active_member: number | null;
        })
      | undefined;
  }

  private toConversationFacts(
    row: AgentConversationFacts & { conversation_kind: "channel" | "dm" },
  ): AgentConversationFacts {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      kind: row.conversation_kind,
    };
  }

  /**
   * Conversation metadata for a read. A public channel stays readable without membership;
   * a private conversation, or any direct message, is readable only to an active member.
   */
  private readAgentConversation(
    agentId: string,
    conversationId: string,
  ): AgentConversationFacts | undefined {
    const row = this.readConversationRow(agentId, conversationId);
    if (!row) return undefined;
    const readable =
      row.active_member === 1 ||
      (row.conversation_kind === "channel" &&
        row.visibility === "public" &&
        !this.isDirectChannel(conversationId));
    return readable ? this.toConversationFacts(row) : undefined;
  }

  /** Readable conversation metadata, or a refusal when this Agent may not read it. */
  private requireReadableConversation(
    agentId: string,
    conversationId: string,
  ): AgentConversationFacts {
    const conversation = this.readAgentConversation(agentId, conversationId);
    if (!conversation) throw new AgentToolRefusal("Conversation is not available");
    return conversation;
  }

  /** Member-only conversation metadata; every write and every membership change uses this gate. */
  private requireAgentConversation(
    agentId: string,
    conversationId: string,
  ): AgentConversationFacts {
    const row = this.readConversationRow(agentId, conversationId);
    if (!row || row.active_member !== 1)
      throw new AgentToolRefusal("Conversation is not available");
    return this.toConversationFacts(row);
  }

  private isInviteableAgent(agentId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM owner_agents a JOIN nodes n ON n.id=a.node_id
         WHERE a.id=? AND a.stage='complete'
           AND n.linux_username IS NOT NULL AND n.uid IS NOT NULL AND n.gid IS NOT NULL
           AND a.home IS NOT NULL`,
      )
      .get(agentId);
    return !!row;
  }

  private recordAgentToolAction(
    run: ActiveAgentToolRun,
    toolCallId: string,
    operation: AgentConversationOperation,
    input: unknown,
    effect: () => unknown,
  ): unknown {
    const validId = z.string().min(1).max(500).safeParse(toolCallId);
    if (!validId.success) throw new AgentToolRefusal("Invalid action ID");
    const requestHash = createHash("sha256")
        .update(JSON.stringify({ operation, input }))
        .digest("hex"),
      existing = this.db
        .prepare(
          "SELECT request_hash,result_json FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?",
        )
        .get(run.session_id, toolCallId) as
        { request_hash: string; result_json: string } | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new AgentToolRefusal("Action ID was already used for a different request");
      return JSON.parse(existing.result_json) as unknown;
    }
    const result = effect();
    this.db
      .prepare(
        `INSERT INTO owner_agent_tool_actions(
           session_id,action_id,agent_id,operation,request_hash,result_json,created_at
         ) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        run.session_id,
        toolCallId,
        run.agent_id,
        operation,
        requestHash,
        JSON.stringify(result),
        this.now(),
      );
    return result;
  }

  private createAgentToolMessage(
    run: ActiveAgentToolRun,
    toolActionId: string,
    channelId: string,
    text: string,
    rootId?: string,
    quoteId?: string,
    asTask?: boolean,
  ): OwnerMessage {
    if (!this.db.inTransaction)
      throw new Error("Agent tool message requires its action transaction");
    const id = randomUUID(),
      at = this.now(),
      sequence = this.db
        .prepare(
          "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
        )
        .get(channelId) as { next: number };
    this.db
      .prepare(
        "INSERT INTO owner_messages(id,channel_id,order_seq,text,root_id,quote_id,author_kind,author_id,created_at) VALUES(?,?,?,?,?,?, 'agent', ?,?)",
      )
      .run(id, channelId, sequence.next, text, rootId ?? null, quoteId ?? null, run.agent_id, at);
    const message = toMessage({
      id,
      channel_id: channelId,
      order_seq: sequence.next,
      revision: 1,
      text,
      root_id: rootId ?? null,
      quote_id: quoteId ?? null,
      author_kind: "agent",
      author_id: run.agent_id,
      created_at: at,
    });
    this.queueDeliveries(message, at);
    this.record("message.created", channelId, message);
    if (asTask) this.createTaskForMessage(id, "agent", run.agent_id);
    return message;
  }

  private queueDeliveries(message: OwnerMessage, at: number): void {
    if (!this.db.inTransaction)
      throw new Error("Message deliveries require the message transaction");
    // This is the recipient snapshot: later membership changes never backfill this message.
    const members = this.db
      .prepare(
        "SELECT principal_kind,principal_id FROM owner_channel_memberships WHERE channel_id=? AND active=1 ORDER BY principal_kind,principal_id",
      )
      .all(message.channelId) as Array<{
      principal_kind: OwnerPrincipalKind;
      principal_id: string;
    }>;
    for (const member of members) {
      if (
        member.principal_kind === message.author.kind &&
        member.principal_id === message.author.id
      )
        continue;
      this.db
        .prepare(
          "INSERT OR IGNORE INTO owner_message_deliveries(id,message_id,channel_id,recipient_kind,recipient_id,state,created_at) VALUES(?,?,?,?,?,'pending',?)",
        )
        .run(
          randomUUID(),
          message.id,
          message.channelId,
          member.principal_kind,
          member.principal_id,
          at,
        );
      if (member.principal_kind === "agent")
        this.db
          .prepare(
            "INSERT OR IGNORE INTO owner_agent_message_attention(agent_id,message_id,updated_at) SELECT id,?,? FROM owner_agents WHERE id=?",
          )
          .run(message.id, at, member.principal_id);
    }
  }

  private record(
    kind: string,
    channelId: string,
    payload: OwnerChannel | OwnerMessage | OwnerTask,
  ): void {
    if (!this.db.inTransaction)
      throw new Error("Conversation event requires the owning transaction");
    this.db
      .prepare("INSERT INTO owner_chat_events(kind,channel_id,payload,created_at) VALUES(?,?,?,?)")
      .run(kind, channelId, JSON.stringify(payload), this.now());
    if (
      kind === "message.created" &&
      "author" in payload &&
      payload.author.kind === "agent" &&
      payload.author.id !== "mate-system"
    ) {
      const ownerCanRead = !!this.db
        .prepare(
          "SELECT 1 FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='human' AND principal_id='owner' AND active=1",
        )
        .get(channelId);
      if (ownerCanRead) {
        const directToOwner = !!this.db
          .prepare("SELECT 1 FROM owner_agent_direct_channels WHERE channel_id=?")
          .get(channelId);
        try {
          this.pushMessage?.(payload, directToOwner);
        } catch {
          /* Notifications cannot undo chat. */
        }
      }
    }
    this.db
      .prepare(
        "DELETE FROM owner_chat_events WHERE seq <= (SELECT COALESCE(MAX(seq)-?,0) FROM owner_chat_events)",
      )
      .run(eventRetention);
  }
}

function toChannel(row: ChannelRow): OwnerChannel {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): OwnerMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    rootId: row.root_id ?? null,
    quoteId: row.quote_id ?? null,
    replyCount: 0,
    recentReplies: [],
    author:
      row.author_kind === "agent"
        ? { kind: "agent", id: row.author_id }
        : { kind: "human", id: "owner" },
    text: row.text,
    order: String(row.order_seq),
    revision: String(row.revision),
    createdAt: row.created_at,
  };
}

function toTask(row: TaskRow): OwnerTask {
  return {
    id: row.id,
    messageId: row.message_id,
    channelId: row.channel_id,
    title: row.title,
    status: row.status,
    ownerAgentId: row.owner_agent_id,
    ownerAgentName: row.owner_agent_name,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toReminder(row: ReminderRow): OwnerReminder {
  return {
    id: row.id,
    agentId: row.agent_id,
    channelId: row.channel_id,
    taskId: row.task_id,
    text: row.text,
    dueAt: row.due_at,
    state: row.state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
