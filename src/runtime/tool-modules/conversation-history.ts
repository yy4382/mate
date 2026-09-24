import { z } from "zod";
import { historySchemas } from "../../conversations/history.js";
import {
  conversationTargetSchema as targetSchema,
  type ConversationTarget,
} from "../../domain/conversations.js";
import {
  activeWork,
  fence,
  id,
  selectedWork,
  spec,
  targetWork,
  text,
  type ToolExecutionContext,
  type ToolModule,
  type ToolSpec,
} from "../tool-contract.js";

const historyDescription: Record<string, string> = {
  "history.page":
    "Page current authorized local history with canonical anchors and an opaque cursor. Coverage is local and live.",
  "history.search":
    "Bounded text or author search over current authorized local history. Empty pages may still have a cursor.",
  "history.around": "Retrieve nearby authorized context around a canonical message anchor.",
  "history.fetch":
    "Fetch one bounded page through the acting installation. Quiet acquisition creates no work or read acknowledgment.",
};
/** The history module decides whether this Agent may name the target the operation carried. */
function historyTarget(context: ToolExecutionContext, target: ConversationTarget): string {
  fence(context);
  context.history.authorize(context.run, target);
  return context.workId;
}
const historySpecs = [
  spec({
    name: "history.page",
    schema: historySchemas["history.page"],
    description: historyDescription["history.page"]!,
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    authorize: (context, args) => historyTarget(context, args.target),
    handler: ({ history, run }, args) => ({ value: history.page(run, args) }),
  }),
  spec({
    name: "history.search",
    schema: historySchemas["history.search"],
    description: historyDescription["history.search"]!,
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    authorize: (context, args) =>
      args.target ? historyTarget(context, args.target) : selectedWork(context),
    handler: ({ history, run }, args) => ({ value: history.search(run, args) }),
  }),
  spec({
    name: "history.around",
    schema: historySchemas["history.around"],
    description: historyDescription["history.around"]!,
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    authorize: selectedWork,
    handler: ({ history, run }, args) => ({ value: history.around(run, args) }),
  }),
  spec({
    name: "history.fetch",
    schema: historySchemas["history.fetch"],
    description: historyDescription["history.fetch"]!,
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    authorize: (context, args) => historyTarget(context, args.target),
    handler: async ({ history, run, signal }, args) => ({
      value: await history.fetch(run, args, signal),
    }),
  }),
];
/** One own durable delivery, re-read under the acting Agent's current target access. */
function ownDelivery(context: ToolExecutionContext, deliveryId: string): string {
  fence(context);
  const delivery = context.collaboration.store.delivery(deliveryId);
  if (delivery.agent_id !== context.run.agentId) throw new Error("Private inbox");
  const target = JSON.parse(delivery.payload).target;
  if (target)
    context.collaboration.messages.requireAccess(context.run.agentId, target.conversationId);
  return context.workId;
}

