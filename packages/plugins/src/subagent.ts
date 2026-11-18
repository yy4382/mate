import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type AgentChange,
  type ConversationHandle,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Extension,
  type TaskId,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import type { AgentRuntime } from "@palace/runtime";

export type SubagentRole = Omit<AgentChange, "extensions"> & {
  readonly extensions?: readonly Extension[];
};

export type SubagentOptions = {
  /** Positive allowlist of extensions available to subagents. Cannot include `"subagent"`. */
  readonly extensions: readonly Extension[];
  /** Optional named role presets overriding model, thinking level, instructions, or extensions. */
  readonly roles?: Readonly<Record<string, SubagentRole>>;
};

type SubagentRecord = {
  readonly conversationId: ConversationId;
  readonly anchorTaskId: TaskId;
  readonly activeRunTaskId?: TaskId;
  readonly description?: string;
  readonly role?: string;
};

type SubagentRunInput = {
  readonly agentId: string;
  readonly childId: ConversationId;
  readonly prompt: string;
};

type SubagentRunResult = {
  readonly agentId: string;
  readonly reply: string;
  readonly ok: boolean;
};

const SubagentsDoc = defineDoc<{
  nextId: number;
  agents: Record<string, SubagentRecord>;
}>({
  kind: "palace.subagents",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ nextId: 1, agents: {} }),
});

/** Task-scoped state on a `subagent` tool call so crash recovery never spawns twice. */
const SubagentCallDoc = defineDoc<{
  agentId: string;
  runTaskId: TaskId<SubagentRunResult>;
  background: boolean;
}>({
  kind: "palace.subagent.call",
  version: 1,
  scope: "task",
  initial: () => ({ agentId: "", runTaskId: 0 as TaskId<SubagentRunResult>, background: false }),
});

/** Task-scoped cancellation mark written by `subagent_stop` before aborting the child conversation. */
const RunControlDoc = defineDoc<{ cancelled: boolean }>({
  kind: "palace.subagent.control",
  version: 1,
  scope: "task",
  initial: () => ({ cancelled: false }),
});

const AnchorTask = defineTask<null, { readonly phase: "done" }, null>({
  name: "palace.subagent.anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      ),
  },
  abort: (_anchor, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

function defineRunTask(options: { readonly name: string; readonly background: boolean }) {
  return defineTask<SubagentRunInput, { readonly phase: "run" }, SubagentRunResult>({
    name: options.name,
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const { agentId, childId, prompt } = task.input;
        const child = await runtime.conversation(childId, context);
        if (child === undefined) {
          await clearActiveAndCommit(runtime, agentId, context, {
            status: "terminal",
            outcome: {
              status: "failed",
              error: { message: `Subagent conversation ${childId} missing` },
            },
          });
          return;
        }
        const submission = await child.submit(
          {
            type: "input",
            content: prompt,
            requestId: `subagent:${runtime.taskId}`,
            whenBusy: "followUp",
          },
          context,
        );
        const settled = await submission.wait(context);
        if (await wasCancelled(runtime, context)) {
          await clearActiveAndCommit(runtime, agentId, context, {
            status: "terminal",
            outcome: { status: "aborted" },
          });
          return;
        }
        if (settled.status === "unanswered") {
          if (settled.reason === "aborted") {
            await clearActiveAndCommit(runtime, agentId, context, {
              status: "terminal",
              outcome: { status: "aborted" },
            });
            return;
          }
          const failure = `Subagent ${agentId} failed: ${settled.reason}`;
          if (options.background) {
            await reportToParent(runtime, agentId, "failed", failure, context);
          }
          await clearActiveAndCommit(runtime, agentId, context, {
            status: "terminal",
            outcome: {
              status: "completed",
              result: { agentId, reply: failure, ok: false },
            },
          });
          return;
        }

        await waitUntilChildSettled(child, childId, runtime, context);
        if (await wasCancelled(runtime, context)) {
          await clearActiveAndCommit(runtime, agentId, context, {
            status: "terminal",
            outcome: { status: "aborted" },
          });
          return;
        }

        const view = await runtime.context(childId, context);
        const reply = latestAssistantText(view.entries, settled.answer);
        if (options.background) {
          await reportToParent(runtime, agentId, "completed", reply, context);
        }
        await clearActiveAndCommit(runtime, agentId, context, {
          status: "terminal",
          outcome: { status: "completed", result: { agentId, reply, ok: true } },
        });
      },
    },
    abort: async (task, runtime, context) => {
      const child = await runtime.conversation(task.input.childId, context);
      await child?.abort(context, { background: true });
      await clearActiveAndCommit(runtime, task.input.agentId, context, {
        status: "terminal",
        outcome: { status: "aborted" },
      });
    },
  });
}

