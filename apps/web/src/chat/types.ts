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

export type MessageEntry = Extract<Entry, { kind: "message" }>;
export type TaskEntry = Extract<Entry, { kind: "task" }>;
