import { z } from "zod";
import { Id } from "./identifiers.ts";

export { Id };

/** A human reads every conversation and has the live view and push; an Agent reads what it is let into. */
export const AccountKind = z.enum(["human", "agent"]);
export type AccountKind = z.output<typeof AccountKind>;

/** An account as a client renders it: the author of an entry, a member of a conversation. */
export const AccountView = z.object({
  accountId: Id,
  handle: z.string(),
  displayName: z.string(),
  kind: AccountKind,
  active: z.boolean(),
});
export type AccountView = z.output<typeof AccountView>;

export const ConversationKind = z.enum(["public", "private", "dm"]);

/** A conversation as its reader sees it. `name` is null for a DM. */
export const ConversationView = z.object({
  conversationId: Id,
  kind: ConversationKind,
  name: z.string().nullable(),
  archived: z.boolean(),
  member: z.boolean(),
  members: z.array(Id),
});
export type ConversationView = z.output<typeof ConversationView>;

/**
 * Where entries live: a conversation's top level, or the thread under one top-level message (named by that
 * message's ID).
 */
export const TimelineRef = z.union([
  z.object({ conversation: Id }).strict(),
  z.object({ thread: Id }).strict(),
]);
export type TimelineRef = z.output<typeof TimelineRef>;

/** Attachment metadata. The bytes live elsewhere under `storageKey`; `size` counts against a read budget. */
export const Attachment = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  storageKey: z.string().min(1).max(512),
});

export const TaskChange = z.enum(["created", "claimed", "yielded", "transferred", "completed"]);

export const MessageEntry = z.object({
  kind: z.literal("message"),
  seq: z.number(),
  messageId: Id,
  author: Id,
  body: z.string(),
  attachments: z.array(Attachment),
  mentions: z.array(Id),
  at: z.number(),
});

/** One change to a task, placed in the timeline of the message the task belongs to. `owner` is the owner after it. */
export const TaskEntry = z.object({
  kind: z.literal("task"),
  seq: z.number(),
  taskId: Id,
  messageId: Id,
  actor: Id,
  change: TaskChange,
  title: z.string(),
  owner: Id.nullable(),
  at: z.number(),
});

/** One item of a timeline. Messages and task entries share the timeline's sequence. */
export const Entry = z.discriminatedUnion("kind", [MessageEntry, TaskEntry]);
export type Entry = z.output<typeof Entry>;

export const UnreadSummary = z.object({
  /** Unread entries by other accounts across all listed timelines. */
  total: z.number(),
  /** Unread messages that mention the account. */
  mentions: z.number(),
  timelines: z.array(
    z.object({
      conversationId: Id,
      timeline: TimelineRef,
      kind: ConversationKind,
      /** The channel's name; for a DM, the handle of the other member (both, comma-separated, for a non-member). */
      label: z.string(),
      inThread: z.boolean(),
      unread: z.number(),
      mentioned: z.boolean(),
      /** Handle of the author of the newest unread entry. */
      latestSender: z.string(),
    }),
  ),
});
export type UnreadSummary = z.output<typeof UnreadSummary>;

const SeqRange = z.object({ first: z.number(), last: z.number() });

/**
 * One forward read of a timeline. `unread` counts the entries by other accounts after the reader's previous
 * position. If they did not all fit the budget, `skipped` names the older range left out, and the sequence numbers
 * of messages in it that mention the reader. `position` is the reader's read position afterwards: the newest entry.
 */
export const ReadPage = z.object({
  timeline: TimelineRef,
  entries: z.array(Entry),
  unread: z.number(),
  returned: SeqRange.nullable(),
  skipped: SeqRange.extend({ mentions: z.array(z.number()) }).nullable(),
  position: z.number(),
});
export type ReadPage = z.output<typeof ReadPage>;

/** A message that reached the timeline. `task` is present when `createTask` was passed. */
export const SentMessage = z.object({
  status: z.literal("sent"),
  conversationId: Id,
  timeline: TimelineRef,
  seq: z.number(),
  messageId: Id,
  task: z.object({ taskId: Id, title: z.string() }).nullable(),
});
export type SentMessage = z.output<typeof SentMessage>;

/** A message blocked by the freshness check: the timeline had new entries the caller had not read. */
export const HeldMessage = z.object({ status: z.literal("held"), page: ReadPage });

export const SendResult = z.discriminatedUnion("status", [SentMessage, HeldMessage]);
export type SendResult = z.output<typeof SendResult>;

export const TaskStatus = z.enum(["open", "completed"]);

export const Task = z.object({
  taskId: Id,
  messageId: Id,
  title: z.string(),
  owner: Id.nullable(),
  status: TaskStatus,
});
export type Task = z.output<typeof Task>;

