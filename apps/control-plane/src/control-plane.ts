import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { openAdmin } from "@mate/admin";
import { ChatApp, type PushSender } from "@mate/chat";
import { systemClock, type Clock } from "@mate/clock";
import { createNodeGateway } from "@mate/gateway";
import { LoginInput, type LoginResult } from "./contracts.ts";
import { EventStream } from "./event-stream.ts";
import { Frontend } from "./frontend.ts";
import { humanRoutes } from "./human-routes.ts";
import {
  cookie,
  parseBody,
  parseJson,
  readBody,
  refusal,
  requireSameOrigin,
  sendJson,
} from "./http.ts";
import { Humans, bootstrapHumans, SESSION_TTL_MS, type Session } from "./humans.ts";
import { vapidKeys, webPushSender } from "./push.ts";
import { adminRoutes, chatRoutes, matchRoute, requireRole } from "./routes.ts";
import { openShellTables } from "./store.ts";
import { openApns, type ApnsOptions } from "./apns.ts";

/** `__Host-` makes the browser accept the cookie only from this origin, over HTTPS, for every path. */
const SESSION_COOKIE = "__Host-mate_session";
/** Where nodes open their WebSocket to the gateway. */
const NODE_CONNECT_PATH = "/api/nodes/connect";
/** The pages behind login; everything the client routes lives under it. */
const APP_PATH = "/app";
const BASE = "http://mate.invalid";

export type ControlPlaneOptions = {
  readonly dataDirectory: string;
  /** 0 or absent picks a free port. */
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  /** Read only on the first start, when there is no human yet; required then. */
  readonly initialPasswordFile?: string | undefined;
  /** The first human's handle, used only on the first start. Defaults to `admin`. */
  readonly initialHandle?: string | undefined;
  /** The built web client. Without it the API still works and pages answer 404. */
  readonly webDirectory?: string | undefined;
  /** The contact a push service may use about this control plane's pushes: a `mailto:` or `https:` URL. */
  readonly vapidSubject?: string | undefined;
  readonly clock?: Clock | undefined;
  /** Replaces Web Push delivery, for tests. */
  readonly push?: PushSender | undefined;
  readonly apns?: ApnsOptions | undefined;
};

export type ControlPlane = {
  /** The origin the control plane listens on. */
  readonly url: string;
  /** Stop serving, then close the admin module (and every Agent), the gateway and the chat app, in that order. */
  close(): Promise<void>;
};

/**
 * Start the control plane on `dataDirectory`: the chat app with a human account for everyone who may log in, the node
 * gateway, and the admin module with every Agent, behind the humans' login on one HTTP server.
 */