const SubagentForegroundTask = defineRunTask({
  name: "palace.subagent.foreground",
  background: false,
});

const SubagentRunTask = defineRunTask({
  name: "palace.subagent.background",
  background: true,
});

async function wasCancelled(
  runtime: TaskRuntime<SubagentRunInput, { readonly phase: "run" }, SubagentRunResult, object>,
  context: Context,
): Promise<boolean> {
  return (await runtime.snapshot(RunControlDoc, runtime.taskId, context))?.cancelled === true;
}

async function reportToParent(
  runtime: TaskRuntime<SubagentRunInput, { readonly phase: "run" }, SubagentRunResult, object>,
  agentId: string,
  status: "completed" | "failed",
  body: string,
  context: Context,
): Promise<void> {
  const parent = await runtime.conversation(runtime.conversationId, context);
  await parent?.submit(
    {
      type: "input",
      content: `<subagent_result agent_id="${agentId}" status="${status}">\n${body}\n</subagent_result>`,
      requestId: `subagent-result:${runtime.taskId}`,
      whenBusy: "steer",
    },
    context,
  );
}

async function clearActiveAndCommit(
  runtime: TaskRuntime<SubagentRunInput, { readonly phase: "run" }, SubagentRunResult, object>,
  agentId: string,
  context: Context,
  nextState:
    | {
        readonly status: "terminal";
        readonly outcome: { readonly status: "completed"; readonly result: SubagentRunResult };
      }
    | { readonly status: "terminal"; readonly outcome: { readonly status: "aborted" } }
    | {
        readonly status: "terminal";
        readonly outcome: {
          readonly status: "failed";
          readonly error: { readonly message: string };
        };
      },
): Promise<void> {
  await runtime.commit(async (tx) => {
    const doc = await tx.doc(SubagentsDoc, runtime.conversationId);
    const existing = doc.agents[agentId];
    if (existing !== undefined && existing.activeRunTaskId === runtime.taskId) {
      const { activeRunTaskId: _, ...rest } = existing;
      doc.agents[agentId] = rest;
    }
    return nextState;
  }, context);
}

/**
 * Wait until a subagent conversation's ordinary work AND any background tasks owned by that conversation (for example
 * `CommandWatchTask` armed by `notify_on_exit: true`) have finished and settled all triggered turns.
 */
async function waitUntilChildSettled(
  child: ConversationHandle,
  childId: ConversationId,
  runtime: TaskRuntime<SubagentRunInput, { readonly phase: "run" }, SubagentRunResult, object>,
  context: Context,
): Promise<void> {
  for (;;) {
    await child.waitForIdle(context);
    let liveTaskId: TaskId | undefined;
    await runtime.commit(async (tx) => {
      for (const status of ["pending", "running", "waiting", "completing"] as const) {
        const page = await tx.scanTasks({ conversationId: childId, status }, 1);
        if (page.items[0] !== undefined) {
          liveTaskId = page.items[0].id;
          return undefined;
        }
      }
      return undefined;
    }, context);
    if (liveTaskId === undefined) break;
    await runtime.waitForTask(liveTaskId, context);
  }
}

function latestAssistantText(
  entries: readonly EntryRecord[],
  minEntryId: EntryId | undefined,
): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined || (minEntryId !== undefined && entry.id < minEntryId)) continue;
    if (!AssistantEntry.is(entry)) continue;
    const message = entry.model?.[0];
    if (message?.role !== "assistant") continue;
    const text = message.content
      .filter((part) => part.type === "text" && part.text.length > 0)
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    if (text !== "") return text;
  }
  return "(no output)";
}

