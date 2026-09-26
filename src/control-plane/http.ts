import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { resolve } from "node:path";
import { z } from "zod";
import { OWNER_SESSION_COOKIE, OwnerAuth } from "./owner-auth.js";
import { ArchivedChannelError, OwnerChat } from "./owner-chat.js";
import { LoginGate } from "./login-gate.js";
import { NodeDirectory, type NodeDirectoryOptions } from "./nodes/directory.js";
import { registerNodeRoutes } from "./nodes/http.js";
import { AgentDirectory, AgentRequestConflict } from "./agents/directory.js";
import type { AgentSummary } from "./agents/contracts.js";
import {
  newAgentRequestSchema,
  agentProfilePatchSchema,
  agentModelPatchSchema,
} from "./agents/contracts.js";
import { ModelCredentialDirectory } from "./model-credentials.js";
import { isSupportedModelProvider, supportedModelProviders } from "./model-providers.js";
import { AgentRunCoordinator } from "./agent-runs.js";
import { AttachmentError, AttachmentService } from "./attachments.js";
import { WorkspaceError, WorkspaceService, type WorkspaceVersion } from "./workspace.js";
import { registerWorkspaceRoutes } from "./workspace-http.js";
import { listAgentActivity } from "./activity.js";

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
const newMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(20_000),
    rootId: z.string().uuid().optional(),
    quoteId: z.string().uuid().optional(),
    asTask: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !(value.rootId && value.quoteId));
const ownerChannelInvitationSchema = z.object({ agentId: z.string().uuid() }).strict();
const modelCredentialInputSchema = z
  .object({
    apiKey: z
      .string()
      .min(1)
      .max(8192)
      .refine((value) => value.trim().length > 0),
  })
  .strict();

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

export class ControlPlaneApp extends Hono {
  runs?: AgentRunCoordinator;
  constructor(
    private readonly ownerAuth: OwnerAuth,
    readonly nodes: NodeDirectory,
    readonly agents: AgentDirectory,
    readonly chat: OwnerChat,
    readonly workspace: WorkspaceService,
    readonly attachments: AttachmentService,
  ) {
    super();
  }

