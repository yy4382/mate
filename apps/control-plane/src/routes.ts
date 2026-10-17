import type { Admin } from "@mate/admin";
import type { ChatApp } from "@mate/chat";
import { streamAgent, streamLive, type EventStream } from "./event-stream.ts";
import { forwarded, HttpError } from "./http.ts";

export type RouteInput = {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: unknown;
  /** The SSE `Last-Event-ID` a reconnecting EventSource sends. */
  readonly lastEventId: string | undefined;
};

/**
 * One owner operation over HTTP. A `json` route answers with what it returns (204 when that is undefined); a `stream`
 * route answers with server-sent events. `path` segments starting with `:` are parameters.
 */
export type Route = {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
} & (
  | { readonly json: (input: RouteInput) => unknown }
  | { readonly stream: (input: RouteInput, stream: EventStream) => Promise<void> }
);

type Send = Parameters<ChatApp["send"]>;
type Read = Parameters<ChatApp["readUnread"]>;

/** The timeline a query names with `conversation=<id>` or `thread=<id>`. The chat app checks the ids. */
function timelineIn(query: URLSearchParams): Send[1] | undefined {
  const conversation = query.get("conversation");
  if (conversation !== null) return { conversation: Number(conversation) };
  const thread = query.get("thread");
  return thread === null ? undefined : { thread: Number(thread) };
}

function requireTimeline(query: URLSearchParams): Send[1] {
  const timeline = timelineIn(query);
  if (timeline === undefined)
    throw new HttpError(
      400,
      "invalid-input",
      "name the timeline: conversation=<id> or thread=<id>",
    );
  return timeline;
}

/** The named query parameters that are present, as numbers. The chat app checks them. */
function numbersIn(query: URLSearchParams, ...names: string[]): Record<string, number> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = query.get(name);
      return value === null ? [] : [[name, Number(value)]];
    }),
  );
}

/**
 * The chat app as the owner uses it. The web client sends without the freshness check: the owner watches the timeline
 * live, and showing an entry is what advances the owner's read position (`read`).
 */
export function chatRoutes(chat: ChatApp, owner: number, vapidPublicKey: string): Route[] {
  const conversationAction =
    (action: "join" | "leave" | "archiveChannel") =>
    ({ params, body }: RouteInput) =>
      chat[action](owner, {
        ...forwarded<{ requestId: string }>(body),
        conversationId: Number(params.id),
      });
  return [
    {
      method: "GET",
      path: "/api/chat/snapshot",
      json: ({ query }) => {
        const timeline = timelineIn(query);
        return chat.liveSnapshot(owner, timeline === undefined ? {} : { timeline });
      },
    },
    {
      method: "GET",
      path: "/api/chat/events",
      stream: ({ query, lastEventId }, stream) => {
        const cursor = lastEventId ?? query.get("cursor");
        if (cursor === null)
          throw new HttpError(400, "invalid-input", "follow a snapshot's cursor: cursor=<cursor>");
        return streamLive(stream, chat, owner, cursor);
      },
    },
    { method: "GET", path: "/api/chat/conversations", json: () => chat.listConversations(owner) },
    { method: "GET", path: "/api/chat/unread", json: () => chat.unreadSummary(owner) },
    {
      method: "GET",
      path: "/api/chat/history",
      json: ({ query }) =>
        chat.readHistory(owner, requireTimeline(query), numbersIn(query, "before", "limit")),
    },
    {
      method: "GET",
      path: "/api/chat/search",
      json: ({ query }) => chat.search(owner, query.get("q") ?? ""),
    },
    {
      method: "POST",
      path: "/api/chat/read",
      json: ({ body }) => {
        const { timeline, ...request } = forwarded<{ timeline: Read[1] } & Read[2]>(body);
        return chat.readUnread(owner, timeline, request);
      },
    },
    {
      method: "POST",
      path: "/api/chat/messages",
      json: ({ body }) => {
        const { timeline, ...request } = forwarded<{ timeline: Send[1] } & Send[2]>(body);
        return chat.send(owner, timeline, { ...request, freshness: false });
      },
    },
    {
      method: "POST",
      path: "/api/chat/channels",
      json: ({ body }) => chat.createChannel(owner, forwarded(body)),
    },
    {
      method: "POST",
      path: "/api/chat/dms",
      json: ({ body }) => chat.openDm(owner, forwarded(body)),
    },
    {
      method: "POST",
      path: "/api/chat/conversations/:id/join",
      json: conversationAction("join"),
    },
    {
      method: "POST",
      path: "/api/chat/conversations/:id/leave",
      json: conversationAction("leave"),
    },
    {
      method: "POST",
      path: "/api/chat/conversations/:id/archive",
      json: conversationAction("archiveChannel"),
    },
    {
      method: "POST",
      path: "/api/chat/conversations/:id/invite",
      json: ({ params, body }) =>
        chat.invite(owner, {
          ...forwarded<Omit<Parameters<ChatApp["invite"]>[1], "conversationId">>(body),
          conversationId: Number(params.id),
        }),
    },
    {
      method: "POST",
      path: "/api/chat/tasks",
      json: ({ body }) => chat.createTask(owner, { ...forwarded(body), freshness: false }),
    },
    {
      method: "POST",
      path: "/api/chat/tasks/:id/change",
      json: ({ params, body }) =>
        chat.changeTask(owner, {
          ...forwarded<Omit<Parameters<ChatApp["changeTask"]>[1], "taskId">>(body),
          taskId: Number(params.id),
          freshness: false,
        }),
    },
    {
      method: "GET",
      path: "/api/chat/push/key",
      json: () => ({ publicKey: vapidPublicKey }),
    },
    {
      method: "POST",
      path: "/api/chat/push/subscribe",
      json: ({ body }) => chat.subscribePush(owner, forwarded(body)),
    },
    {
      method: "POST",
      path: "/api/chat/push/unsubscribe",
      json: ({ body }) => chat.unsubscribePush(owner, forwarded(body)),
    },
  ];
}

