import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  GenerationTask,
  AgentDoc,
  ToolTask,
  LiveDoc,
  InboxDoc,
  UserEntry,
  ROOT_CONVERSATION_ID,
  defineDoc,
  defineTask,
  type ConversationId,
  type TaskId,
  type ToolExecutionApi,
  type Harness,
  type Storage,
  type SubmissionRecord,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { copyJson, type Context } from "@earendil-works/chord";
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
  send_message: {
    description:
      "向同属Agent的根或助手持久递送普通消息；忙中在安全点呈现，空闲只排队。target可为稳定身份、相对路径或/root绝对路径。",
    schema: z.object({ target: z.string().min(1), message: z.string().min(1) }).strict(),
  },
  followup_task: {
    description: "向助手追加工作；空闲时唤醒，忙中追加输入；不能指定/root。结果仍回报最初委派者。",
    schema: z.object({ target: z.string().min(1), message: z.string().min(1) }).strict(),
  },
  interrupt_agent: {
    description:
      "停止助手当前工作，保留身份和上下文，后代继续独立工作；不能指定/root。已执行节点效果不会撤销。",
    schema: z.object({ target: z.string().min(1) }).strict(),
  },
  wait_agent: {
    description:
      "等待同属Agent的输入或完成变化；已有未呈现通知立即返回，旧已呈现结果不会重复唤醒。",
    schema: z.object({ timeout_ms: z.number().int().min(1).max(3600000).default(30000) }).strict(),
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

export function createAssistantWork(ready: () => Promise<{ storage: Storage }>) {
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
        const { storage } = await ready();
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
        const submissions: SubmissionRecord[] = [];
        let cursor;
        do {
          const page = await storage.scanSubmissions(
            { conversationId: identity.id },
            100,
            cursor,
            context,
          );
          submissions.push(...page.items);
          cursor = page.next;
        } while (cursor);
        // Admission and post-tools handover place inputs before minting the next
        // generation. Its ordered native ID therefore also binds failures without
        // an assistant entry (including faulted/orphaned outcomes) to their inputs.
        const failures: TaskId[] = [];
        if (settled.status !== "done") {
          let cursor;
          do {
            const page = await storage.scanTasks(
              {
                conversationId: identity.id,
                kind: GenerationTask.definition.name,
                status: "terminal",
              },
              100,
              cursor,
              context,
            );
            for (const task of page.items) {
              if (
                task.state.status === "terminal" &&
                task.state.outcome.status !== "completed" &&
                task.state.outcome.status !== "aborted"
              )
                failures.push(task.id);
            }
            cursor = page.next;
          } while (cursor);
        }
        const failureFor = (item: SubmissionRecord) => {
          const entry = item.entry;
          return entry === undefined ? undefined : failures.find((id) => id > entry);
        };
        const failure = failureFor(settled);
        const related = submissions.filter((item) =>
          settled.answer !== undefined
            ? item.answer === settled.answer
            : failure !== undefined
              ? item.status === "unanswered" &&
                item.reason === settled.reason &&
                failureFor(item) === failure
              : item.id === settled.id,
        );
        const completion = settled.answer ?? failure ?? submission.id;
        const reportText = `[助手完成回报] ${JSON.stringify({ id: identity.handle, path: identity.path, submissionIds: related.map((item) => item.id), status: settled.status === "done" ? "completed" : "failed", output: output ?? settled.detail ?? settled.reason ?? "" })}`;
        let report = await parent.submit(
          {
            type: "input",
            requestId: `assistant-report:${identity.id}:${completion}`,
            content: reportText,
            whenBusy: "steer",
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
              whenBusy: "steer",
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

type InterruptedWork = {
  conversationId: ConversationId;
  owners: { taskId: TaskId; requestId: string }[];
  inputs: SubmissionId[];
};

export function createAssistantInterrupt(
  ready: () => Promise<{ harness: Harness; storage: Storage }>,
  recoverTools: (taskIds: string[]) => Promise<void>,
) {
  return defineTask<{ requestId: string; work: InterruptedWork }, { phase: "stop" }, null>({
    name: "mate.assistant-interrupt",
    version: 1,
    initial: () => ({ phase: "stop" }),
    phases: {
      stop: async (task, runtime, context) => {
        const { harness, storage } = await ready();
        const { work } = task.input;
        // Stop input owners first so an intentional abort cannot create recovery input.
        for (const owner of work.owners) await harness.abortTask(owner.taskId, context);
        for (const owner of work.owners) await runtime.waitForTask(owner.taskId, context);
        const inputs = new Set(work.inputs);
        for (const owner of work.owners) {
          let requestId = owner.requestId;
          for (;;) {
            const submission = await storage.submissionByRequest(
              work.conversationId,
              requestId,
              context,
            );
            if (!submission) break;
            inputs.add(submission.id);
            if (submission.status !== "unanswered" || submission.reason !== "aborted") break;
            requestId = `resume:${submission.id}`;
          }
        }
        for (const id of inputs) await harness.abortSubmission(id, context, work.conversationId);
        // Native generation IDs change after a tool round; the run's input identities do not.
        // Retry the native abort when handover won the race, without touching later independent work.
        for (;;) {
          const live = await runtime.snapshot(LiveDoc, work.conversationId, context);
          if (!live?.run?.inputs.some((id) => inputs.has(id))) break;
          await harness.abortTask(live.run.taskId, context);
          await runtime.waitForTask(live.run.taskId, context);
        }
        // A tool can finish its domain operation just as native cancellation wins its
        // result commit. Recover from the operation ledger after native termination too.
        const tools: string[] = [];
        let cursor;
        do {
          const page = await storage.scanTasks(
            {
              conversationId: work.conversationId,
              kind: ToolTask.definition.name,
              status: "terminal",
            },
            100,
            cursor,
            context,
          );
          for (const tool of page.items)
            if (tool.state.status === "terminal" && tool.state.outcome.status === "aborted")
              tools.push(String(tool.id));
          cursor = page.next;
        } while (cursor);
        await recoverTools(tools);
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
  harness: Harness,
  assistantInterrupt: ReturnType<typeof createAssistantInterrupt>,
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
      // The persistent work task owns input/recovery/reporting, not the reusable
      // conversation lifetime: aborting an old owner must not cascade into later work.
      const ownership = { kind: "ownerless" as const };
      const child =
        args.fork_turns === "all" && cutoff !== undefined
          ? await tx.forkConversation(api.conversationId, cutoff, { ownership })
          : await tx.createConversation({ ownership });
      if (args.fork_turns !== "all" || cutoff === undefined)
        Object.assign(
          await tx.doc(AgentDoc, child.id),
          copyJson(await tx.doc(AgentDoc, api.conversationId)),
        );
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
  if (name === "wait_agent") {
    const { timeout_ms } = subagentTools.wait_agent.schema.parse(input);
    const until = await api.memo("wait-until", Date.now() + timeout_ms, context);
    const changed = Promise.withResolvers<string>();
    const unsubscribe = harness.subscribeCommits((publication) => {
      if (publication.changes.some((change) => change.type === "submission"))
        changed.resolve("changed");
    });
    const cancel = () => changed.resolve("cancelled");
    context.abortSignal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => changed.resolve("timeout"), Math.max(0, until - Date.now()));
    try {
      context.abortSignal?.throwIfAborted();
      const inbox = await api.snapshot(InboxDoc, api.conversationId, context);
      const reason = inbox?.items.length ? "pending" : await changed.promise;
      context.abortSignal?.throwIfAborted();
      return { reason };
    } finally {
      clearTimeout(timer);
      unsubscribe();
      context.abortSignal?.removeEventListener("abort", cancel);
    }
  }
  if (name === "send_message" || name === "followup_task" || name === "interrupt_agent") {
    const args = subagentTools[name].schema.parse(input);
    const identities = (await api.snapshot(assistantsDoc, context))?.assistants ?? [];
    const caller = identities.find((item) => item.id === api.conversationId);
    const path = args.target.startsWith("/")
      ? args.target
      : `${caller?.path ?? "/root"}/${args.target}`;
    const normalized = posix.normalize(path).replace(/\/$/, "");
    const target = identities.find(
      (item) => item.handle === args.target || item.path === normalized,
    );
    const root = args.target === "root" || normalized === "/root";
    if (!target && !root) throw new Error("Unknown assistant target in this Mate Agent");
    const id = target?.id ?? ROOT_CONVERSATION_ID;
    if (name === "send_message") {
      const { message } = subagentTools.send_message.schema.parse(input);
      return api.commit(async (tx) => {
        const requestId = `assistant-message:${api.taskId}`;
        const existing = await tx.submissionByRequest(id, requestId);
        if (!existing) {
          const inbox = await tx.doc(InboxDoc, id);
          const live = await tx.doc(LiveDoc, id);
          const submission = await tx.createSubmission({
            conversationId: id,
            requestId,
            type: "write",
            status: "queued",
          });
          inbox.items.push({
            id: submission.id,
            mode: "write",
            entry: {
              kind: UserEntry.kind,
              model: [
                {
                  role: "user",
                  content: `[同伴消息 ${caller?.path ?? "/root"}] ${message}`,
                  timestamp: Date.now(),
                },
              ],
            },
          });
          // Passive message content survives admission aborts. Only a currently busy
          // conversation receives a native steer to keep its run processing that content.
          if (live.run) {
            const steer = await tx.createSubmission({
              conversationId: id,
              requestId: `${requestId}:steer`,
              type: "input",
              status: "queued",
            });
            inbox.items.push({
              id: steer.id,
              mode: "steer",
              content: "[同伴消息提示] 请处理刚刚呈现的同伴消息。",
            });
            if (target)
              await tx.createTask(
                assistantWork,
                {
                  spawnTask: target.spawnTask,
                  requestId: `${requestId}:steer`,
                  message: "请处理已排队的同伴消息。",
                },
                { ownership: { kind: "conversation" }, background: true },
              );
          }
        }
        return { id: target?.handle ?? "root", status: "queued" };
      }, context);
    }
    if (!target) throw new Error(`${name} cannot target root`);
    if (name === "followup_task") {
      const { message } = subagentTools.followup_task.schema.parse(input);
      await api.commit(async (tx) => {
        const requestId = `followup:${api.taskId}`;
        let cursor;
        do {
          const page = await tx.scanTasks(
            { kind: "mate.assistant-work", conversationId: api.conversationId },
            100,
            cursor,
          );
          if (
            page.items.some(
              (task) =>
                typeof task.input === "object" &&
                task.input !== null &&
                !Array.isArray(task.input) &&
                task.input.requestId === requestId,
            )
          )
            return;
          cursor = page.next;
        } while (cursor);
        await tx.createTask(
          assistantWork,
          { spawnTask: target.spawnTask, requestId, message },
          { ownership: { kind: "conversation" }, background: true },
        );
      }, context);
      return { id: target.handle, path: target.path, status: "queued" };
    }
    // Capture once before effects: replay cannot interrupt a later followup run.
    const captured =
      (await api.memo<InterruptedWork>("interrupt-targets", context)) ??
      (await api.commit(async (tx) => {
        const owners: InterruptedWork["owners"] = [];
        const live = await tx.doc(LiveDoc, target.id);
        let cursor;
        do {
          const page = await tx.scanTasks({ kind: "mate.assistant-work" }, 100, cursor);
          for (const task of page.items) {
            const owner = z
              .object({ spawnTask: z.number(), requestId: z.string().optional() })
              .safeParse(task.input);
            if (
              task.state.status === "terminal" ||
              !owner.success ||
              owner.data.spawnTask !== target.spawnTask
            )
              continue;
            let submission = await tx.submissionByRequest(
              target.id,
              owner.data.requestId ?? `spawn:${target.spawnTask}`,
            );
            while (submission?.status === "unanswered" && submission.reason === "aborted") {
              const successor = await tx.submissionByRequest(target.id, `resume:${submission.id}`);
              if (!successor) break;
              submission = successor;
            }
            if (
              !submission ||
              submission.status === "queued" ||
              submission.status === "placed" ||
              submission.reason === "aborted"
            )
              owners.push({
                taskId: task.id,
                requestId: owner.data.requestId ?? `spawn:${target.spawnTask}`,
              });
          }
          cursor = page.next;
        } while (cursor);
        return { conversationId: target.id, owners, inputs: [...(live.run?.inputs ?? [])] };
      }, context));
    const targets = await api.memo("interrupt-targets", captured, context);
    const interrupt = await api.commit(async (tx) => {
      const requestId = `interrupt:${api.taskId}`;
      let cursor;
      do {
        const page = await tx.scanTasks(
          { kind: "mate.assistant-interrupt", conversationId: api.conversationId },
          100,
          cursor,
        );
        const existing = page.items.find(
          (task) => z.object({ requestId: z.literal(requestId) }).safeParse(task.input).success,
        );
        if (existing) return existing.id;
        cursor = page.next;
      } while (cursor);
      return tx.createTask(
        assistantInterrupt,
        { requestId, work: targets },
        { ownership: { kind: "conversation" }, background: true },
      );
    }, context);
    await api.waitForTask(interrupt, context);
    return { id: target.handle, path: target.path, status: "interrupted" };
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
    const work = graph.tasks.filter(
      (task) =>
        task.record.kind === "mate.assistant-work" ||
        task.record.kind === "mate.assistant-interrupt",
    );
    if (!work.length) return;
    await Promise.all(work.map((task) => harness.waitForTask(task.record.id, context)));
  }
}

/** A receipt wakes its original assistant, keeping the original spawn parent as reporter. */
export async function wakeAssistantForRecovery(
  harness: Harness,
  assistantWork: ReturnType<typeof createAssistantWork>,
  conversationId: ConversationId,
  factId: string,
  context: Context,
) {
  const root = await harness.root(context);
  if (conversationId === root.id) return;
  await root.commit(async (tx) => {
    const identity = (await tx.doc(assistantsDoc)).assistants.find(
      (item) => item.id === conversationId,
    );
    if (!identity) throw new Error("Recovery assistant missing");
    const requestId = `recovery-wake:${factId}`;
    let cursor;
    do {
      const page = await tx.scanTasks(
        { kind: assistantWork.definition.name, conversationId: identity.parent },
        100,
        cursor,
      );
      if (
        page.items.some(
          (task) => z.object({ requestId: z.literal(requestId) }).safeParse(task.input).success,
        )
      )
        return;
      cursor = page.next;
    } while (cursor);
    await tx.createTask(
      assistantWork,
      {
        spawnTask: identity.spawnTask,
        requestId,
        message: "[恢复提示] 新的操作收据事实已写入本会话，请据此决定检查、补救或继续。",
      },
      { ownership: { kind: "conversation" }, conversationId: identity.parent, background: true },
    );
  }, context);
}
