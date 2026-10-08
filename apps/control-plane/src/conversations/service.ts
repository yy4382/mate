import type { OwnerChatSnapshot } from "@mate/protocol/owner";
import type Database from "better-sqlite3";
import { ConversationDirectory } from "./channels/directory.js";
import { ChannelMembership } from "./channels/membership.js";
import { ConversationEvents } from "./events.js";
import { ConversationAttention } from "./messages/attention.js";
import { MessageDeliveries } from "./messages/deliveries.js";
import { MessageTimeline } from "./messages/timeline.js";
import { MessageWriter } from "./messages/writer.js";
import { ReminderService } from "./tasks/reminders.js";
import { TaskService } from "./tasks/service.js";
import { ConversationToolActions } from "./tools/actions.js";

/** Assemble conversation capabilities over one database and clock. */
export function createOwnerChat(db: Database.Database, now: () => number = Date.now) {
  const toolActions = new ConversationToolActions(db, now);
  const events = new ConversationEvents(db, now);
  const conversations = new ConversationDirectory(db, events, now, toolActions);
  const channels = new ChannelMembership(db, conversations, events, now, toolActions);
  const timeline = new MessageTimeline(db, conversations, now);
  const attention = new ConversationAttention(db, conversations, now, toolActions);
  const deliveries = new MessageDeliveries(db, now);
  const tasks = new TaskService(
    db,
    {
      requireMembership: (agentId, channelId) => {
        conversations.requireAgentConversation(agentId, channelId);
      },
      isMember: (agentId, channelId) => conversations.isAgentChannelMember(agentId, channelId),
      inspectPositionChanges: (position) => attention.inspectAgentPositionChanges(position),
      recordTaskEvent: (kind, channelId, task) => events.record(kind, channelId, task),
    },
    now,
    toolActions,
  );
  const reminders = new ReminderService(
    db,
    conversations,
    tasks.readTask.bind(tasks),
    now,
    toolActions,
  );
  const messages = new MessageWriter(
    db,
    conversations,
    deliveries,
    events,
    tasks.createTaskForMessage.bind(tasks),
    now,
  );

  return {
    conversations,
    channels,
    timeline,
    attention,
    deliveries,
    messages,
    tasks,
    reminders,
    events,

    snapshot(): OwnerChatSnapshot {
      return db
        .transaction(() => ({ channels: channels.listChannels(), cursor: events.eventCursor() }))
        .deferred();
    },

    agentTools() {
      const directoryTools = conversations.agentTools();
      const channelTools = channels.agentTools();
      const timelineTools = timeline.agentTools();
      const attentionTools = attention.agentTools(messages);

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
        ...tasks.agentTools(),
        ...reminders.agentTools(),
        "conversations.join": channelTools["conversations.join"],
        "conversations.invite": channelTools["conversations.invite"],
      };
    },
  };
}

export type OwnerChat = ReturnType<typeof createOwnerChat>;
