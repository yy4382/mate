import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { resolve } from "node:path";
import { z } from "zod";
import { OWNER_SESSION_COOKIE, OwnerAuth } from "./owner-auth.js";
import { ArchivedChannelError, OwnerChat } from "./owner-chat.js";
import { LoginGate } from "./login-gate.js";
import { NodeDirectory, type NodeDirectoryOptions } from "./nodes/directory.js";
import { registerNodeRoutes } from "./nodes/http.js";

const newChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500),
    visibility: z.enum(["public", "private"]),
  })
  .strict();
const updateChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    visibility: z.enum(["public", "private"]).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const newMessageSchema = z.object({ text: z.string().trim().min(1).max(20_000) }).strict();

export interface ControlPlaneAppOptions {
  webRoot?: string;
  dataDir?: string;
  passwordFile?: string;
  now?: () => number;
  sessionTtlMs?: number;
  pairingTokenTtlMs?: number;
  maxNodeConnections?: number;
  maxUnauthenticatedNodeConnections?: number;
  nodeHandshakeTimeoutMs?: number;
  nodeHeartbeatTimeoutMs?: number;
}

export class ControlPlaneApp extends Hono {
  constructor(
    private readonly ownerAuth: OwnerAuth,
    readonly nodes: NodeDirectory,
  ) {
    super();
  }

  close(): void {
    this.nodes.closeAll();
    this.ownerAuth.close();
  }
}

