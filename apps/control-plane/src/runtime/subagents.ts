import { randomUUID } from "node:crypto";
import {
  GenerationTask,
  LiveDoc,
  defineDoc,
  defineTask,
  type ConversationId,
  type TaskId,
  type ToolExecutionApi,
  type Harness,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { z } from "zod";

export const subagentTools = {
  spawn_agent: {
    description:
      "启动命名工作助手并立即返回。助手共享你的节点、工作区和业务身份，普通正文仅回报直接委派者。默认继承已确认上下文；none仅传新任务。",
    schema: z
      .object({
        task_name: z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/)
          .max(64),
        message: z.string().min(1),
        fork_turns: z.enum(["all", "none"]).default("all"),
      })
      .strict(),
  },
  list_agents: {
    description: "列出同属一个Mate Agent的工作助手身份、任务路径及原生工作状态。",
    schema: z.object({}).strict(),
  },
};

type AssistantIdentity = {
  handle: string;
  id: ConversationId;
  parent: ConversationId;
  path: string;
  spawnTask: TaskId;
  workTask: TaskId;
};
/** Only identity/ownership/idempotency. Work and notification state belong to native tasks and submissions. */
export const assistantsDoc = defineDoc({
  kind: "mate.assistants",
  version: 1,
  scope: "session",
  initial: (): { assistants: AssistantIdentity[] } => ({ assistants: [] }),
});

