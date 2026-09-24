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

/**
 * The three kinds of history a model can reach are described apart on purpose: local coverage
 * (what this Agent already has and currently may see), remote acquisition (one page through its
 * own platform installation) and `attention.read` (a frozen paginated snapshot that records
 * presentation and mints the sending credential). A quiet history read is none of the others.
 * The map is keyed by the schema names, so a renamed operation breaks the lookup.
 */
const historyDescription: Record<keyof typeof historySchemas, string> = {
  "history.page":
    "Read a bounded page of locally covered history, newest first per conversation, with a continuation cursor. Local coverage is live: it reflects the messages this Agent can see right now. It never records presentation and never mints the freshness view token messages.send uses, though a change it discovers leaves an older token stale.",
  "history.search":
    "Bounded text or author search over locally covered history with a continuation cursor, newest first per conversation. Local coverage is live and describes only what this Agent can see now, never the whole workspace. A page can return nothing and still continue: follow the cursor.",
  "history.around":
    "Read the nearest locally covered context around a canonical message anchor. `before` and `after` set the widths of that first read, which reports beforeTruncated/afterTruncated and no cursor. Passing `direction` together with `limit` instead walks one bounded direction away from the anchor, and only such a walk returns a continuation cursor. Live, read-only, and never a record of what you presented or of the whole conversation.",
  "history.fetch":
    "Fetch one bounded page of remote history through this Agent's own platform installation and cache it locally for this Agent. Remote retention, filtering and paging decide what the page holds, so never read it as the whole workspace; follow the continuation cursor, then use local history. It wakes nobody and presents nothing.",
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
    description: historyDescription["history.page"],
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
    description: historyDescription["history.search"],
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
    description: historyDescription["history.around"],
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
    description: historyDescription["history.fetch"],
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
  context.collaboration.ownDelivery(context.run.agentId, deliveryId);
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
    name: "conversations.invite",
    schema: z.object({ conversationId: id, agentId: id }).strict(),
    description:
      "Invite one configured teammate Agent to an external channel this Agent is currently in, using this Agent's own Slack identity. Slack's public and private channel permissions decide the request. A sent request is not success: the teammate's access changes only when Slack's member list confirms it, and an unconfirmed outcome is verified by reading that list instead of inviting again.",
    replayScope: "work",
    seatPolicy: "deny",
    effectPolicy: "adapter-recorded",
    replayPolicy: "boundary-owned",
    // The inviter's current membership of the channel the call names is re-checked around the
    // call; the directory owns the team-identity, self-invitation and internal-room rules.
    authorize: (context, args) => targetWork(context, args.conversationId),
    handler: async ({ directory, run, actionId, signal }, args) => {
      if (!directory?.invite) throw new Error("Channel invitation unavailable");
      return {
        value: await directory.invite(run, actionId, args.conversationId, args.agentId, signal),
      };
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
      "Read the frozen paginated attention snapshot for an authorized target. This is the reading that records presentation and mints the freshness view token messages.send can use; history.page/search/around/fetch never do either.",
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
    handler: ({ collaboration: c, run }) => ({ value: c.inbox(run.agentId) }),
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
    handler: ({ collaboration: c, run }, args) => ({
      value: c.ownDelivery(run.agentId, args.deliveryId),
    }),
  }),
];

export const conversationHistoryModule: ToolModule = Object.freeze({
  domain: "conversation-history",
  specs: Object.freeze(definitions),
});