/**
 * The outcome of a task operation. `refused` is an outcome of the task's current state, which can change between a
 * caller's read and its action: someone else claimed it first, the caller no longer owns it, or it is completed.
 */
export const TaskResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), task: Task, seq: z.number() }),
  z.object({ status: z.literal("held"), page: ReadPage }),
  z.object({
    status: z.literal("refused"),
    reason: z.enum(["claimed", "not-owner", "completed"]),
    task: Task,
  }),
]);
export type TaskResult = z.output<typeof TaskResult>;

/**
 * Everything a human's client renders, as of one moment, and the cursor of that moment. `me` is the viewer's account.
 * `page` is the newest page of the timeline the client opened (newest first, as `readHistory` returns it) with the
 * viewer's read position there.
 */
export const LiveSnapshot = z.object({
  cursor: z.string(),
  me: Id,
  accounts: z.array(AccountView),
  conversations: z.array(ConversationView),
  unread: UnreadSummary,
  page: z
    .object({ timeline: TimelineRef, entries: z.array(Entry), position: z.number() })
    .nullable(),
});
export type LiveSnapshot = z.output<typeof LiveSnapshot>;

/**
 * One change to what a human's client shows. An entry is immutable, so its event carries it in full; the other
 * kinds carry their subject's current state, so applying a stale or repeated one converges on the same view.
 * `cursor` is the position just after this event.
 */
export const LiveEvent = z.discriminatedUnion("type", [
  z.object({
    cursor: z.string(),
    type: z.literal("entry"),
    conversationId: Id,
    timeline: TimelineRef,
    entry: Entry,
  }),
  z.object({ cursor: z.string(), type: z.literal("conversation"), conversation: ConversationView }),
  z.object({ cursor: z.string(), type: z.literal("account"), account: AccountView }),
  z.object({
    cursor: z.string(),
    type: z.literal("read"),
    conversationId: Id,
    timeline: TimelineRef,
    position: z.number(),
  }),
]);
export type LiveEvent = z.output<typeof LiveEvent>;

/**
 * Events after a cursor, with the viewer's unread summary as of the same read, so a client replaces its unread counts
 * instead of working out which timelines the viewer follows. `resnapshot` when the cursor does not name a position the
 * log still holds. `cursor` is where the read got to, past every event that is not for this viewer, so a viewer who is
 * rarely addressed still moves forward; asking again from it returns what came after.
 */
export const LiveEvents = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("events"),
    events: z.array(LiveEvent),
    cursor: z.string(),
    unread: UnreadSummary,
  }),
  z.object({ status: z.literal("resnapshot") }),
]);
export type LiveEvents = z.output<typeof LiveEvents>;

const Base64Url = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_-]+=*$/, "a key is base64url");

/** A browser's Web Push subscription, in the shape `PushSubscription.toJSON()` gives it. Other fields are ignored. */
export const WebPushSubscription = z.object({
  transport: z.undefined().optional(),
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  keys: z.object({ p256dh: Base64Url, auth: Base64Url }),
});
export type WebPushSubscription = z.output<typeof WebPushSubscription>;

export const ApnsEnvironment = z.enum(["sandbox", "production"]);

/** An iOS app's APNs device token, the APNs environment it belongs to, and the enrollment's random binding. */
export const ApnsSubscription = z.object({
  transport: z.literal("apns"),
  token: z
    .string()
    .max(512)
    .regex(/^(?:[a-fA-F0-9]{2})+$/)
    .transform((s) => s.toLowerCase()),
  environment: ApnsEnvironment,
  binding: z.uuid(),
});
export type ApnsSubscription = z.output<typeof ApnsSubscription>;

export const PushSubscription = z.union([ApnsSubscription, WebPushSubscription]);
export type PushSubscription = z.output<typeof PushSubscription>;

/** What names a subscription to remove: a browser's endpoint, or a native token with its binding. */
export const PushAddress = z.union([
  ApnsSubscription,
  z.object({ transport: z.undefined().optional(), endpoint: z.string().min(1).max(2048) }),
]);
export type PushAddress = z.output<typeof PushAddress>;

/**
 * The data a native push carries: an allowlisted destination, never a URL supplied by a notification. `binding` names
 * the one registration it was sent to, which the app recorded with its server and account.
 */
export const NativePushNotice = z.object({
  version: z.literal(1),
  binding: z.uuid(),
  conversationId: Id,
  threadId: Id.nullable(),
  seq: Id,
  tag: z.string().min(1).max(64),
  at: z.number().int().nonnegative(),
});
export type NativePushNotice = z.output<typeof NativePushNotice>;

/** Whether this server sends native pushes, and if so to which APNs environment. */
export const NativePushCapability = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), environment: ApnsEnvironment }),
]);
