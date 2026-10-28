import type { Admin } from "@mate/admin";
import type { ChatApp } from "@mate/chat";
import { PushSubscription } from "@mate/chat/contracts";
import type { ApnsConfig } from "./apns.ts";
import type { Role } from "./contracts.ts";
import { streamAgent, streamLive, type EventStream } from "./event-stream.ts";
import { forwarded, parseBody, HttpError } from "./http.ts";

/** The human a request acts as. */
export type Requester = {
  /** Their chat account. */
  readonly account: number;
  /** The external ID linking the chat account to the shell's record of them. */
  readonly externalId: string;
  readonly role: Role;
  /** The session token the request carries. */
  readonly token: string;
};

export type RouteInput = {
  readonly human: Requester;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: unknown;
  /** The SSE `Last-Event-ID` a reconnecting EventSource sends. */
  readonly lastEventId: string | undefined;
};

/**
 * One operation of the logged-in human over HTTP. A `json` route answers with what it returns (204 when that is
 * undefined); a `stream` route answers with server-sent events. `path` segments starting with `:` are parameters.
 * An `admin` route answers a member with 403 `admin-only` before it looks at the request body.
 */
export type Route = {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly admin?: true;
} & (
  | { readonly json: (input: RouteInput) => unknown }
  | { readonly stream: (input: RouteInput, stream: EventStream) => Promise<void> }
);

/** Marks every route as admin-only. */
export function adminOnly(routes: Route[]): Route[] {
  return routes.map((route) => ({ ...route, admin: true }));
}

/** Refuse a member the routes marked `admin`. */
export function requireRole(route: Route, human: Requester): void {
  if (route.admin === true && human.role !== "admin")
    throw new HttpError(403, "admin-only", "only an admin may do this");
}

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
 * The chat app as the requesting human uses it, always as their own account. The web client sends without the
 * freshness check: the human watches the timeline live, and showing an entry is what advances their read position
 * (`read`).
 */
export function chatRoutes(chat: ChatApp, vapidPublicKey: string, apns?: ApnsConfig): Route[] {
  const conversationAction =
    (action: "join" | "leave" | "archiveChannel") =>
    ({ human, params, body }: RouteInput) =>
      chat[action](human.account, {
        ...forwarded<{ requestId: string }>(body),
        conversationId: Number(params.id),
      });
  return [
    {
      method: "GET",
      path: "/api/chat/snapshot",
      json: ({ human, query }) => {
        const timeline = timelineIn(query);
        return chat.liveSnapshot(human.account, timeline === undefined ? {} : { timeline });
      },
    },
    {
      method: "GET",
      path: "/api/chat/events",
      stream: ({ human, query, lastEventId }, stream) => {
        const cursor = lastEventId ?? query.get("cursor");
        if (cursor === null)
          throw new HttpError(400, "invalid-input", "follow a snapshot's cursor: cursor=<cursor>");
        return streamLive(stream, chat, human.account, cursor);
      },
    },
    {
      method: "GET",
      path: "/api/chat/conversations",
      json: ({ human }) => chat.listConversations(human.account),
    },
    {
      method: "GET",
      path: "/api/chat/unread",
      json: ({ human }) => chat.unreadSummary(human.account),
    },
    {
      method: "GET",
      path: "/api/chat/history",
      json: ({ human, query }) =>
        chat.readHistory(
          human.account,
          requireTimeline(query),
          numbersIn(query, "before", "limit"),
        ),
    },
    {
      method: "GET",
      path: "/api/chat/search",
      json: ({ human, query }) => chat.search(human.account, query.get("q") ?? ""),
    },
    {
      method: "POST",
      path: "/api/chat/read",
      json: ({ human, body }) => {
        const { timeline, ...request } = forwarded<{ timeline: Read[1] } & Read[2]>(body);
        return chat.readUnread(human.account, timeline, request);
      },
    },
    {
      method: "POST",
      path: "/api/chat/messages",
      json: ({ human, body }) => {
        const { timeline, ...request } = forwarded<{ timeline: Send[1] } & Send[2]>(body);
        return chat.send(human.account, timeline, { ...request, freshness: false });
      },
    },
    {
      method: "POST",
      path: "/api/chat/channels",
      json: ({ human, body }) => chat.createChannel(human.account, forwarded(body)),
    },
    {
      method: "POST",
      path: "/api/chat/dms",
      json: ({ human, body }) => chat.openDm(human.account, forwarded(body)),
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
      json: ({ human, params, body }) =>
        chat.invite(human.account, {
          ...forwarded<Omit<Parameters<ChatApp["invite"]>[1], "conversationId">>(body),
          conversationId: Number(params.id),
        }),
    },
    {
      method: "POST",
      path: "/api/chat/tasks",
      json: ({ human, body }) =>
        chat.createTask(human.account, { ...forwarded(body), freshness: false }),
    },
    {
      method: "POST",
      path: "/api/chat/tasks/:id/change",
      json: ({ human, params, body }) =>
        chat.changeTask(human.account, {
          ...forwarded<Omit<Parameters<ChatApp["changeTask"]>[1], "taskId">>(body),
          taskId: Number(params.id),
          freshness: false,
        }),
    },
    {
      method: "GET",
      path: "/api/chat/push/native",
      json: () =>
        apns
          ? { enabled: true, environment: apns.environment, server: apns.server }
          : { enabled: false },
    },
    {
      method: "GET",
      path: "/api/chat/push/key",
      json: () => ({ publicKey: vapidPublicKey }),
    },
    {
      method: "POST",
      path: "/api/chat/push/subscribe",
      json: ({ human, body }) => {
        const subscription = parseBody(PushSubscription, body);
        if (subscription.transport === "apns") {
          if (!apns)
            throw new HttpError(
              503,
              "native-push-disabled",
              "APNs is not configured on this server",
            );
          if (subscription.environment !== apns.environment)
            throw new HttpError(409, "apns-environment-mismatch");
        }
        chat.subscribePush(human.account, subscription);
      },
    },
    {
      method: "POST",
      path: "/api/chat/push/unsubscribe",
      json: ({ human, body }) => chat.unsubscribePush(human.account, forwarded(body)),
    },
  ];
}

const agentId = (params: RouteInput["params"]) => params.id ?? "";

/** The admin module's operations, for admins only. */
export function adminRoutes(admin: Admin): Route[] {
  return adminOnly([
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
      method: "PUT",
      path: "/api/admin/agents/:id/nodes/:nodeId",
      json: ({ params }) => admin.grantNode(agentId(params), params.nodeId ?? ""),
    },
    {
      method: "DELETE",
      path: "/api/admin/agents/:id/nodes/:nodeId",
      json: ({ params }) => admin.revokeNode(agentId(params), params.nodeId ?? ""),
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
      method: "PUT",
      path: "/api/admin/nodes/:id",
      json: ({ params, body }) =>
        admin.renameNode(params.id ?? "", forwarded<{ name: string }>(body).name),
    },
    {
      method: "POST",
      path: "/api/admin/pairing-tokens",
      json: () => admin.createPairingToken(),
    },
  ]);
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
      params[part.slice(1)] = decoded(segment);
      return segment !== "";
    });
    if (matches) return { route, params };
  }
  return undefined;
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "invalid-input", `malformed percent-encoding in ${segment}`);
  }
}
