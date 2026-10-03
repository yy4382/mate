import { registerConversationRoutes } from "./conversations/http.js";
import type { AgentLoopTestDependencies } from "./runtime/loop.js";
import { AgentTools } from "./runtime/tools/registry.js";
import { AgentProcessOperationBroker } from "./runtime/process-operations.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type MiddlewareHandler } from "hono";
import { resolve } from "node:path";
import { z } from "zod";
import { OwnerAuth } from "./auth/service.js";
import { OwnerChat } from "./conversations/service.js";
import { sessionToken, makeSessionCookie, clearSessionCookie } from "./auth/session-cookie.js";
import { LoginGate } from "./auth/login-gate.js";
import { NodeDirectory, type NodeDirectoryOptions } from "./nodes/directory.js";
import { registerNodeRoutes } from "./nodes/http.js";
import { AgentDirectory } from "./agents/directory.js";
import { registerAgentRoutes } from "./agents/http.js";
import { ModelCredentialDirectory } from "./providers/credentials.js";
import { AgentRunCoordinator } from "./runtime/runs.js";
import { AttachmentService } from "./attachments/service.js";
import { WorkspaceService } from "./workspaces/service.js";
import { registerWorkspaceRoutes } from "./workspaces/http.js";
import { OwnerPush } from "./notifications/push.js";

export function mentionsOwner(text: string): boolean {
  return /(?:^|[^\p{L}\p{N}_])@(?:owner|所有者)(?=$|[^\p{L}\p{N}_])/iu.test(text);
}

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
  nodeOperationTimeoutMs?: number;
  maxAttachmentBytes?: number;
}

/** Fault pauses used by real-service integration tests, never deployment configuration. */
export interface ControlPlaneTestDependencies extends AgentLoopTestDependencies {
  beforeAgentAttachmentCommit?: () => Promise<void>;
}

export class ControlPlaneApp extends Hono {
  constructor(
    private readonly ownerAuth: OwnerAuth,
    readonly nodes: NodeDirectory,
    readonly agents: AgentDirectory,
    readonly chat: OwnerChat,
    readonly workspace: WorkspaceService,
    readonly attachments: AttachmentService,
    readonly tools: AgentTools,
    readonly push: OwnerPush,
    readonly runs: AgentRunCoordinator,
  ) {
    super();
  }

  close(): void {
    this.runs.close();
    this.workspace.close();
    this.nodes.closeAll();
    this.push.close();
    this.ownerAuth.close();
  }
}

/** The public status contract deliberately contains no deployment or Agent details. */
export function createControlPlaneApp(
  options: ControlPlaneAppOptions = {},
  testDependencies: ControlPlaneTestDependencies = {},
): ControlPlaneApp {
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
      ...(options.nodeOperationTimeoutMs !== undefined
        ? { operationTimeoutMs: options.nodeOperationTimeoutMs }
        : {}),
    },
    nodes = new NodeDirectory(ownerAuth.db, nodeOptions),
    agents = new AgentDirectory(ownerAuth.db, options.now ?? Date.now, nodes),
    modelCredentials = new ModelCredentialDirectory(ownerAuth.db, options.now),
    ownerChat = new OwnerChat(ownerAuth.db, options.now),
    push = new OwnerPush(ownerAuth.db),
    workspace = new WorkspaceService(ownerAuth.db, nodes, ownerChat),
    attachments = new AttachmentService(
      ownerAuth.db,
      workspace,
      resolve(dataDir, "attachments"),
      options.maxAttachmentBytes,
      options.now,
      testDependencies.beforeAgentAttachmentCommit,
    ),
    processes = new AgentProcessOperationBroker(ownerAuth.db, nodes, options.now),
    tools = new AgentTools(ownerAuth.db, ownerChat, workspace, attachments, processes),
    runs = new AgentRunCoordinator(
      ownerAuth.db,
      nodes,
      modelCredentials,
      ownerChat,
      tools,
      processes,
      options.now,
      testDependencies,
    ),
    app = new ControlPlaneApp(
      ownerAuth,
      nodes,
      agents,
      ownerChat,
      workspace,
      attachments,
      tools,
      push,
      runs,
    ),
    loginGate = new LoginGate();
  ownerChat.setPushHandler((message, directToOwner) => {
    if (!directToOwner && !mentionsOwner(message.text)) return;
    push.queue(
      `message:${message.id}`,
      "Agent 发来消息",
      `/app?channel=${encodeURIComponent(message.channelId)}&message=${encodeURIComponent(message.id)}`,
    );
  });
  runs.start();
  const requireOwnerApi: MiddlewareHandler = async (context, next) => {
    const token = sessionToken(context);
    if (!token || !ownerAuth.hasSession(token))
      return context.json({ error: "请先登录", loginUrl: "/login" }, 401);
    await next();
  };
  const requireOwnerPage: MiddlewareHandler = async (context, next) => {
    const token = sessionToken(context);
    if (!token || !ownerAuth.hasSession(token)) {
      const requestUrl = new URL(context.req.url);
      const nextPath = `${requestUrl.pathname}${requestUrl.search}`;
      return context.redirect(
        nextPath === "/app" ? "/login" : `/login?next=${encodeURIComponent(nextPath)}`,
        302,
      );
    }
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
      typeof body === "object" && body !== null && "password" in body ? body.password : undefined;
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
  app.get("/api/owner/push/public-key", (context) => context.json({ publicKey: push.publicKey }));
  app.post("/api/owner/push/subscriptions", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const input = z
      .object({ endpoint: z.string(), keys: z.object({ p256dh: z.string(), auth: z.string() }) })
      .safeParse(body);
    if (!input.success) return context.json({ error: "推送订阅无效" }, 400);
    try {
      push.subscribe(input.data);
    } catch {
      return context.json({ error: "推送订阅无效" }, 400);
    }
    return context.json({ subscribed: true }, 201);
  });
  app.delete("/api/owner/push/subscriptions", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const endpoint = z.object({ endpoint: z.string().max(4096) }).safeParse(body);
    if (!endpoint.success) return context.json({ error: "推送订阅无效" }, 400);
    push.unsubscribe(endpoint.data.endpoint);
    return context.json({ subscribed: false });
  });
  registerAgentRoutes(app, { db: ownerAuth.db, agents, nodes, ownerChat, modelCredentials, runs });
  registerConversationRoutes(app, { ownerAuth, ownerChat, agents, runs });
  registerWorkspaceRoutes(app, workspace, attachments, (context) => sessionToken(context) ?? "");
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
    app.get("/manifest.webmanifest", serveStatic({ root: webRoot }));
    app.get("/sw.js", serveStatic({ root: webRoot }));
    app.get("/icon.svg", serveStatic({ root: webRoot }));
    app.get("/icon-192.png", serveStatic({ root: webRoot }));
    app.get("/icon-512.png", serveStatic({ root: webRoot }));
  }

  return app;
}