export function createAssistantWork(ready: () => Promise<void>) {
  return defineTask<
    { spawnTask: TaskId; requestId?: string; message: string },
    { phase: "work" },
    null
  >({
    name: "mate.assistant-work",
    version: 1,
    initial: () => ({ phase: "work" }),
    phases: {
      work: async (task, runtime, context) => {
        await ready();
        const identity = (await runtime.snapshot(assistantsDoc, context))?.assistants.find(
          (item) => item.spawnTask === task.input.spawnTask,
        );
        if (!identity) throw new Error("Assistant identity missing");
        const child = await runtime.conversation(identity.id, context);
        const parent = await runtime.conversation(identity.parent, context);
        if (!child || !parent) throw new Error("Assistant conversation missing");
        let submission = await child.submit(
          {
            type: "input",
            requestId: task.input.requestId ?? `spawn:${identity.spawnTask}`,
            content: `[工作助手 ${identity.path}；身份 ${identity.handle}；所属Mate Agent的业务身份与节点环境保持共用。普通正文仅回报直接委派者。]\n${task.input.message}`,
            whenBusy: "steer",
          },
          context,
        );
        let settled = await submission.wait(context);
        let inputPresented = settled.entry !== undefined;
        // The persistent owner, not an in-memory admission list, decides continuation.
        // A deliberate interruption aborts this owner too; admission reconciliation only
        // aborts conversation work, so its owner survives even a crash after the abort.
        while (settled.status === "unanswered" && settled.reason === "aborted") {
          submission = await child.submit(
            {
              type: "input",
              requestId: `resume:${submission.id}`,
              content: !inputPresented
                ? `[工作助手 ${identity.path}；身份 ${identity.handle}]\n${task.input.message}`
                : "[恢复提示] 请依据已确认上下文和恢复事实继续未完成的工作。",
              whenBusy: "steer",
            },
            context,
          );
          settled = await submission.wait(context);
          inputPresented ||= settled.entry !== undefined;
        }
        const history = await runtime.context(
          identity.id,
          context,
          settled.answer !== undefined ? { at: settled.answer } : {},
        );
        const final =
          settled.status === "done"
            ? history.entries.find((entry) => entry.id === settled.answer)?.model
            : undefined;
        const output = final
          ?.flatMap((message) =>
            typeof message.content === "string"
              ? [message.content]
              : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
          )
          .join("\n");
        const reportText = `[助手完成回报] ${JSON.stringify({ id: identity.handle, path: identity.path, submissionId: submission.id, status: settled.status === "done" ? "completed" : "failed", output: output ?? settled.detail ?? settled.reason ?? "" })}`;
        let report = await parent.submit(
          {
            type: "input",
            requestId: `assistant-report:${identity.id}:${settled.status === "done" ? settled.answer : submission.id}`,
            content: reportText,
            whenBusy: "followUp",
          },
          context,
        );
        let reported = await report.wait(context);
        let reportPresented = reported.entry !== undefined;
        while (reported.status === "unanswered" && reported.reason === "aborted") {
          report = await parent.submit(
            {
              type: "input",
              requestId: `assistant-report:after:${report.id}`,
              content: !reportPresented
                ? reportText
                : "[恢复提示] 请继续处理会话中已呈现的助手回报。",
              whenBusy: "followUp",
            },
            context,
          );
          reported = await report.wait(context);
          reportPresented ||= reported.entry !== undefined;
        }
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          context,
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
}

export async function callAssistantTool(
  name: string,
  input: unknown,
  api: ToolExecutionApi,
  context: Context,
  assistantWork: ReturnType<typeof createAssistantWork>,
) {
  if (name === "spawn_agent") {
    const args = subagentTools.spawn_agent.schema.parse(input);
    return api.commit(async (tx) => {
      const identities = await tx.doc(assistantsDoc);
      const existing = identities.assistants.find((item) => item.spawnTask === api.taskId);
      if (existing) return { id: existing.handle, path: existing.path };
      const parent = identities.assistants.find((item) => item.id === api.conversationId);
      const path = `${parent?.path ?? "/root"}/${args.task_name}`;
      if (identities.assistants.some((item) => item.path === path))
        throw new Error("Assistant task name already exists");
      // A generation's call-bearing assistant entry is confirmed, but its tool results are not.
      // Fork before that entry to keep the inherited transcript complete.
      let cursor;
      let callEntry;
      let cutoff;
      do {
        const page = await tx.scanEntries({ conversationId: api.conversationId }, 100, cursor);
        for (const entry of page.items) {
          if (callEntry) {
            cutoff = entry.id;
            break;
          }
          if (
            entry.model?.some(
              (message) =>
                message.role === "assistant" &&
                message.content.some(
                  (block) => block.type === "toolCall" && block.id === api.callId,
                ),
            )
          )
            callEntry = entry.id;
        }
        cursor = page.next;
      } while (cursor && cutoff === undefined);
      const workTask = await tx.createTask(
        assistantWork,
        { spawnTask: api.taskId, message: args.message },
        { ownership: { kind: "conversation" }, background: true },
      );
      const ownership = { kind: "task" as const, taskId: workTask };
      const child =
        args.fork_turns === "all" && cutoff !== undefined
          ? await tx.forkConversation(api.conversationId, cutoff, { ownership })
          : await tx.createConversation({ ownership });
      const handle = randomUUID();
      identities.assistants.push({
        handle,
        id: child.id,
        parent: api.conversationId,
        path,
        spawnTask: api.taskId,
        workTask,
      });
      return { id: handle, path };
    }, context);
  }
  subagentTools.list_agents.schema.parse(input);
  const identities = (await api.snapshot(assistantsDoc, context))?.assistants ?? [];
  return {
    agents: await Promise.all(
      identities.map(async (item) => {
        const live = await api.snapshot(LiveDoc, item.id, context);
        const latest = await api.commit(
          async (tx) =>
            (
              await tx.scanTasks(
                {
                  kind: GenerationTask.definition.name,
                  conversationId: item.id,
                  order: "descending",
                },
                1,
              )
            ).items[0],
          context,
        );
        return {
          id: item.handle,
          path: item.path,
          status:
            live?.run || !latest || latest.state.status !== "terminal"
              ? "running"
              : latest.state.outcome.status === "completed"
                ? "completed"
                : "failed",
        };
      }),
    ),
  };
}

/** Background owners keep the single Harness admitted; native waits never block root input delivery. */
export async function waitForAssistants(harness: Harness, context: Context) {
  for (;;) {
    const graph = await harness.inspect(context);
    const work = graph.tasks.filter((task) => task.record.kind === "mate.assistant-work");
    if (!work.length) return;
    await Promise.all(work.map((task) => harness.waitForTask(task.record.id, context)));
  }
}