const agentId = (params: RouteInput["params"]) => params.id ?? "";

/** The admin module's operations. */
export function adminRoutes(admin: Admin): Route[] {
  return [
    { method: "GET", path: "/api/admin/agents", json: () => admin.agents() },
    {
      method: "POST",
      path: "/api/admin/agents",
      json: async ({ body }) => ({ agentId: await admin.createAgent(forwarded(body)) }),
    },
    {
      method: "POST",
      path: "/api/admin/agents/:id/pause",
      json: ({ params }) => admin.pauseAgent(agentId(params)),
    },
    {
      method: "POST",
      path: "/api/admin/agents/:id/resume",
      json: ({ params }) => admin.resumeAgent(agentId(params)),
    },
    {
      method: "DELETE",
      path: "/api/admin/agents/:id",
      json: ({ params }) => admin.deleteAgent(agentId(params)),
    },
    {
      method: "PUT",
      path: "/api/admin/agents/:id/settings",
      json: ({ params, body }) => admin.configureAgent(agentId(params), forwarded(body)),
    },
    {
      method: "GET",
      path: "/api/admin/agents/:id/assistants",
      json: ({ params }) => admin.assistants(agentId(params)),
    },
    {
      method: "GET",
      path: "/api/admin/agents/:id/events",
      stream: ({ params, query }, stream) => {
        const assistant = query.get("assistant");
        return streamAgent(stream, (listener) =>
          admin.watchAgent(agentId(params), listener, assistant === null ? {} : { assistant }),
        );
      },
    },
    {
      method: "GET",
      path: "/api/admin/agents/:id/workspace",
      json: ({ params, query }) => admin.browseWorkspace(agentId(params), query.get("path") ?? "."),
    },
    { method: "GET", path: "/api/admin/providers", json: () => admin.providers() },
    {
      method: "PUT",
      path: "/api/admin/providers/:provider/credentials",
      json: ({ params, body }) => admin.setCredentials(params.provider ?? "", forwarded(body)),
    },
    {
      method: "DELETE",
      path: "/api/admin/providers/:provider/credentials",
      json: ({ params }) => admin.deleteCredentials(params.provider ?? ""),
    },
    { method: "GET", path: "/api/admin/models", json: () => admin.models() },
    { method: "GET", path: "/api/admin/nodes", json: () => admin.nodes() },
    {
      method: "POST",
      path: "/api/admin/pairing-tokens",
      json: () => admin.createPairingToken(),
    },
  ];
}

/** The route for `method` and `pathname`, with its parameters. */
export function matchRoute(
  routes: readonly Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | undefined {
  const segments = pathname.split("/");
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = route.path.split("/");
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const matches = pattern.every((part, index) => {
      const segment = segments[index] ?? "";
      if (!part.startsWith(":")) return part === segment;
      params[part.slice(1)] = decodeURIComponent(segment);
      return segment !== "";
    });
    if (matches) return { route, params };
  }
  return undefined;
}
