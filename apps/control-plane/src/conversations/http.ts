import { Hono } from "hono";
import { z } from "zod";
import type { AgentDirectory } from "../agents/directory.js";
import type { OwnerAuth } from "../auth/service.js";
import { sessionToken } from "../auth/session-cookie.js";
import type { AgentRunCoordinator } from "../runtime/runs/coordinator.js";
import {
  newChannelSchema,
  newMessageSchema,
  ownerChannelInvitationSchema,
  updateChannelSchema,
} from "./contracts.js";
import { ArchivedChannelError } from "./errors.js";
import type { OwnerChat } from "./service.js";

/** One delayed database poll per open owner event stream, in milliseconds. */
const eventPollIntervalMs = 250;

export function createConversationRoutes({
  ownerAuth,
  ownerChat,
  agents,
  runs,
}: {
  ownerAuth: Pick<OwnerAuth, "hasSession">;
  ownerChat: OwnerChat;
  agents: AgentDirectory;
  runs: AgentRunCoordinator;
}) {
  return new Hono()
    .get("/api/owner/snapshot", (context) => context.json(ownerChat.snapshot()))
    .get("/api/owner/events", (context) => {
      const streamToken = sessionToken(context);
      const suppliedCursor =
        context.req.header("last-event-id") ?? context.req.query("cursor") ?? "0";
      if (!/^(0|[1-9]\d*)$/.test(suppliedCursor))
        return context.json({ error: "事件游标无效" }, 400);
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
              await new Promise((resolveDelay) => setTimeout(resolveDelay, eventPollIntervalMs));
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
    })
    .get("/api/owner/channels", (context) => context.json({ channels: ownerChat.listChannels() }))
    .get("/api/owner/invitable-channels", (context) =>
      context.json({ channels: ownerChat.listInvitableChannels() }),
    )
    .post("/api/owner/channels", async (context) => {
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json({ error: "频道资料格式无效" }, 400);
      }
      const input = newChannelSchema.safeParse(body);
      if (!input.success) return context.json({ error: "频道资料格式无效" }, 400);
      return context.json(ownerChat.createChannel(input.data), 201);
    })
    .patch("/api/owner/channels/:channelId", async (context) => {
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json({ error: "频道资料格式无效" }, 400);
      }
      const input = updateChannelSchema.safeParse(body);
      if (!input.success) return context.json({ error: "频道资料格式无效" }, 400);
      try {
        const channel = ownerChat.updateChannel(context.req.param("channelId"), input.data);
        if (!channel) return context.json({ error: "频道不存在" }, 404);
        return context.json(channel);
      } catch (error) {
        if (error instanceof Error && error.message === "A direct message cannot be made public")
          return context.json({ error: "私信不能改为公开" }, 400);
        throw error;
      }
    })
    .post("/api/owner/channels/:channelId/invitations", async (context) => {
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
      runs.wake();
      return context.json({ channelId, agentId: input.data.agentId, status: "joined" }, 201);
    })
    .get("/api/owner/channels/:channelId/messages", (context) => {
      const beforeText = context.req.query("before"),
        before = beforeText === undefined ? undefined : Number(beforeText),
        validBefore =
          beforeText === undefined ||
          (/^[1-9]\d*$/.test(beforeText) && Number.isSafeInteger(before)),
        limitText = context.req.query("limit"),
        limit = limitText === undefined ? 50 : Number(limitText);
      if (!validBefore || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return context.json({ error: "历史游标或条数无效" }, 400);
      const page = ownerChat.listMessages(context.req.param("channelId"), before, limit);
      if (!page) return context.json({ error: "频道不存在" }, 404);
      return context.json(page);
    })
    .get("/api/owner/channels/:channelId/messages/:messageId/context", (context) => {
      const result = ownerChat.messageContext(
        context.req.param("channelId"),
        context.req.param("messageId"),
      );
      if (!result) return context.json({ error: "消息不存在" }, 404);
      return context.json(result);
    })
    .get("/api/owner/channels/:channelId/threads/:rootId", (context) => {
      const thread = ownerChat.listThread(
        context.req.param("channelId"),
        context.req.param("rootId"),
      );
      if (!thread) return context.json({ error: "讨论串不存在" }, 404);
      return context.json(thread);
    })
    .get("/api/owner/tasks", (context) => context.json({ tasks: ownerChat.listTasks() }))
    .get("/api/owner/agents/:agentId/reminders", (context) => {
      const agent = agents.list().find((item) => item.id === context.req.param("agentId"));
      if (!agent) return context.json({ error: "Agent 不存在" }, 404);
      ownerChat.syncHandledReminders();
      return context.json({ reminders: ownerChat.listAgentReminders(agent.id) });
    })
    .get("/api/owner/tasks/:taskId/activity", (context) => {
      const task = ownerChat.readTask(context.req.param("taskId"));
      if (!task) return context.json({ error: "任务不存在" }, 404);
      return context.json({ task, events: ownerChat.taskActivity(task.id) });
    })
    .post("/api/owner/tasks", async (context) => {
      const parsed = z
        .object({ messageId: z.string().uuid(), title: z.string().trim().min(1).max(200) })
        .strict()
        .safeParse(await context.req.json().catch(() => null));
      if (!parsed.success)
        return context.json({ error: "请提供消息 ID 和 1 至 200 字符的任务标题" }, 400);
      try {
        return context.json(
          ownerChat.createTaskForMessage(
            parsed.data.messageId,
            "human",
            "owner",
            parsed.data.title,
          ),
          201,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "Message is not available")
          return context.json({ error: "消息不存在" }, 404);
        throw error;
      }
    })
    .post("/api/owner/channels/:channelId/messages", async (context) => {
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
        runs.wake();
        return context.json(message, 201);
      } catch (error) {
        if (error instanceof ArchivedChannelError)
          return context.json({ error: "频道已归档，不能发送消息" }, 409);
        if (error instanceof Error && error.message.startsWith("Reply target"))
          return context.json({ error: "回复目标无效" }, 400);
        throw error;
      }
    });
}