export async function startControlPlane(options: ControlPlaneOptions): Promise<ControlPlane> {
  const { dataDirectory } = options;
  const clock = options.clock ?? systemClock;
  const closers: (() => unknown)[] = [];
  try {
    const store = openShellTables(dataDirectory);
    closers.push(() => store.close());
    const humans = new Humans(store, clock);
    const keys = vapidKeys(store);
    const apns = options.apns && openApns(options.apns, () => clock.now());
    if (apns) closers.push(() => apns.close());
    const web = webPushSender(keys, options.vapidSubject ?? "mailto:owner@mate.invalid");
    const chat = new ChatApp(join(dataDirectory, "chat.sqlite"), {
      clock,
      push:
        options.push ??
        ((subscription, notice) =>
          subscription.transport === "apns"
            ? // With native push turned off, keep the subscription so it works again once turned back on.
              apns
              ? apns.send(subscription, notice)
              : Promise.resolve("refused")
            : web(subscription, notice)),
    });
    closers.push(() => chat.close());
    await bootstrapHumans(humans, chat, {
      initialPasswordFile: options.initialPasswordFile,
      initialHandle: options.initialHandle,
    });
    const gateway = createNodeGateway({ dataDirectory, clock });
    closers.push(() => gateway.close());
    const admin = await openAdmin({
      dataDirectory,
      chat,
      gateway,
      clock,
      report: (error, agentId) => console.error(`Agent ${agentId}:`, error),
    });
    closers.push(() => admin.close());

    const routes = [
      ...chatRoutes(chat, keys.publicKey, options.apns),
      ...humanRoutes(chat, humans),
      ...adminRoutes(admin),
    ];
    const frontend =
      options.webDirectory === undefined ? undefined : new Frontend(options.webDirectory);

    async function api(request: IncomingMessage, response: ServerResponse, url: URL) {
      const method = request.method ?? "GET";
      const token = cookie(request, SESSION_COOKIE);
      if (method !== "GET") requireSameOrigin(request);
      // The session is looked up only once the whole request has arrived, so a request still arriving when its
      // session logs out acts as nobody.
      const body = method === "GET" ? undefined : await readBody(request);
      if (method === "POST" && url.pathname === "/api/login") {
        const input = parseBody(LoginInput, parseJson(request, body));
        const account = chat.findHuman(input.handle);
        const result = await humans.logIn(
          account?.active === true ? account.externalId : undefined,
          input.password,
        );
        if (result.status === "limited")
          return sendJson(response, 429, { error: "too-many-attempts" }, { "retry-after": "1" });
        if (result.status === "wrong") return sendJson(response, 401, { error: "wrong-password" });
        return sendJson(response, 200, { next: appPathOr(input.next) } satisfies LoginResult, {
          "set-cookie": sessionCookie(result.session),
        });
      }
      if (method === "POST" && url.pathname === "/api/logout") {
        if (token !== undefined) humans.logOut(token);
        return sendJson(response, 204, undefined, { "set-cookie": sessionCookie(undefined) });
      }
      const session = humans.session(token);
      if (session === undefined) return sendJson(response, 401, { error: "login-required" });
      const matched = matchRoute(routes, method, url.pathname);
      if (matched === undefined) return sendJson(response, 404, { error: "no-route" });
      const { route, params } = matched;
      const account = chat.findAccount(session.externalId);
      if (account === undefined) throw new Error(`human ${session.externalId} has no chat account`);
      const human = {
        account,
        externalId: session.externalId,
        role: session.role,
        token: session.token,
      };
      requireRole(route, human);
      const lastEventId = request.headers["last-event-id"];
      const input = {
        human,
        params,
        query: url.searchParams,
        body: parseJson(request, body),
        lastEventId: typeof lastEventId === "string" ? lastEventId : undefined,
      };
      if ("json" in route) return sendJson(response, 200, await route.json(input));
      await route.stream(input, new EventStream(response, humans, session.token, clock));
      response.end();
    }

    function page(request: IncomingMessage, response: ServerResponse, url: URL) {
      if (request.method !== "GET" && request.method !== "HEAD")
        return sendJson(response, 405, { error: "method-not-allowed" });
      const asset = frontend?.file(url.pathname);
      if (frontend !== undefined && asset !== undefined && asset !== frontend.index)
        return frontend.serve(response, asset);
      if (url.pathname === "/") return redirect(response, APP_PATH);
      if (isAppPath(url.pathname) && humans.session(cookie(request, SESSION_COOKIE)) === undefined)
        return redirect(response, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      const index = frontend?.index;
      if (frontend === undefined || index === undefined)
        return response
          .writeHead(404, { "content-type": "text/plain; charset=utf-8" })
          .end("The web client is not installed.\n");
      frontend.serve(response, index);
    }

    async function handle(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? "/", BASE);
      if (url.pathname.startsWith("/api/")) return api(request, response, url);
      return page(request, response, url);
    }

    const server = createServer((request, response) => {
      handle(request, response).catch((error: unknown) => {
        const { status, body } = refusal(error);
        if (status >= 500) console.error(`${request.method} ${request.url}:`, error);
        if (response.headersSent) response.end();
        else sendJson(response, status, body);
      });
    });
    server.on("upgrade", (request, socket, head: Buffer) => {
      if (new URL(request.url ?? "/", BASE).pathname === NODE_CONNECT_PATH)
        gateway.handleUpgrade(request, socket, head);
      else socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
    });
    const { address, port } = server.address() as AddressInfo;
    const host = address.includes(":") ? `[${address}]` : address;

    return {
      url: `http://${host}:${port}`,
      async close() {
        const stopped = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await closeInReverse(closers);
        await stopped;
      },
    };
  } catch (error) {
    await closeInReverse(closers);
    throw error;
  }
}

async function closeInReverse(closers: (() => unknown)[]): Promise<void> {
  for (const close of closers.reverse()) {
    try {
      await close();
    } catch (error) {
      console.error("closing the control plane:", error);
    }
  }
}

function isAppPath(pathname: string): boolean {
  return pathname === APP_PATH || pathname.startsWith(`${APP_PATH}/`);
}

/** Where to go after login: `next` if it is a page of this app under /app, else /app. */
function appPathOr(next: string | undefined): string {
  if (next === undefined) return APP_PATH;
  try {
    const url = new URL(next, BASE);
    if (url.origin === BASE && isAppPath(url.pathname)) return url.pathname + url.search + url.hash;
  } catch {
    // Not a URL at all.
  }
  return APP_PATH;
}

/** The cookie carrying `session`, or one that clears it. */
function sessionCookie(session: Session | undefined): string {
  const attributes = "Path=/; HttpOnly; Secure; SameSite=Lax";
  if (session === undefined) return `${SESSION_COOKIE}=; ${attributes}; Max-Age=0`;
  return `${SESSION_COOKIE}=${session.token}; ${attributes}; Max-Age=${SESSION_TTL_MS / 1000}`;
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location }).end();
}