const definitions: ToolSpec[] = [
  ...historySpecs,
  spec({
    name: "conversations.refresh",
    schema: z.object({ conversationId: id }).strict(),
    description:
      "Re-read this Agent's own current membership of one external channel through its own installation and update local access. It answers for external channels only: a DM exists because the platform opened it, internal rooms are host-managed, and this operation never joins or leaves.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "adapter-recorded",
    replayPolicy: "boundary-owned",
    authorize: selectedWork,
    handler: async ({ directory, run, signal }, args) => {
      if (!directory) throw new Error("Directory unavailable");
      if (!directory.refresh) throw new Error("Membership source unavailable");
      return { value: await directory.refresh(run.agentId, args.conversationId, signal) };
    },
  }),
  spec({
    name: "conversations.list",
    schema: z.object({}).strict(),
    description:
      "List the conversations this Agent currently has: each one's source (internal host-managed room or external platform conversation), type, and per-source catalog coverage, so an incomplete listing is visible.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    authorize: selectedWork,
    handler: async ({ directory, run }) => {
      if (!directory) throw new Error("Directory unavailable");
      return { value: await directory.spaces(run.agentId) };
    },
  }),
  spec({
    name: "conversations.members",
    schema: z.object({ conversationId: id }).strict(),
    description:
      "List the current members of one conversation this Agent can read, using its own identity and current access; external conversations also need the platform read permission for that conversation. The result states whether the member list was read completely.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    authorize: (context, args) => targetWork(context, args.conversationId),
    handler: async ({ directory, run }, args) => {
      if (!directory) throw new Error("Directory unavailable");
      return { value: await directory.members(run.agentId, args.conversationId) };
    },
  }),
  spec({
    name: "conversations.openDM",
    schema: z
      .object({
        principal: z.object({ kind: z.enum(["human", "agent", "external"]), id }).strict(),
      })
      .strict(),
    description:
      "Open or find a direct conversation with one person, configured teammate or external principal through this Agent's own identity and installation; an existing DM still requires current access.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "adapter-recorded",
    replayPolicy: "boundary-owned",
    authorize: (context) => activeWork(context),
    handler: async ({ directory, run, actionId, signal }, args) => {
      if (!directory) throw new Error("Directory unavailable");
      return { value: await directory.openDM(run, actionId, args.principal, signal) };
    },
  }),
  spec({
    name: "attention.peek",
    schema: z.object({}).strict(),
    description: "Inspect content-free unread attention summaries.",
    replayScope: "work",
    seatPolicy: "redacted-read",
    effectPolicy: "atomic-recorded",
    replayPolicy: "refreshable",
    authorize: selectedWork,
    handler: ({ collaboration: c, run }) => ({ value: c.attention.peek(run.agentId) }),
  }),
  spec({
    name: "attention.read",
    schema: z.object({ target: targetSchema, cursor: id.optional() }).strict(),
    description:
      "Read current attention for an authorized target and receive a freshness view token.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => targetWork(context, args.target.conversationId),
    handler: ({ collaboration: c, run }, args) => ({
      value: c.attention.read(run, args.target, args.cursor),
    }),
  }),
  spec({
    name: "attention.resolve",
    schema: z
      .object({ target: targetSchema, throughRevision: z.number().int().nonnegative() })
      .strict(),
    description: "Resolve attention through a known revision without changing content history.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => targetWork(context, args.target.conversationId),
    handler: ({ collaboration: c, run }, args) => {
      c.attention.state(run.agentId, args.target, "resolve", args.throughRevision);
      return { value: null };
    },
  }),
  spec({
    name: "attention.defer",
    schema: z.object({ target: targetSchema, until: z.number().int().nonnegative() }).strict(),
    description: "Postpone a target until a timestamp while keeping new input unread.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => targetWork(context, args.target.conversationId),
    handler: ({ collaboration: c, run }, args) => {
      c.attention.state(run.agentId, args.target, "defer", args.until);
      return { value: null };
    },
  }),
  spec({
    name: "attention.mute",
    schema: z.object({ target: targetSchema, active: z.boolean() }).strict(),
    description: "Suppress ordinary target activity while direct requests and DMs still surface.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => targetWork(context, args.target.conversationId),
    handler: ({ collaboration: c, run }, args) => {
      c.attention.state(run.agentId, args.target, "mute", Number(args.active));
      return { value: null };
    },
  }),
  spec({
    name: "messages.recent",
    schema: z.object({ conversationId: id }).strict(),
    description: "Read recent visible messages in one authorized conversation.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => targetWork(context, args.conversationId),
    handler: ({ collaboration: c, run }, args) => ({
      value: c.messages.recent(run.agentId, args.conversationId),
    }),
  }),
  spec({
    name: "messages.read",
    schema: z.object({ target: targetSchema }).strict(),
    description: "Read the currently authorized message view for a target.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => targetWork(context, args.target.conversationId),
    handler: ({ collaboration: c, run }, args) => ({
      value: c.messages.read(run.agentId, args.target),
    }),
  }),
  spec({
    name: "messages.search",
    schema: z.object({ query: text }).strict(),
    description: "Search currently visible messages through the bounded local index.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "refreshable",
    authorize: selectedWork,
    handler: ({ collaboration: c, run }, args) => ({
      value: c.messages.search(run.agentId, args.query),
    }),
  }),
  spec({
    name: "messages.send",
    schema: z.object({ target: targetSchema, text, viewToken: id.optional() }).strict(),
    description: "Queue an explicit visible reply through the freshness gate.",
    replayScope: "work",
    seatPolicy: "held-send",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) =>
      activeWork(context, targetWork(context, args.target.conversationId)),
    handler: ({ collaboration: c, gate, run, workId, actionId }, args) => {
      c.send(run.agentId, workId, args.target, args.text, actionId, {
        run,
        viewToken: args.viewToken,
      });
      return { value: gate.describe(run.agentId, actionId) };
    },
  }),
  spec({
    name: "messages.watch",
    schema: z.object({ target: targetSchema, active: z.boolean() }).strict(),
    description: "Enable or disable ordinary attention for an authorized target.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => targetWork(context, args.target.conversationId),
    handler: ({ collaboration: c, run }, args) => {
      c.messages.watch(run.agentId, args.target, args.active);
      return { value: null };
    },
  }),
  spec({
    name: "inbox.list",
    schema: z.object({}).strict(),
    description: "List content-free private delivery metadata still relevant under current ACL.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "refreshable",
    authorize: selectedWork,
    handler: ({ collaboration: c, run }) => {
      const value = (
        c.store.db
          .prepare(
            "SELECT id,payload,status FROM deliveries WHERE agent_id=? AND status!='handled' ORDER BY created_at LIMIT 50",
          )
          .all(run.agentId) as { id: string; payload: string; status: string }[]
      )
        .filter((d) => {
          const target = JSON.parse(d.payload).target;
          if (!target?.conversationId) return true;
          try {
            c.messages.requireAccess(run.agentId, target.conversationId);
            return true;
          } catch {
            return false;
          }
        })
        .map((d) => ({ id: d.id, status: d.status, kind: JSON.parse(d.payload).kind }));
      return { value };
    },
  }),
  spec({
    name: "inbox.read",
    schema: z.object({ deliveryId: id }).strict(),
    description: "Read one own delivery under current target access.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => ownDelivery(context, args.deliveryId),
    handler: ({ collaboration: c }, args) => {
      const delivery = c.store.delivery(args.deliveryId);
      return { value: { ...delivery, payload: JSON.parse(delivery.payload) } };
    },
  }),
  spec({
    name: "inbox.ack",
    schema: z.object({ deliveryId: id }).strict(),
    description: "Acknowledge injection of one own delivery without marking it handled.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => ownDelivery(context, args.deliveryId),
    handler: ({ collaboration: c, run }, args) => {
      const delivery = c.store.delivery(args.deliveryId);
      c.store.db
        .prepare("INSERT INTO inbox_reads VALUES(?,?,?) ON CONFLICT DO NOTHING")
        .run(delivery.id, run.agentId, Date.now());
      return { value: { ...delivery, payload: JSON.parse(delivery.payload) } };
    },
  }),
];

export const conversationHistoryModule: ToolModule = Object.freeze({
  domain: "conversation-history",
  specs: Object.freeze(definitions),
});
