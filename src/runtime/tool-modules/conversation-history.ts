import { z } from "zod";
import { historySchemas } from "../../conversations/history.js";
import { conversationTargetSchema as targetSchema } from "../../domain/conversations.js";
import {
  authorizeReferences,
  fence,
  id,
  spec,
  text,
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
const historySpecs = Object.entries(historySchemas).map(([name, schema]) =>
  spec({
    name,
    schema,
    description: historyDescription[name]!,
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: async ({ history, run, signal }, args) => ({
      value:
        name === "history.fetch"
          ? await history.fetch(run, args, signal)
          : name === "history.page"
            ? history.page(run, args)
            : name === "history.search"
              ? history.search(run, args)
              : history.around(run, args),
    }),
  }),
);

const definitions: ToolSpec[] = [
  ...historySpecs,
  spec({
    name: "conversations.capabilities",
    schema: z.object({ conversationId: id.optional() }).strict(),
    description:
      "Inspect implemented participation operations and platform conditions without granting access.",
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: ({ directory, run }, args) => {
      if (!directory) throw new Error("Directory unavailable");
      return {
        value: directory.capabilities?.(run.agentId, args.conversationId) ?? {
          discover: false,
          join: false,
          leave: false,
          refresh: false,
          notes: ["Adapter does not implement participation controls"],
        },
      };
    },
  }),
  spec({
    name: "conversations.discover",
    schema: z.object({ cursor: z.string().min(1).max(10000).optional() }).strict(),
    description: "Page public space metadata through the adapter without granting message access.",
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: async ({ directory, run }, args) => {
      if (!directory) throw new Error("Directory unavailable");
      return {
        value: (await directory.discover?.(run.agentId, args.cursor)) ?? {
          supported: false,
          reason: "Discovery unavailable",
        },
      };
    },
  }),
  spec({
    name: "conversations.join",
    schema: z.union([
      z.object({ conversationId: id }).strict(),
      z.object({ candidateId: id }).strict(),
    ]),
    description: "Join a discovered public external channel with a durable adapter receipt.",
    workPolicy: "current",
    seatPolicy: "deny",
    effectPolicy: "adapter-recorded",
    replayPolicy: "boundary-owned",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: async ({ directory, run, actionId, signal }, args) => {
      if (!directory) throw new Error("Directory unavailable");
      if (args.candidateId)
        return {
          value: (await directory.joinCandidate?.(run, actionId, args.candidateId, signal)) ?? {
            status: "unsupported",
            reason: "Candidate joining unavailable",
          },
        };
      return {
        value: (await directory.membership?.(
          run,
          actionId,
          args.conversationId,
          "join",
          signal,
        )) ?? { status: "unsupported", reason: "Membership control unavailable" },
      };
    },
  }),
  spec({
    name: "conversations.leave",
    schema: z.object({ conversationId: id }).strict(),
    description: "Leave an external channel with a durable adapter receipt.",
    workPolicy: "current",
    seatPolicy: "deny",
    effectPolicy: "adapter-recorded",
    replayPolicy: "boundary-owned",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: async ({ directory, run, actionId, signal }, args) => {
      if (!directory) throw new Error("Directory unavailable");
      return {
        value: (await directory.membership?.(
          run,
          actionId,
          args.conversationId,
          "leave",
          signal,
        )) ?? { status: "unsupported", reason: "Membership control unavailable" },
      };
    },
  }),
  spec({
    name: "conversations.refresh",
    schema: z.object({ conversationId: id }).strict(),
    description: "Observe current external membership and reconcile uncertain membership writes.",
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "adapter-recorded",
    replayPolicy: "boundary-owned",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: async ({ directory, run, signal }, args) => {
      if (!directory) throw new Error("Directory unavailable");
      return {
        value: (await directory.refresh?.(run.agentId, args.conversationId, signal)) ?? {
          status: "unsupported",
          reason: "Membership source unavailable",
        },
      };
    },
  }),
  spec({
    name: "conversations.list",
    schema: z.object({}).strict(),
    description: "List conversation spaces currently available to this Agent.",
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: async ({ directory, run }) => {
      if (!directory) throw new Error("Directory unavailable");
      return { value: await directory.spaces(run.agentId) };
    },
  }),
  spec({
    name: "conversations.members",
    schema: z.object({ conversationId: id }).strict(),
    description: "List current members of one authorized conversation.",
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    authorize: authorizeReferences,
    postAwait: fence,
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
    description: "Open or find a direct conversation through the directory boundary.",
    workPolicy: "current",
    seatPolicy: "deny",
    effectPolicy: "adapter-recorded",
    replayPolicy: "boundary-owned",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: async ({ directory, run, actionId, signal }, args) => {
      if (!directory) throw new Error("Directory unavailable");
      return { value: await directory.openDM(run, actionId, args.principal, signal) };
    },
  }),
  spec({
    name: "attention.peek",
    schema: z.object({}).strict(),
    description: "Inspect content-free unread attention summaries.",
    workPolicy: "none",
    seatPolicy: "redacted-read",
    effectPolicy: "atomic-recorded",
    replayPolicy: "refreshable",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: ({ collaboration: c, run }) => ({ value: c.attention.peek(run.agentId) }),
  }),
  spec({
    name: "attention.read",
    schema: z.object({ target: targetSchema, cursor: id.optional() }).strict(),
    description:
      "Read current attention for an authorized target and receive a freshness view token.",
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: authorizeReferences,
    postAwait: fence,
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
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: ({ collaboration: c, run }, args) => {
      c.attention.state(run.agentId, args.target, "resolve", args.throughRevision);
      return { value: null };
    },
  }),
  spec({
    name: "attention.defer",
    schema: z.object({ target: targetSchema, until: z.number().int().nonnegative() }).strict(),
    description: "Postpone a target until a timestamp while keeping new input unread.",
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: ({ collaboration: c, run }, args) => {
      c.attention.state(run.agentId, args.target, "defer", args.until);
      return { value: null };
    },
  }),
  spec({
    name: "attention.mute",
    schema: z.object({ target: targetSchema, active: z.boolean() }).strict(),
    description: "Suppress ordinary target activity while direct requests and DMs still surface.",
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: ({ collaboration: c, run }, args) => {
      c.attention.state(run.agentId, args.target, "mute", Number(args.active));
      return { value: null };
    },
  }),
  spec({
    name: "messages.recent",
    schema: z.object({ conversationId: id }).strict(),
    description: "Read recent visible messages in one authorized conversation.",
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: ({ collaboration: c, run }, args) => ({
      value: c.messages.recent(run.agentId, args.conversationId),
    }),
  }),
  spec({
    name: "messages.read",
    schema: z.object({ target: targetSchema }).strict(),
    description: "Read the currently authorized message view for a target.",
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: ({ collaboration: c, run }, args) => ({
      value: c.messages.read(run.agentId, args.target),
    }),
  }),
  spec({
    name: "messages.search",
    schema: z.object({ query: text }).strict(),
    description: "Search currently visible messages through the bounded local index.",
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "refreshable",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: ({ collaboration: c, run }, args) => ({
      value: c.messages.search(run.agentId, args.query),
    }),
  }),
  spec({
    name: "messages.send",
    schema: z.object({ target: targetSchema, text, viewToken: id.optional() }).strict(),
    description: "Queue an explicit visible reply through the freshness gate.",
    workPolicy: "current",
    seatPolicy: "held-send",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: authorizeReferences,
    postAwait: fence,
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
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: ({ collaboration: c, run }, args) => {
      c.messages.watch(run.agentId, args.target, args.active);
      return { value: null };
    },
  }),
  spec({
    name: "inbox.list",
    schema: z.object({}).strict(),
    description: "List content-free private delivery metadata still relevant under current ACL.",
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "refreshable",
    authorize: authorizeReferences,
    postAwait: fence,
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
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: authorizeReferences,
    postAwait: fence,
    handler: ({ collaboration: c }, args) => {
      const delivery = c.store.delivery(args.deliveryId);
      return { value: { ...delivery, payload: JSON.parse(delivery.payload) } };
    },
  }),
  spec({
    name: "inbox.ack",
    schema: z.object({ deliveryId: id }).strict(),
    description: "Acknowledge injection of one own delivery without marking it handled.",
    workPolicy: "none",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: authorizeReferences,
    postAwait: fence,
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
