import type Database from "better-sqlite3";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { AgentDirectory, AgentRequestConflict } from "./directory.js";
import {
  newAgentRequestSchema,
  agentProfilePatchSchema,
  agentModelPatchSchema,
  type AgentSummary,
} from "./contracts.js";
import type { OwnerChat } from "../conversations/service.js";
import type { NodeDirectory } from "../nodes/directory.js";
import type { ModelCredentialDirectory } from "../providers/credentials.js";
import { isSupportedModelProvider, supportedModelProviders } from "../providers/catalog.js";
import type { AgentRunCoordinator } from "../runtime/runs/coordinator.js";
import { listAgentActivity } from "../runtime/activity.js";
import { agentUsage } from "../runtime/usage.js";

const modelCredentialInputSchema = z
  .object({
    apiKey: z
      .string()
      .min(1)
      .max(8192)
      .refine((value) => value.trim().length > 0),
  })
  .strict();

export function createAgentRoutes({
  db,
  agents,
  nodes,
  ownerChat,
  modelCredentials,
  runs,
}: {
  db: Database.Database;
  agents: AgentDirectory;
  nodes: NodeDirectory;
  ownerChat: OwnerChat;
  modelCredentials: ModelCredentialDirectory;
  runs: AgentRunCoordinator;
}) {
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

  return new Hono()
    .get("/api/owner/agents", (context) => {
      context.header("Cache-Control", "no-store");
      return context.json({
        agents: agents.list().map((agent) => ({
          ...agent,
          pausedReason: runs.pauseReason(agent.id) ?? null,
          stop: runs.pauseReason(agent.id) === "manual" ? runs.stopStatus(agent.id) : null,
        })),
      });
    })
    .get("/api/owner/agents/:agentId/usage", (context) => {
      const agentId = context.req.param("agentId");
      if (!agents.get(agentId)) return context.json({ error: "Agent 不存在。" }, 404);
      context.header("Cache-Control", "no-store");
      return context.json(agentUsage(db, agentId));
    })
    .patch("/api/owner/agents/:agentId/profile", async (context) => {
      const input = agentProfilePatchSchema.safeParse(await context.req.json().catch(() => null));
      if (!input.success) return context.json({ error: "Agent 资料格式无效。" }, 400);
      const agent = agents.updateProfile(context.req.param("agentId"), input.data);
      return agent ? context.json({ agent }) : context.json({ error: "Agent 不存在。" }, 404);
    })
    .put("/api/owner/agents/:agentId/model", async (context) => {
      const input = agentModelPatchSchema.safeParse(await context.req.json().catch(() => null));
      if (!input.success) return context.json({ error: "模型配置无效。" }, 400);
      const id = context.req.param("agentId");
      const current = agents.get(id);
      if (!current) return context.json({ error: "Agent 不存在。" }, 404);
      if (!current.linuxIdentity)
        return context.json({ error: "请等待 Agent 的默认工作区准备完成。" }, 409);
      if (!modelCredentials.has(input.data.provider))
        return context.json({ error: "请先配置目标模型服务的 API key。" }, 409);
      const agent = agents.updateModel(id, input.data)!;
      runs.modelChanged(id);
      context.header("Cache-Control", "no-store");
      return context.json({ agent });
    })
    .get("/api/owner/agents/:agentId/activity", (context) => {
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
        db,
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
        pausedReason: runs.pauseReason(agentId) ?? null,
        stop: runs.pauseReason(agentId) === "manual" ? runs.stopStatus(agentId) : null,
        nextBefore: events.length === limit ? events.at(-1)!.sequence : null,
      });
    })
    .post("/api/owner/agents/:agentId/pause", (context) => {
      if (!runs.pauseAgent(context.req.param("agentId")))
        return context.json({ error: "Agent 不存在。" }, 404);
      return context.json({
        pausedReason: "manual",
        stop: runs.stopStatus(context.req.param("agentId")),
      });
    })
    .post("/api/owner/agents/:agentId/resume", async (context) => {
      const result = await runs.resumeAgent(context.req.param("agentId"));
      if (!result?.ok) return context.json({ error: result?.error ?? "Agent 暂不可复启。" }, 409);
      return context.json({ pausedReason: null });
    })
    .get("/api/owner/model-providers", (context) => {
      context.header("Cache-Control", "no-store");
      return context.json({ providers: supportedModelProviders });
    })
    .get("/api/owner/model-credentials", (context) => {
      context.header("Cache-Control", "no-store");
      return context.json({ credentials: modelCredentials.list() });
    })
    .put("/api/owner/model-credentials/:provider", async (context) => {
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
        const changed = db
          .transaction(() => modelCredentials.put(provider, input.data.apiKey))
          .immediate();
        if (changed) runs.credentialsChanged(provider, true);
        runs.wake();
      } catch {
        return context.json({ error: "无法保存模型凭据，请检查控制面存储后重试。" }, 503);
      }
      context.header("Cache-Control", "no-store");
      return context.body(null, 204);
    })
    .delete("/api/owner/model-credentials/:provider", (context) => {
      const provider = context.req.param("provider");
      if (!isSupportedModelProvider(provider))
        return context.json({ error: "模型服务不受支持。" }, 400);
      try {
        const removed = db.transaction(() => modelCredentials.delete(provider)).immediate();
        if (removed) runs.credentialsChanged(provider, false);
        runs.wake();
      } catch {
        return context.json({ error: "无法删除模型凭据，请检查控制面存储后重试。" }, 503);
      }
      context.header("Cache-Control", "no-store");
      return context.body(null, 204);
    })
    .post("/api/owner/agents", async (context) => {
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
        if (error instanceof AgentRequestConflict)
          return context.json({ error: error.message }, 409);
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
        if (error instanceof AgentRequestConflict)
          return context.json({ error: error.message }, 409);
        return context.json({ error: "无法保存 Agent 创建请求，请稍后重试。" }, 503);
      }
      if (!prepared.shouldProvision) return context.json({ agent: prepared.agent });

      const task = (async (): Promise<AgentSummary> => {
        try {
          const result = await nodes.operations.provisionAgent({
            nodeId: input.nodeId,
            requestId: prepared.requestId,
            agentId: input.id,
            onProgress: (stage) => agents.updateStage(input.id, stage),
          });
          if (!result.ok) return agents.fail(input.id, result.message) ?? prepared.agent;
          return agents.complete(input.id, result.identity, ownerChat);
        } catch (error) {
          const message =
            error instanceof AgentRequestConflict
              ? error.message
              : "节点暂时无法确认 Agent 的运行账号与默认工作区，请检查节点后按原请求重试。";
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
    })
    .post("/api/owner/agents/:agentId/direct-channel", (context) => {
      const channel = ownerChat.getOrCreateAgentDirectChannel(context.req.param("agentId"));
      if (!channel) return context.json({ error: "Agent 私信暂不可用。" }, 404);
      context.header("Cache-Control", "no-store");
      return context.json({ channel });
    });
}
