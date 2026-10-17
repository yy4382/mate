import type {
  AccountView,
  ConversationView,
  Entry,
  LiveEvent,
  LiveEvents,
  LiveSnapshot,
  ReadPage,
  SendResult,
  TaskResult,
  TimelineRef,
  UnreadSummary,
} from "@mate/chat";

export type {
  AccountView,
  ConversationView,
  Entry,
  LiveEvent,
  LiveEvents,
  LiveSnapshot,
  ReadPage,
  SendResult,
  TaskResult,
  TimelineRef,
  UnreadSummary,
};

/** The key a timeline has in the client: `c<conversation>` for a top level, `t<root message>` for a thread. */
export type TimelineKey = `c${number}` | `t${number}`;

export type MessageEntry = Extract<Entry, { kind: "message" }>;
export type TaskEntry = Extract<Entry, { kind: "task" }>;

export const timelineKey = (ref: TimelineRef): TimelineKey =>
  "conversation" in ref ? `c${ref.conversation}` : `t${ref.thread}`;

export const timelineQuery = (ref: TimelineRef): string =>
  "conversation" in ref ? `conversation=${ref.conversation}` : `thread=${ref.thread}`;