/** Names of all spawned subagents in the Agent's primary conversation. */
export async function listSubagents(runtime: AgentRuntime): Promise<string[]> {
  const doc = await runtime.snapshot(SubagentsDoc, runtime.rootConversationId);
  return doc === undefined ? [] : Object.keys(doc.agents);
}

/** Conversation ID of one spawned subagent in the Agent's primary conversation, if present. */
export async function subagentConversationId(
  runtime: AgentRuntime,
  agentId: string,
): Promise<ConversationId | undefined> {
  const doc = await runtime.snapshot(SubagentsDoc, runtime.rootConversationId);
  return doc?.agents[agentId]?.conversationId;
}

/**
 * Delegate work to isolated subagent conversations with a positive allowlist of capabilities. Supports foreground calls
 * (blocking until settled), background calls (`run_in_background: true`, reporting `<subagent_result>`), `resume`, and
 * `subagent_stop`.
 */
export function subagentExtension(options: SubagentOptions): Extension {
  assertAllowlistValid("subagent.extensions", options.extensions);
  const roles = options.roles ?? {};
  for (const [roleName, preset] of Object.entries(roles)) {
    if (roleName.trim() === "") throw new Error("subagent role name cannot be empty");
    if (preset.extensions !== undefined) {
      assertAllowlistValid(`subagent.roles.${roleName}.extensions`, preset.extensions);
    }
  }

  const subagentTool = defineTool({
    name: "subagent",
    description:
      "Spawn or resume an isolated subagent conversation to handle a delegated task. By default runs in the foreground " +
      "and returns the final result; set run_in_background: true to get agent_id back immediately and receive " +
      "<subagent_result> later when it finishes. Pass resume with a prior agent_id to continue that conversation.",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1 }),
      description: Type.Optional(Type.String()),
      run_in_background: Type.Optional(Type.Boolean()),
      resume: Type.Optional(Type.String({ minLength: 1 })),
      role: Type.Optional(Type.String({ minLength: 1 })),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const rolePreset = args.role === undefined ? undefined : roles[args.role];
      if (args.role !== undefined && rolePreset === undefined) {
        return {
          content: [{ type: "text", text: `Unknown subagent role: ${args.role}` }],
          isError: true,
        };
      }

      const dispatch = await api.commit(async (tx) => {
        const recorded = await tx.doc(SubagentCallDoc, api.taskId);
        if (recorded.agentId !== "") {
          return {
            ok: true as const,
            agentId: recorded.agentId,
            runTaskId: recorded.runTaskId,
            background: recorded.background,
          };
        }

        const doc = await tx.doc(SubagentsDoc, api.conversationId);
        let agentId: string;
        let record: SubagentRecord;

        if (args.resume !== undefined) {
          const existing = doc.agents[args.resume];
          if (existing === undefined) {
            return { ok: false as const, error: `Unknown subagent: ${args.resume}` };
          }
          if (existing.activeRunTaskId !== undefined) {
            return {
              ok: false as const,
              error: `Subagent ${args.resume} is already running; wait for it or stop it with subagent_stop`,
            };
          }
          agentId = args.resume;
          record = existing;
        } else {
          agentId = `sub-${doc.nextId}`;
          doc.nextId += 1;
          const anchorTaskId = await tx.createTask(AnchorTask, null, {
            ownership: { kind: "conversation" },
            background: true,
          });
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: anchorTaskId },
          });
          const parentAgent = await tx.doc(AgentDoc, api.conversationId);
          const allowed = rolePreset?.extensions ?? options.extensions;
          await configure(tx, child.id, {
            ...(parentAgent.model === undefined ? {} : { model: parentAgent.model }),
            ...(parentAgent.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: parentAgent.thinkingLevel }),
            ...(rolePreset ?? {}),
            extensions: [...allowed],
          });
          record = {
            conversationId: child.id,
            anchorTaskId,
            ...(args.description === undefined ? {} : { description: args.description }),
            ...(args.role === undefined ? {} : { role: args.role }),
          };
          doc.agents[agentId] = record;
        }

        const background = args.run_in_background === true;
        const runTaskId = background
          ? await tx.createTask(
              SubagentRunTask,
              { agentId, childId: record.conversationId, prompt: args.prompt },
              { ownership: { kind: "conversation" }, background: true },
            )
          : await tx.createTask(
              SubagentForegroundTask,
              { agentId, childId: record.conversationId, prompt: args.prompt },
              { ownership: { kind: "task", taskId: api.taskId } },
            );

        doc.agents[agentId] = {
          ...record,
          activeRunTaskId: runTaskId,
          ...(args.description === undefined ? {} : { description: args.description }),
        };
        recorded.agentId = agentId;
        recorded.runTaskId = runTaskId;
        recorded.background = background;
        return { ok: true as const, agentId, runTaskId, background };
      }, context);

      if (!dispatch.ok) {
        return { content: [{ type: "text", text: dispatch.error }], isError: true };
      }

      if (dispatch.background) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "running",
                agent_id: dispatch.agentId,
                ...(args.description === undefined ? {} : { description: args.description }),
              }),
            },
          ],
        };
      }

      const settled = await api.waitForTask(dispatch.runTaskId, context);
      const outcome = settled.state.outcome;
      if (outcome.status === "completed") {
        return {
          content: [
            { type: "text", text: `Subagent ${outcome.result.agentId}:\n${outcome.result.reply}` },
          ],
          isError: !outcome.result.ok,
        };
      }
      if (outcome.status === "aborted") {
        return {
          content: [{ type: "text", text: `Subagent ${dispatch.agentId} was stopped.` }],
          isError: true,
        };
      }
      const message =
        "error" in outcome && outcome.error !== undefined ? outcome.error.message : outcome.reason;
      return {
        content: [
          {
            type: "text",
            text: `Subagent ${dispatch.agentId} failed: ${message ?? "unknown error"}`,
          },
        ],
        isError: true,
      };
    },
  });

  const stopTool = defineTool({
    name: "subagent_stop",
    description: "Stop a currently running subagent cleanly without delivering a result.",
    parameters: Type.Object({
      agent_id: Type.String({ minLength: 1 }),
    }),
    replay: "safe",
    async execute({ agent_id }, api, context) {
      const action = await api.commit(async (tx) => {
        const doc = await tx.doc(SubagentsDoc, api.conversationId);
        const record = doc.agents[agent_id];
        if (record === undefined) return { kind: "missing" as const };
        if (record.activeRunTaskId === undefined) {
          return { kind: "idle" as const, conversationId: record.conversationId };
        }
        const control = await tx.doc(RunControlDoc, record.activeRunTaskId);
        control.cancelled = true;
        return {
          kind: "stopping" as const,
          conversationId: record.conversationId,
          runTaskId: record.activeRunTaskId,
        };
      }, context);

      if (action.kind === "missing") {
        return {
          content: [{ type: "text", text: `Unknown subagent: ${agent_id}` }],
          isError: true,
        };
      }
      const conversation = await api.conversation(action.conversationId, context);
      await conversation?.abort(context, { background: true });
      if (action.kind === "stopping") {
        await api.waitForTask(action.runTaskId, context);
        return { content: [{ type: "text", text: `Stopped subagent ${agent_id}.` }] };
      }
      return { content: [{ type: "text", text: `Subagent ${agent_id} is already idle.` }] };
    },
  });

  return defineExtension({
    name: "subagent",
    tools: [subagentTool, stopTool],
    tasks: [AnchorTask, SubagentForegroundTask, SubagentRunTask],
  });
}

function assertAllowlistValid(label: string, extensions: readonly Extension[]): void {
  const seen = new Set<string>();
  for (const extension of extensions) {
    if (extension.name === "subagent") {
      throw new Error(`${label} cannot include "subagent" (recursive subagents are not supported)`);
    }
    if (seen.has(extension.name)) {
      throw new Error(`duplicate extension in ${label}: ${extension.name}`);
    }
    seen.add(extension.name);
  }
}
