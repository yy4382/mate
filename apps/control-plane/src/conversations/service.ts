import { ConversationDirectory } from "./channels/directory.js";
import { ChannelMembership } from "./channels/membership.js";
import { ConversationEvents } from "./events.js";
import { ConversationAttention } from "./messages/attention.js";
import { MessageDeliveries } from "./messages/deliveries.js";
import { MessageTimeline } from "./messages/timeline.js";
import { MessageWriter } from "./messages/writer.js";
import { ReminderService } from "./tasks/reminders.js";

import type {
  OwnerChannel,
  OwnerChatEvent,
  OwnerChatSnapshot,
  OwnerMessage,
  OwnerMessageDeliveryPage,
  OwnerMessagePage,
  OwnerPrincipalKind,
  OwnerTask,
} from "@mate/protocol/owner";
import type { NewOwnerChannel, OwnerChannelUpdate } from "./contracts.js";

import type Database from "better-sqlite3";

import { TaskService } from "./tasks/service.js";
import { ConversationToolActions } from "./tools/actions.js";
export class OwnerChat {
  private readonly events: ConversationEvents;
  private readonly directory: ConversationDirectory;
  private readonly channels: ChannelMembership;
  private readonly timeline: MessageTimeline;
  private readonly attention: ConversationAttention;
  private readonly deliveries: MessageDeliveries;
  private readonly messages: MessageWriter;
  private readonly tasks: TaskService;
  private readonly reminders: ReminderService;
  constructor(
    private readonly db: Database.Database,
    now: () => number = Date.now,
  ) {
    const toolActions = new ConversationToolActions(db, now);
    this.events = new ConversationEvents(db, now);
    this.directory = new ConversationDirectory(db, this.events, now, toolActions);
    this.channels = new ChannelMembership(db, this.directory, this.events, now, toolActions);
    this.timeline = new MessageTimeline(db, this.directory, now);
    this.attention = new ConversationAttention(db, this.directory, now, toolActions);
    this.deliveries = new MessageDeliveries(db, now);
    this.tasks = new TaskService(
      db,
      {
        requireMembership: (agentId, channelId) => {
          this.directory.requireAgentConversation(agentId, channelId);
        },
        isMember: (agentId, channelId) => this.directory.isAgentChannelMember(agentId, channelId),
        inspectPositionChanges: (agentId, sequence, channelId, rootId) =>
          this.attention.inspectAgentPositionChanges(agentId, sequence, channelId, rootId),
        recordTaskEvent: (kind, channelId, task) => this.events.record(kind, channelId, task),
      },
      now,
      toolActions,
    );
    this.reminders = new ReminderService(
      db,
      this.directory,
      this.tasks.readTask.bind(this.tasks),
      now,
      toolActions,
    );
    this.messages = new MessageWriter(
      db,
      this.directory,
      this.deliveries,
      this.events,
      this.tasks.createTaskForMessage.bind(this.tasks),
      now,
    );
  }

  setPushHandler(handler: (message: OwnerMessage, directToOwner: boolean) => void): void {
    return this.events.setPushHandler(handler);
  }

  createChannel(input: NewOwnerChannel): OwnerChannel {
    return this.channels.createChannel(input);
  }

  listChannels(): OwnerChannel[] {
    return this.channels.listChannels();
  }

  listInvitableChannels(): OwnerChannel[] {
    return this.channels.listInvitableChannels();
  }

  /** Create or return the one private owner conversation bound to this verified Agent. */
  getOrCreateAgentDirectChannel(agentId: string): OwnerChannel | undefined {
    return this.directory.getOrCreateAgentDirectChannel(agentId);
  }

  /** Add a provisioned Agent to an active channel before its messages can be delivered. */
  inviteAgentToChannel(channelId: string, agentId: string): boolean {
    return this.channels.inviteAgentToChannel(channelId, agentId);
  }

  /**
   * Let an Agent join a public channel it chose to take part in, under the same commit
   * that records the decision. Joining grants no read of the past: unread state is still
   * created only by the delivery snapshot of a later message, so old history is never
   * backfilled as unread, and an earlier re-join keeps the original joined_at.
   */
  joinAgentToPublicChannel(agentId: string, channelId: string): OwnerChannel | undefined {
    return this.channels.joinAgentToPublicChannel(agentId, channelId);
  }

  snapshot(): OwnerChatSnapshot {
    return this.db
      .transaction(() => ({
        channels: this.channels.listChannels(),
        cursor: this.events.eventCursor(),
      }))
      .deferred();
  }