/** The public status contract deliberately contains no deployment or Agent details. */
export function createControlPlaneApp(options: ControlPlaneAppOptions = {}): ControlPlaneApp {
  const dataDir =
      options.dataDir ??
      process.env.MATE_CONTROL_PLANE_DATA_DIR ??
      resolve(process.cwd(), "data", "control-plane"),
    passwordFile = options.passwordFile ?? process.env.MATE_OWNER_PASSWORD_FILE,
    ownerAuth = new OwnerAuth({
      dataDir,
      ...(passwordFile !== undefined ? { passwordFile } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.sessionTtlMs !== undefined ? { sessionTtlMs: options.sessionTtlMs } : {}),
    }),
    nodeOptions: NodeDirectoryOptions = {
      ...(options.now ? { now: options.now } : {}),
      ...(options.pairingTokenTtlMs !== undefined
        ? { pairingTokenTtlMs: options.pairingTokenTtlMs }
        : {}),
      ...(options.maxNodeConnections !== undefined
        ? { maxConnections: options.maxNodeConnections }
        : {}),
      ...(options.maxUnauthenticatedNodeConnections !== undefined
        ? { maxUnauthenticatedConnections: options.maxUnauthenticatedNodeConnections }
        : {}),
      ...(options.nodeHandshakeTimeoutMs !== undefined
        ? { handshakeTimeoutMs: options.nodeHandshakeTimeoutMs }
        : {}),
      ...(options.nodeHeartbeatTimeoutMs !== undefined
        ? { heartbeatTimeoutMs: options.nodeHeartbeatTimeoutMs }
        : {}),
    },
    nodes = new NodeDirectory(ownerAuth.db, nodeOptions),
    app = new ControlPlaneApp(ownerAuth, nodes),
    ownerChat = new OwnerChat(ownerAuth.db, options.now),
    loginGate = new LoginGate();

  const requireOwnerApi: MiddlewareHandler = async (context, next) => {
    const token = sessionToken(context);
    if (!token || !ownerAuth.hasSession(token))
      return context.json({ error: "请先登录", loginUrl: "/login" }, 401);
    await next();
  };
  const requireOwnerPage: MiddlewareHandler = async (context, next) => {
    const token = sessionToken(context);
    if (!token || !ownerAuth.hasSession(token)) return context.redirect("/login", 302);
    await next();
  };

  app.get("/api/status", (context) => context.json({ status: "running" as const }));

  app.post("/api/auth/login", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "请输入密码" }, 400);
    }
    const password =
      typeof body === "object" && body !== null && "password" in body
        ? (body as { password?: unknown }).password
        : undefined;
    if (typeof password !== "string" || !password || Buffer.byteLength(password, "utf8") > 1024)
      return context.json({ error: "请输入密码" }, 400);

    let result: "unconfigured" | "valid" | "invalid";
    try {
      const outcome = await loginGate.run(() => ownerAuth.verifyPassword(password));
      if (outcome.kind === "limited") {
        context.header("Retry-After", String(outcome.retryAfterSeconds));
        const error = `已有登录请求正在验证，请在 ${outcome.retryAfterSeconds} 秒后重试。`;
        return context.json({ error, retryAfterSeconds: outcome.retryAfterSeconds }, 429);
      }
      result = outcome.result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown failure";
      process.stderr.write(`Owner password initialization failed: ${detail}\n`);
      return context.json(
        { error: "所有者密码文件不可用，请检查 MATE_OWNER_PASSWORD_FILE 和文件权限。" },
        503,
      );
    }
    if (result === "unconfigured")
      return context.json(
        { error: "尚未配置所有者密码，请部署者设置 MATE_OWNER_PASSWORD_FILE。" },
        503,
      );
    if (result === "invalid") return context.json({ error: "密码错误" }, 401);

    const session = ownerAuth.createSession();
    context.header("Set-Cookie", makeSessionCookie(session.token, session.maxAgeSeconds));
    return context.body(null, 204);
  });

  app.post("/api/auth/logout", (context) => {
    const token = sessionToken(context);
    if (token) ownerAuth.revokeSession(token);
    context.header("Set-Cookie", clearSessionCookie());
    return context.body(null, 204);
  });

  app.use("/api/owner/*", requireOwnerApi);
  app.get("/api/owner/session", (context) => context.json({ authenticated: true }));
  app.get("/api/owner/snapshot", (context) => context.json(ownerChat.snapshot()));
  app.get("/api/owner/events", (context) => {
    const streamToken = sessionToken(context);
    const suppliedCursor =
      context.req.header("last-event-id") ?? context.req.query("cursor") ?? "0";
    if (!/^(0|[1-9]\d*)$/.test(suppliedCursor)) return context.json({ error: "事件游标无效" }, 400);
    const initialCursor = Number(suppliedCursor);
    if (!Number.isSafeInteger(initialCursor)) return context.json({ error: "事件游标无效" }, 400);

    let cursor = initialCursor,
      closed = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (closed) return;
        if (!streamToken || !ownerAuth.hasSession(streamToken)) {
          controller.enqueue(
            encoder.encode('event: auth_required\ndata: {"loginUrl":"/login"}\n\n'),
          );
          closed = true;
          controller.close();
          return;
        }
        const page = ownerChat.eventsAfter(cursor);
        if (page.stale) {
          controller.enqueue(
            encoder.encode(
              `event: snapshot_required\ndata: ${JSON.stringify({ reason: "cursor_too_old", snapshotUrl: "/api/owner/snapshot" })}\n\n`,
            ),
          );
          closed = true;
          controller.close();
          return;
        }
        if (!page.events.length) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
          return;
        }
        for (const event of page.events) {
          controller.enqueue(
            encoder.encode(
              `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
          cursor = event.seq;
        }
      },
      cancel() {
        closed = true;
      },
    });
    return context.newResponse(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  });
  app.get("/api/owner/channels", (context) => context.json({ channels: ownerChat.listChannels() }));
  app.post("/api/owner/channels", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "频道资料格式无效" }, 400);
    }
    const input = newChannelSchema.safeParse(body);
    if (!input.success) return context.json({ error: "频道资料格式无效" }, 400);
    return context.json(ownerChat.createChannel(input.data), 201);
  });
  app.patch("/api/owner/channels/:channelId", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "频道资料格式无效" }, 400);
    }
    const input = updateChannelSchema.safeParse(body);
    if (!input.success) return context.json({ error: "频道资料格式无效" }, 400);
    const channel = ownerChat.updateChannel(context.req.param("channelId"), input.data);
    if (!channel) return context.json({ error: "频道不存在" }, 404);
    return context.json(channel);
  });
  app.get("/api/owner/channels/:channelId/messages", (context) => {
    const beforeText = context.req.query("before"),
      before = beforeText === undefined ? undefined : Number(beforeText),
      validBefore =
        beforeText === undefined || (/^[1-9]\d*$/.test(beforeText) && Number.isSafeInteger(before)),
      limitText = context.req.query("limit"),
      limit = limitText === undefined ? 50 : Number(limitText);
    if (!validBefore || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return context.json({ error: "历史游标或条数无效" }, 400);
    const page = ownerChat.listMessages(context.req.param("channelId"), before, limit);
    if (!page) return context.json({ error: "频道不存在" }, 404);
    return context.json(page);
  });
  app.post("/api/owner/channels/:channelId/messages", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "消息内容无效" }, 400);
    }
    const input = newMessageSchema.safeParse(body);
    if (!input.success) return context.json({ error: "消息内容无效" }, 400);
    try {
      const message = ownerChat.createMessage(context.req.param("channelId"), input.data.text);
      if (!message) return context.json({ error: "频道不存在" }, 404);
      return context.json(message, 201);
    } catch (error) {
      if (error instanceof ArchivedChannelError)
        return context.json({ error: "频道已归档，不能发送消息" }, 409);
      throw error;
    }
  });
  registerNodeRoutes(app, nodes);

  app.use("/app", requireOwnerPage);
  app.use("/app/*", requireOwnerPage);

  const webRoot = options.webRoot;
  if (webRoot) {
    const index = serveStatic({ root: webRoot, path: "index.html" });
    app.get("/", index);
    app.get("/login", index);
    app.get("/login/*", index);
    app.get("/app", index);
    app.get("/app/*", index);
    app.get("/assets/*", serveStatic({ root: webRoot }));
  }

  return app;
}

function sessionToken(context: Context): string | undefined {
  const header = context.req.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== OWNER_SESSION_COOKIE) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

function makeSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${OWNER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie(): string {
  return `${OWNER_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