  close(): void {
    this.runs?.close();
    this.workspace.close();
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
      ...(options.nodeOperationTimeoutMs !== undefined
        ? { operationTimeoutMs: options.nodeOperationTimeoutMs }
        : {}),
    },
    nodes = new NodeDirectory(ownerAuth.db, nodeOptions),
    agents = new AgentDirectory(ownerAuth.db, options.now),
    modelCredentials = new ModelCredentialDirectory(ownerAuth.db, options.now),
    ownerChat = new OwnerChat(ownerAuth.db, options.now),
    workspace = new WorkspaceService(ownerAuth.db, nodes, ownerChat),
    attachments = new AttachmentService(
      ownerAuth.db,
      workspace,
      resolve(dataDir, "attachments"),
      options.maxAttachmentBytes,
      options.now,
    ),
    app = new ControlPlaneApp(ownerAuth, nodes, agents, ownerChat, workspace, attachments),
    loginGate = new LoginGate();
  ownerChat.setExternalAgentToolHandler(async (request) => {
    const input = request.input;
    try {
      switch (request.name) {
        case "workspace.list": {
          const args = input as { path: string; offset: number; limit: number };
          return {
            ok: true,
            result: await workspace.readForAgent(request.runId, request.agentId, {
              kind: "workspace_list",
              ...args,
            }),
          };
        }
        case "workspace.stat":
          return {
            ok: true,
            result: await workspace.readForAgent(request.runId, request.agentId, {
              kind: "workspace_stat",
              path: input.path as string,
            }),
          };
        case "workspace.read":
          return {
            ok: true,
            result: await workspace.readForAgent(request.runId, request.agentId, {
              kind: "read",
              path: input.path as string,
            }),
          };
        case "workspace.read_chunk":
          return {
            ok: true,
            result: await workspace.readForAgent(request.runId, request.agentId, {
              kind: "workspace_read_chunk",
              path: input.path as string,
              offset: input.offset as number,
              length: input.length as number,
              ...(input.version === undefined
                ? {}
                : { version: input.version as WorkspaceVersion }),
            }),
          };
        case "workspace.write":
          return {
            ok: true,
            result: await workspace.agentAction({
              ...request,
              operationName: request.name,
              toolInput: input,
              operation: {
                kind: "write",
                path: input.path as string,
                content: input.content as string,
              },
            }),
          };
        case "workspace.write_bytes":
          return {
            ok: true,
            result: await workspace.agentAction({
              ...request,
              operationName: request.name,
              toolInput: input,
              operation: {
                kind: "write_bytes",
                path: input.path as string,
                base64: input.base64 as string,
              },
            }),
          };
        case "workspace.edit":
          return {
            ok: true,
            result: await workspace.agentAction({
              ...request,
              operationName: request.name,
              toolInput: input,
              operation: {
                kind: "edit",
                path: input.path as string,
                expectedHash: input.expectedHash as string,
                oldText: input.oldText as string,
                newText: input.newText as string,
              },
            }),
          };
        case "workspace.mkdir":
          return {
            ok: true,
            result: await workspace.agentAction({
              ...request,
              operationName: request.name,
              toolInput: input,
              operation: { kind: "mkdir", path: input.path as string },
            }),
          };
        case "workspace.move":
          return {
            ok: true,
            result: await workspace.agentAction({
              ...request,
              operationName: request.name,
              toolInput: input,
              operation: {
                kind: "move",
                path: input.path as string,
                destination: input.destination as string,
              },
            }),
          };
        case "workspace.remove":
          return {
            ok: true,
            result: await workspace.agentAction({
              ...request,
              operationName: request.name,
              toolInput: input,
              operation: {
                kind: "remove",
                path: input.path as string,
                ...(input.expectedHash === undefined
                  ? {}
                  : { expectedHash: input.expectedHash as string }),
              },
            }),
          };
        case "attachments.list":
          return {
            ok: true,
            result: {
              attachments: attachments.listForAgent(
                request.runId,
                request.agentId,
                input.conversationId as string,
              ),
            },
          };
        case "attachments.read_chunk":
          return {
            ok: true,
            result: attachments.readChunkForAgent({
              runId: request.runId,
              agentId: request.agentId,
              channelId: input.conversationId as string,
              attachmentId: input.attachmentId as string,
              offset: input.offset as number,
              length: input.length as number,
            }),
          };
        case "attachments.publish":
          return {
            ok: true,
            result: await attachments.publishNodeFile({
              runId: request.runId,
              agentId: request.agentId,
              actionId: request.actionId,
              operationName: request.name,
              toolInput: input,
              channelId: input.conversationId as string,
              path: input.path as string,
              ...(input.filename === undefined ? {} : { filename: input.filename as string }),
            }),
          };
        default:
          return { ok: false, error: "Unknown file operation" };
      }
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof WorkspaceError || error instanceof AttachmentError
            ? error.message
            : "Agent 文件请求被拒绝。",
      };
    }
  });
  app.runs = new AgentRunCoordinator(ownerAuth.db, nodes, modelCredentials, ownerChat, options.now);
  const activeAgentProvisions = new Map<string, Promise<AgentSummary>>();
  const agentProvisionResponse = (
    context: Context,
    agent: AgentSummary,
    successStatus: 200 | 201,
  ) => {
    if (agent.status === "failed")
      return context.json(
        { error: agent.error ?? "Agent 创建失败，请按同一请求重试。", agent },
        502,
      );
    return context.json({ agent }, successStatus);
  };

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
  app.get("/api/owner/agents", (context) => {
    context.header("Cache-Control", "no-store");
    return context.json({
      agents: agents.list().map((agent) => ({
        ...agent,
        pausedReason: app.runs?.pauseReason(agent.id) ?? null,
        stop: app.runs?.pauseReason(agent.id) === "manual" ? app.runs.stopStatus(agent.id) : null,
      })),
    });
  });
  app.patch("/api/owner/agents/:agentId/profile", async (context) => {
    const input = agentProfilePatchSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "Agent 资料格式无效。" }, 400);
    const agent = agents.updateProfile(context.req.param("agentId"), input.data);
    return agent ? context.json({ agent }) : context.json({ error: "Agent 不存在。" }, 404);
  });
  app.put("/api/owner/agents/:agentId/model", async (context) => {
    const input = agentModelPatchSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "模型配置无效。" }, 400);
    const id = context.req.param("agentId");
    const current = agents.get(id);
    if (!current) return context.json({ error: "Agent 不存在。" }, 404);
    if (!current.linuxIdentity)
      return context.json({ error: "请等待 Agent 的 Linux 身份创建完成。" }, 409);
    if (!modelCredentials.has(input.data.provider))
      return context.json({ error: "请先配置目标模型服务的 API key。" }, 409);
    const agent = agents.updateModel(id, input.data)!;
    app.runs?.modelChanged(id);
    context.header("Cache-Control", "no-store");
    return context.json({ agent });
  });
  app.get("/api/owner/agents/:agentId/activity", (context) => {
    const beforeText = context.req.query("before"),
      limitText = context.req.query("limit");
    const before = beforeText === undefined ? null : Number(beforeText);
    const limit = limitText === undefined ? 50 : Number(limitText);
    if (
      (beforeText !== undefined &&
        (!/^[1-9]\d*$/.test(beforeText) || !Number.isSafeInteger(before))) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (context.req.query("detail") !== undefined && context.req.query("detail") !== "1")
    )
      return context.json({ error: "动态查询参数无效。" }, 400);
    const agentId = context.req.param("agentId");
    const events = listAgentActivity(
      ownerAuth.db,
      agentId,
      before,
      limit,
      context.req.query("detail") === "1",
    );
    if (!events) return context.json({ error: "Agent 不存在。" }, 404);
    const agent = agents.get(agentId)!;
    const online = nodes.list().some((node) => node.id === agent.nodeId && node.online);
    context.header("Cache-Control", "no-store");
    return context.json({
      events,
      nodeOnline: online,
      pausedReason: app.runs?.pauseReason(agentId) ?? null,
      stop: app.runs?.pauseReason(agentId) === "manual" ? app.runs.stopStatus(agentId) : null,
      nextBefore: events.length === limit ? events.at(-1)!.sequence : null,
    });
  });
  app.post("/api/owner/agents/:agentId/pause", (context) => {
    if (!app.runs?.pauseAgent(context.req.param("agentId")))
      return context.json({ error: "Agent 不存在。" }, 404);
    return context.json({
      pausedReason: "manual",
      stop: app.runs.stopStatus(context.req.param("agentId")),
    });
  });
  app.post("/api/owner/agents/:agentId/resume", async (context) => {
    const result = await app.runs?.resumeAgent(context.req.param("agentId"));
    if (!result?.ok) return context.json({ error: result?.error ?? "Agent 暂不可复启。" }, 409);
    return context.json({ pausedReason: null });
  });
  app.get("/api/owner/model-providers", (context) => {
    context.header("Cache-Control", "no-store");
    return context.json({ providers: supportedModelProviders });
  });
  app.get("/api/owner/model-credentials", (context) => {
    context.header("Cache-Control", "no-store");
    return context.json({ credentials: modelCredentials.list() });
  });
  app.put("/api/owner/model-credentials/:provider", async (context) => {
    const provider = context.req.param("provider");
    if (!isSupportedModelProvider(provider))
      return context.json({ error: "模型服务不受支持。" }, 400);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "模型凭据格式无效。" }, 400);
    }
    const input = modelCredentialInputSchema.safeParse(body);
    if (!input.success) return context.json({ error: "模型凭据格式无效。" }, 400);
    try {
      const changed = ownerAuth.db
        .transaction(() => {
          const updated = modelCredentials.put(provider, input.data.apiKey);
          agents.setProviderReady(provider, true);
          return updated;
        })
        .immediate();
      if (changed) app.runs?.credentialsChanged(provider, true);
      app.runs?.wake();
    } catch {
      return context.json({ error: "无法保存模型凭据，请检查控制面存储后重试。" }, 503);
    }
    context.header("Cache-Control", "no-store");
    return context.body(null, 204);
  });
  app.delete("/api/owner/model-credentials/:provider", (context) => {
    const provider = context.req.param("provider");
    if (!isSupportedModelProvider(provider))
      return context.json({ error: "模型服务不受支持。" }, 400);
    try {
      const removed = ownerAuth.db
        .transaction(() => {
          const deleted = modelCredentials.delete(provider);
          agents.setProviderReady(provider, false);
          return deleted;
        })
        .immediate();
      if (removed) app.runs?.credentialsChanged(provider, false);
      app.runs?.wake();
    } catch {
      return context.json({ error: "无法删除模型凭据，请检查控制面存储后重试。" }, 503);
    }
    context.header("Cache-Control", "no-store");
    return context.body(null, 204);
  });
  app.post("/api/owner/agents", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "Agent 资料格式无效" }, 400);
    }
    if (!newAgentRequestSchema.safeParse(body).success)
      return context.json({ error: "Agent 资料格式无效" }, 400);
    const input = newAgentRequestSchema.parse(body);
    try {
      agents.assertSameRequest(input);
    } catch (error) {
      if (error instanceof AgentRequestConflict) return context.json({ error: error.message }, 409);
      return context.json({ error: "无法读取已有 Agent 资料。" }, 500);
    }
    const active = activeAgentProvisions.get(input.id);
    if (active) {
      const agent = await active;
      return agentProvisionResponse(context, agent, 200);
    }
    const existing = agents.get(input.id);
    if (existing?.status === "waiting_credentials" || existing?.status === "ready")
      return context.json({ agent: existing });
    if (!nodes.list().some((node) => node.id === input.nodeId && node.online))
      return context.json({ error: "所选节点当前离线，Agent 资料尚未提交。" }, 409);
    let prepared;
    try {
      prepared = agents.prepare(input);
    } catch (error) {
      if (error instanceof AgentRequestConflict) return context.json({ error: error.message }, 409);
      return context.json({ error: "无法保存 Agent 创建请求，请稍后重试。" }, 503);
    }
    if (!prepared.shouldProvision) return context.json({ agent: prepared.agent });

    const task = (async (): Promise<AgentSummary> => {
      try {
        const result = await nodes.provisionAgent(
          input.nodeId,
          prepared.requestId,
          input.id,
          (stage) => agents.updateStage(input.id, stage),
        );
        if (!result.ok) return agents.fail(input.id, result.message) ?? prepared.agent;
        return agents.complete(
          input.id,
          result.identity,
          ownerChat,
          modelCredentials.has(input.model.provider),
        );
      } catch (error) {
        const message =
          error instanceof AgentRequestConflict
            ? error.message
            : "Linux 节点暂时无法确认 Agent 账号与私人 home，请检查节点后按原请求重试。";
        return agents.fail(input.id, message) ?? prepared.agent;
      }
    })();
    activeAgentProvisions.set(input.id, task);
    try {
      const agent = await task;
      return agentProvisionResponse(context, agent, prepared.created ? 201 : 200);
    } finally {
      if (activeAgentProvisions.get(input.id) === task) activeAgentProvisions.delete(input.id);
    }
  });
  app.post("/api/owner/agents/:agentId/direct-channel", (context) => {
    const channel = ownerChat.getOrCreateAgentDirectChannel(context.req.param("agentId"));
    if (!channel) return context.json({ error: "Agent 私信暂不可用。" }, 404);
    context.header("Cache-Control", "no-store");
    return context.json({ channel });
  });
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
        // Keep one cancellable, delayed poll per open stream; an empty pull must not strand it.
        while (!closed) {
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
            continue;
          }
          for (const event of page.events) {
            controller.enqueue(
              encoder.encode(
                `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
            cursor = event.seq;
          }
          return;
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
  app.get("/api/owner/invitable-channels", (context) =>
    context.json({ channels: ownerChat.listInvitableChannels() }),
  );
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
  app.post("/api/owner/channels/:channelId/invitations", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "邀请资料格式无效" }, 400);
    }
    const input = ownerChannelInvitationSchema.safeParse(body);
    if (!input.success) return context.json({ error: "邀请资料格式无效" }, 400);
    const channelId = context.req.param("channelId");
    if (!ownerChat.inviteAgentToChannel(channelId, input.data.agentId))
      return context.json({ error: "频道或 Agent 暂不可邀请" }, 409);
    app.runs?.wake();
    return context.json({ channelId, agentId: input.data.agentId, status: "joined" }, 201);
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
  app.get("/api/owner/channels/:channelId/threads/:rootId", (context) => {
    const thread = ownerChat.listThread(
      context.req.param("channelId"),
      context.req.param("rootId"),
    );
    if (!thread) return context.json({ error: "讨论串不存在" }, 404);
    return context.json(thread);
  });
  app.get("/api/owner/tasks", (context) => context.json({ tasks: ownerChat.listTasks() }));
  app.get("/api/owner/agents/:agentId/reminders", (context) => {
    const agent = agents.list().find((item) => item.id === context.req.param("agentId"));
    if (!agent) return context.json({ error: "Agent 不存在" }, 404);
    ownerChat.syncHandledReminders();
    return context.json({ reminders: ownerChat.listAgentReminders(agent.id) });
  });
  app.get("/api/owner/tasks/:taskId/activity", (context) => {
    const task = ownerChat.readTask(context.req.param("taskId"));
    if (!task) return context.json({ error: "任务不存在" }, 404);
    return context.json({ task, events: ownerChat.taskActivity(task.id) });
  });
  app.post("/api/owner/tasks", async (context) => {
    const parsed = z
      .object({ messageId: z.string().uuid() })
      .strict()
      .safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "消息 ID 无效" }, 400);
    try {
      return context.json(
        ownerChat.createTaskForMessage(parsed.data.messageId, "human", "owner"),
        201,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE"))
        return context.json({ error: "这条消息已有任务" }, 409);
      if (error instanceof Error && error.message === "Message is not available")
        return context.json({ error: "消息不存在" }, 404);
      throw error;
    }
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
      const message = ownerChat.createMessage(
        context.req.param("channelId"),
        input.data.text,
        input.data,
      );
      if (!message) return context.json({ error: "频道不存在" }, 404);
      app.runs?.wake();
      return context.json(message, 201);
    } catch (error) {
      if (error instanceof ArchivedChannelError)
        return context.json({ error: "频道已归档，不能发送消息" }, 409);
      if (error instanceof Error && error.message.startsWith("Reply target"))
        return context.json({ error: "回复目标无效" }, 400);
      throw error;
    }
  });
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