  eventsAfter(cursor: number, limit = 100): { stale: boolean; events: OwnerChatEvent[] } {
    return this.events.eventsAfter(cursor, limit);
  }

  updateChannel(id: string, input: OwnerChannelUpdate): OwnerChannel | undefined {
    return this.channels.updateChannel(id, input);
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
    return this.messages.createMessage(channelId, text, position);
  }

  /** Queue a private Mate fact so a corrected operation wakes its Agent once. */
  notifyAgentReceiptCorrection(
    agentId: string,
    operationId: string,
    state: "succeeded" | "failed",
  ): void {
    return this.messages.notifyAgentReceiptCorrection(agentId, operationId, state);
  }

  createTaskForMessage(
    messageId: string,
    actorKind: OwnerPrincipalKind,
    actorId: string,
    title: string,
  ): OwnerTask {
    return this.tasks.createTaskForMessage(messageId, actorKind, actorId, title);
  }

  readTask(id: string): OwnerTask | undefined {
    return this.tasks.readTask(id);
  }

  tasksForMessage(messageId: string): OwnerTask[] {
    return this.tasks.tasksForMessage(messageId);
  }

  listTasks(): OwnerTask[] {
    return this.tasks.listTasks();
  }

  taskActivity(taskId: string): unknown[] {
    return this.tasks.taskActivity(taskId);
  }

  listAgentReminders(agentId: string) {
    return this.reminders.listAgentReminders(agentId);
  }

  fireDueReminders(): number {
    return this.reminders.fireDueReminders();
  }

  syncHandledReminders(): void {
    return this.reminders.syncHandledReminders();
  }

  listPendingDeliveries(
    recipientKind: OwnerPrincipalKind,
    recipientId: string,
    after = 0,
    limit = 100,
  ): OwnerMessageDeliveryPage {
    return this.deliveries.listPendingDeliveries(recipientKind, recipientId, after, limit);
  }

  acknowledgeDelivery(
    deliveryId: string,
    recipientKind: OwnerPrincipalKind,
    recipientId: string,
  ): boolean {
    return this.deliveries.acknowledgeDelivery(deliveryId, recipientKind, recipientId);
  }

  /**
   * Complete a successful run and mark only the deliveries its boundary captured as handled.
   * Speaking, staying silent and completing a run are separate facts: this never changes a task.
   */
  completeAgentRun(runId: string, agentId: string): boolean {
    return this.deliveries.completeAgentRun(runId, agentId);
  }

  listMessages(
    channelId: string,
    before: number | undefined,
    limit: number,
  ): OwnerMessagePage | undefined {
    return this.timeline.listMessages(channelId, before, limit);
  }

  messageContext(channelId: string, messageId: string) {
    return this.timeline.messageContext(channelId, messageId);
  }

  listThread(
    channelId: string,
    rootId: string,
  ): { root: OwnerMessage; replies: OwnerMessage[] } | undefined {
    return this.timeline.listThread(channelId, rootId);
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
    return this.attention.listAgentAttention(agentId, channelId);
  }

  readPersistedAgentDraft(
    agentId: string,
    id: string,
  ): { state: string; text: string; channelId: string } | undefined {
    return this.attention.readPersistedAgentDraft(agentId, id);
  }

  /** Shared per-message freshness check for an authorized Agent send or task change. */
  inspectAgentPositionChanges(
    agentId: string,
    inputEndSequence: number,
    channelId: string,
    rootId?: string,
  ): { changes: OwnerMessage[] } {
    return this.attention.inspectAgentPositionChanges(agentId, inputEndSequence, channelId, rootId);
  }

  agentTools() {
    const directoryTools = this.directory.agentTools();
    const channelsTools = this.channels.agentTools();
    const timelineTools = this.timeline.agentTools();
    const attentionTools = this.attention.agentTools(this.messages);

    return {
      "agents.list": directoryTools["agents.list"],
      "conversations.list": directoryTools["conversations.list"],
      "conversations.read": timelineTools["conversations.read"],
      "conversations.read_thread": timelineTools["conversations.read_thread"],
      "conversations.open_dm": directoryTools["conversations.open_dm"],
      "attention.list": attentionTools["attention.list"],
      "attention.update": attentionTools["attention.update"],
      "drafts.save": attentionTools["drafts.save"],
      "drafts.review": attentionTools["drafts.review"],
      "messages.send": attentionTools["messages.send"],
      ...this.tasks.agentTools(),
      ...this.reminders.agentTools(),
      "conversations.join": channelsTools["conversations.join"],
      "conversations.invite": channelsTools["conversations.invite"],
    };
  }
}
