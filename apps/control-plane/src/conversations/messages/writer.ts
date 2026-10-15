import type { OwnerMessage } from "@mate/protocol/owner";
import { ArchivedChannelError } from "../errors.js";
import { toMessage } from "../rows.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentSession } from "../../runtime/session/service.js";
import type { CurrentAgentToolRun } from "../../runtime/tools/entry.js";
import type { NewOwnerMessage } from "../contracts.js";
import type { TaskService } from "../tasks/service.js";
import type { ConversationDirectory } from "../channels/directory.js";
import type { ConversationEvents } from "../events.js";
import type { MessageDeliveries } from "./deliveries.js";
const automaticTaskTitleLength = 200;

export class MessageWriter {
  constructor(
    private readonly db: Database.Database,
    private readonly directory: ConversationDirectory,
    private readonly deliveries: MessageDeliveries,
    private readonly events: ConversationEvents,
    private readonly createTaskForMessage: TaskService["createTaskForMessage"],
    private readonly now: () => number,
  ) {}

  createMessage({
    channelId,
    text,
    ...position
  }: NewOwnerMessage & { channelId: string }): OwnerMessage | undefined {
    const id = randomUUID();
    const at = this.now();
    return this.db
      .transaction(() => {
        const channel = z
          .looseObject({ archived: z.number() })
          .optional()
          .parse(this.db.prepare("SELECT archived FROM owner_channels WHERE id=?").get(channelId));
        if (!channel) return undefined;
        if (channel.archived) throw new ArchivedChannelError();

        if (position.rootId && position.quoteId)
          throw new Error("A message cannot be both a thread and quote reply");
        const targetId = position.rootId ?? position.quoteId;
        if (targetId) {
          const target = z
            .looseObject({ channel_id: z.string(), root_id: z.string().nullable() })
            .optional()
            .parse(
              this.db
                .prepare("SELECT channel_id,root_id FROM owner_messages WHERE id=?")
                .get(targetId),
            );
          if (!target || target.channel_id !== channelId || (position.rootId && target.root_id))
            throw new Error("Reply target is not a root message in this conversation");
        }
        const sequence = z
          .looseObject({ next: z.number() })
          .parse(
            this.db
              .prepare(
                "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
              )
              .get(channelId),
          );
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
          text,
          root_id: position.rootId ?? null,
          quote_id: position.quoteId ?? null,
          author_kind: "human",
          author_id: "owner",
          created_at: at,
        });
        this.deliveries.queueDeliveries(message, at);
        this.events.record("message.created", channelId, message);
        if (position.asTask)
          this.createTaskForMessage({
            messageId: id,
            actorKind: "human",
            actorId: "owner",
            title: text.slice(0, automaticTaskTitleLength),
          });
        return message;
      })
      .immediate();
  }

  /** Queue a private Mate fact so a corrected operation wakes its Agent once. */
  notifyAgentReceiptCorrection(
    agentId: string,
    operationId: string,
    state: "succeeded" | "failed",
  ) {
    const channel = this.directory.getOrCreateAgentDirectChannel(agentId);
    const at = this.now();
    const id = randomUUID();
    const processReceipt = z
      .looseObject({ receipt_json: z.string().nullable() })
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT receipt_json FROM owner_agent_process_operations WHERE operation_id=? AND agent_id=?",
          )
          .get(operationId, agentId),
      );
    const workspaceReceipt = z
      .looseObject({ result_json: z.string() })
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT result_json FROM owner_agent_tool_actions WHERE agent_id=? AND json_extract(CASE WHEN json_valid(result_json) THEN result_json ELSE '{}' END,'$.operationId')=?",
          )
          .get(agentId, operationId),
      );
    const queued = new AgentSession(this.db).queueCorrection(
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
    if (!queued.created || !channel || channel.archived) return queued.id;
    const text = `Mate 已核对操作 ${operationId} 的收据：${state === "succeeded" ? "成功" : "失败"}。完整更正将在后续模型上下文中呈现。`;
    this.db
      .transaction(() => {
        const sequence = z
          .looseObject({ next: z.number() })
          .parse(
            this.db
              .prepare(
                "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
              )
              .get(channel.id),
          );
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
          text,
          author_kind: "agent",
          author_id: "mate-system",
          created_at: at,
        });
        this.deliveries.queueDeliveries(message, at);
        this.events.record("message.created", channel.id, message);
      })
      .immediate();
    return queued.id;
  }

  createAgentToolMessage(
    run: CurrentAgentToolRun,
    { channelId, text, rootId, quoteId, asTask }: NewOwnerMessage & { channelId: string },
  ): OwnerMessage {
    if (!this.db.inTransaction)
      throw new Error("Agent tool message requires its action transaction");
    const id = randomUUID();
    const at = this.now();
    const sequence = z
      .looseObject({ next: z.number() })
      .parse(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
          )
          .get(channelId),
      );
    this.db
      .prepare(
        "INSERT INTO owner_messages(id,channel_id,order_seq,text,root_id,quote_id,author_kind,author_id,created_at,source_conversation_id) VALUES(?,?,?,?,?,?, 'agent', ?,?,?)",
      )
      .run(
        id,
        channelId,
        sequence.next,
        text,
        rootId ?? null,
        quoteId ?? null,
        run.agent_id,
        at,
        run.conversation_id,
      );
    const message = toMessage({
      id,
      channel_id: channelId,
      order_seq: sequence.next,
      text,
      root_id: rootId ?? null,
      quote_id: quoteId ?? null,
      author_kind: "agent",
      author_id: run.agent_id,
      created_at: at,
    });
    this.deliveries.queueDeliveries(message, at);
    this.events.record("message.created", channelId, message);
    if (asTask)
      this.createTaskForMessage({
        messageId: id,
        actorKind: "agent",
        actorId: run.agent_id,
        title: text.slice(0, automaticTaskTitleLength),
      });
    return message;
  }
}
